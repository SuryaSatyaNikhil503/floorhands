// Pure helpers for the undo-the-fix benchmark (scripts/bench.mjs). Nothing here touches the network, git or the claude CLI.
//
// An instance is a real fix commit from an open-source project: we check out the fix, put the fixed source files back to their state
// before the fix, and hide the tests the fix added. The hidden tests are the grader: they fail on the buggy code and pass on the
// upstream fix, so "did the agent fix it" is decided by the project's own maintainers' tests, not by us or by a model.

export const VARIANTS = Object.freeze(['floorhands', 'single']);
export const TASKS = Object.freeze(['review', 'build']);

const SHA = /^[0-9a-f]{40}$/;
const REPO = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/;
const ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const GHSA = /^GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}$/;
const REL = p => typeof p === 'string' && p.length > 0 && p.length < 300 && !p.startsWith('/') && !p.split('/').includes('..') && !p.startsWith('-');
// The test command runs third-party code: only the package manager's own test entry points, as argv, never a shell string.
const TEST_COMMANDS = [['npm', 'test'], ['npm', 'run', 'test'], ['npx', 'vitest', 'run'], ['npx', 'jest'], ['npx', 'mocha'], ['node', '--test']];

export function instanceProblems(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return ['an instance must be an object'];
  const p = [];
  if (!ID.test(String(x.id ?? ''))) p.push('id must be a lowercase slug (3-64 characters)');
  if (!REPO.test(String(x.repo ?? ''))) p.push('repo must be an https://github.com/<owner>/<name> URL');
  if (!SHA.test(String(x.fixCommit ?? ''))) p.push('fixCommit must be a full 40-character commit sha');
  if (x.advisory !== undefined && !GHSA.test(String(x.advisory))) p.push('advisory must be a GHSA id such as GHSA-xxxx-xxxx-xxxx');
  if (x.published !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(x.published))) p.push('published must be a YYYY-MM-DD date');
  if (!Array.isArray(x.sourceFiles) || !x.sourceFiles.length || !x.sourceFiles.every(REL)) p.push('sourceFiles must list the fixed source files (relative paths)');
  if (!Array.isArray(x.testFiles) || !x.testFiles.length || !x.testFiles.every(REL)) p.push('testFiles must list the test files the fix added or changed (relative paths)');
  if (Array.isArray(x.sourceFiles) && Array.isArray(x.testFiles) && x.sourceFiles.some(f => x.testFiles.includes(f))) p.push('a file cannot be both source and test');
  if (!Array.isArray(x.testCommand) || !TEST_COMMANDS.some(c => c.length <= x.testCommand.length && c.every((w, i) => x.testCommand[i] === w))) {
    p.push(`testCommand must start with one of: ${TEST_COMMANDS.map(c => c.join(' ')).join(' | ')}`);
  } else if (!x.testCommand.every(w => typeof w === 'string' && w.length < 200 && !/[;&|`$<>\n]/.test(w))) p.push('testCommand words must be plain arguments');
  if (!x.tasks || typeof x.tasks.review !== 'string' || typeof x.tasks.build !== 'string' || !x.tasks.review.trim() || !x.tasks.build.trim()) {
    p.push('tasks.review and tasks.build must be the task texts (the build text describes the bug as an issue would, without the fix)');
  }
  if (typeof x.bug !== 'string' || !x.bug.trim()) p.push('bug must describe the bug for the review judge (never shown to the agents)');
  return p;
}

export function validateCorpus(doc) {
  const list = Array.isArray(doc?.instances) ? doc.instances : null;
  if (!list) return ['the corpus needs an "instances" list'];
  const problems = [];
  const ids = new Set();
  list.forEach((x, i) => {
    for (const p of instanceProblems(x)) problems.push(`instance ${x?.id ?? i}: ${p}`);
    if (ids.has(x?.id)) problems.push(`duplicate id ${x.id}`);
    ids.add(x?.id);
  });
  if (doc.holdout !== undefined && (!Array.isArray(doc.holdout) || !doc.holdout.every(id => ids.has(id)))) problems.push('holdout must list ids of instances in the corpus');
  return problems;
}

// Deterministic PRNG so a report can be re-computed bit for bit from the stored results.
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mean = xs => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);

// Mean of a per-run score with a 95% percentile bootstrap interval that resamples INSTANCES, not runs: five runs of one instance
// are not five independent data points, and treating them as such makes the interval far too narrow.
// `byInstance` is { instanceId: [score per run, ...] }, scores in [0, 1] (or any number).
export function bootstrapCI(byInstance, { iters = 5000, seed = 1, level = 0.95 } = {}) {
  const groups = Object.values(byInstance).filter(g => Array.isArray(g) && g.length);
  if (!groups.length) return { mean: NaN, lo: NaN, hi: NaN, instances: 0, runs: 0 };
  const instMeans = groups.map(mean);
  const point = mean(instMeans);
  const r = rng(seed);
  const stats = [];
  for (let i = 0; i < iters; i++) {
    let s = 0;
    for (let j = 0; j < instMeans.length; j++) s += instMeans[Math.floor(r() * instMeans.length)];
    stats.push(s / instMeans.length);
  }
  stats.sort((a, b) => a - b);
  const tail = (1 - level) / 2;
  const at = q => stats[Math.min(stats.length - 1, Math.max(0, Math.floor(q * stats.length)))];
  return { mean: point, lo: at(tail), hi: at(1 - tail), instances: groups.length, runs: groups.reduce((n, g) => n + g.length, 0) };
}

// Paired difference (variant A minus variant B) per instance, bootstrapped the same way: answers "does floorhands beat one agent".
export function pairedDiffCI(a, b, opts) {
  const diffs = {};
  for (const id of Object.keys(a)) if (Array.isArray(b[id]) && b[id].length && a[id].length) diffs[id] = [mean(a[id]) - mean(b[id])];
  return bootstrapCI(diffs, opts);
}

// Agreement between the model judge and a person on the same findings, corrected for chance. Below about 0.6 the judge's precision
// numbers are not trustworthy and the report says so.
export function cohenKappa(pairs) {
  const items = pairs.filter(p => typeof p?.judge === 'boolean' && typeof p?.human === 'boolean');
  if (!items.length) return NaN;
  const n = items.length;
  const agree = items.filter(p => p.judge === p.human).length / n;
  const pj = items.filter(p => p.judge).length / n;
  const ph = items.filter(p => p.human).length / n;
  const chance = pj * ph + (1 - pj) * (1 - ph);
  return chance === 1 ? 1 : (agree - chance) / (1 - chance);
}

// Blinding: the judge sees findings without knowing which variant wrote them, in a shuffled order. The key maps back afterwards.
export function blind(reports, seed = 1) {
  const r = rng(seed);
  const items = reports.map((rep, i) => ({ i, rep }));
  for (let k = items.length - 1; k > 0; k--) {
    const j = Math.floor(r() * (k + 1));
    [items[k], items[j]] = [items[j], items[k]];
  }
  const key = {};
  const out = items.map(({ i, rep }, n) => {
    const blindId = `r${String(n + 1).padStart(3, '0')}`;
    key[blindId] = i;
    return { blindId, instance: rep.instance, findings: rep.findings };
  });
  return { items: out, key };
}

// Findings from a reviewer report in the shared format: lines starting with a severity tag, e.g. "[High] src/a.js:12 — SQL injection".
const FINDING = /^\s*(?:[-*]\s*)?\[?(Critical|High|Medium|Low|Info)\]?\s*[:—-]?\s*(.+)$/i;
export function extractFindings(report) {
  const out = [];
  for (const line of String(report ?? '').split('\n')) {
    const m = FINDING.exec(line);
    if (m && m[2].trim().length > 8) out.push({ severity: m[1][0].toUpperCase() + m[1].slice(1).toLowerCase(), text: m[2].trim().slice(0, 500) });
  }
  return out.slice(0, 50);
}

// One results row per (instance, variant, task, run). Aggregates the scores the README promises to report.
export function aggregate(rows, { seed = 1 } = {}) {
  const by = {};
  for (const r of rows) {
    const k = `${r.task}/${r.variant}`;
    const g = by[k] ?? (by[k] = { task: r.task, variant: r.variant, solved: {}, recall: {}, precision: {}, cost: [], approved: 0, decided: 0 });
    const push = (map, v) => { if (typeof v === 'number' && Number.isFinite(v)) (map[r.instance] ??= []).push(v); };
    // Solved means the hidden upstream tests pass AND the existing suite still passes; an ungraded run (no boolean) is left out.
    if (r.task === 'build' && typeof r.hiddenTestsPass === 'boolean') push(g.solved, r.hiddenTestsPass && r.suiteStillPasses !== false ? 1 : 0);
    if (r.task === 'review') {
      push(g.recall, typeof r.foundBug === 'boolean' ? Number(r.foundBug) : NaN);
      if (Number.isInteger(r.findings) && r.findings > 0 && Number.isInteger(r.validFindings)) push(g.precision, r.validFindings / r.findings);
    }
    if (typeof r.costUsd === 'number') g.cost.push(r.costUsd);
    if (r.decision === 'approved' || r.decision === 'rejected') { g.decided++; if (r.decision === 'approved') g.approved++; }
  }
  return Object.values(by).map(g => ({
    task: g.task, variant: g.variant,
    ...(g.task === 'build' ? { solved: bootstrapCI(g.solved, { seed }) } : { recall: bootstrapCI(g.recall, { seed }), precision: bootstrapCI(g.precision, { seed }) }),
    meanCostUsd: g.cost.length ? mean(g.cost) : null,
    approvalRate: g.decided ? g.approved / g.decided : null,
  }));
}

const pct = v => (Number.isFinite(v) ? `${Math.round(v * 100)}%` : 'n/a');
export const fmtCI = c => (c && Number.isFinite(c.mean) ? `${pct(c.mean)} [${pct(c.lo)}, ${pct(c.hi)}] (${c.instances} inst, ${c.runs} runs)` : 'n/a');

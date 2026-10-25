#!/usr/bin/env node
// The undo-the-fix benchmark: does floorhands find and fix real bugs, and does the nine-agent pipeline beat one plain agent?
// See eval/bench/README.md for the method. Subcommands:
//
//   prepare  --corpus <file> --work <dir> [--only id,id] [--install]
//            Clone each project at its fix commit, put the fixed source files back to their pre-fix state, hide the tests the fix
//            added, and save the result as a fresh one-commit repository (no history, so `git log` cannot reveal the fix).
//   run      --corpus <file> --work <dir> --variant floorhands|single --task review|build [--runs 5] [--only ...] [--holdout]
//            --yes-spend-quota   Real `claude` calls. Appends one JSON line per run to <work>/results.jsonl.
//   grade    --corpus <file> --work <dir> (--docker | --trust-local) [--judge-cmd <exe>]
//            build runs: apply the agent's patch plus the hidden upstream tests and run the project's own test command.
//            review runs: a blind judge (another model family, your executable) decides which findings are valid and which match
//            the planted bug. Writes <work>/graded.jsonl.
//   calibrate --work <dir> --labels <file>   Cohen's kappa between the judge and your own labels on the same findings.
//   report   --work <dir> [--holdout]         Means with 95% bootstrap intervals over instances, and floorhands minus single.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateCorpus, VARIANTS, TASKS, blind, extractFindings, aggregate, pairedDiffCI, cohenKappa, fmtCI } from './bench-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
// Cloning third-party repositories: no hooks, no fsmonitor, no ssh, https only.
const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.sshCommand=/bin/false', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always'];
const git = (cwd, ...a) => execFileSync('git', [...SAFE, ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 50 * 1024 * 1024 });
const ID = { name: 'bench', email: 'bench@localhost' };
const commitAllFresh = (dir, msg) => {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, '-c', `user.name=${ID.name}`, '-c', `user.email=${ID.email}`, '-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', msg);
};

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const o = { cmd, runs: 5 };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const val = () => { const v = rest[++i]; if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`); return v; };
    if (a === '--corpus') o.corpus = val();
    else if (a === '--work') o.work = path.resolve(val());
    else if (a === '--only') o.only = val().split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--variant') o.variant = val();
    else if (a === '--task') o.task = val();
    else if (a === '--runs') o.runs = Number(val());
    else if (a === '--judge-cmd') o.judgeCmd = path.resolve(val());
    else if (a === '--labels') o.labels = val();
    else if (a === '--install') o.install = true;
    else if (a === '--holdout') o.holdout = true;
    else if (a === '--docker') o.docker = true;
    else if (a === '--trust-local') o.trustLocal = true;
    else if (a === '--yes-spend-quota') o.spend = true;
    else throw new Error(`unknown option ${a}`);
  }
  if (o.variant && !VARIANTS.includes(o.variant)) throw new Error(`--variant must be ${VARIANTS.join(' or ')}`);
  if (o.task && !TASKS.includes(o.task)) throw new Error(`--task must be ${TASKS.join(' or ')}`);
  if (!Number.isInteger(o.runs) || o.runs < 1 || o.runs > 20) throw new Error('--runs must be 1 to 20');
  return o;
}

function loadCorpus(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const problems = validateCorpus(doc);
  if (problems.length) throw new Error(`${file}:\n  ${problems.join('\n  ')}`);
  return doc;
}
// Holdout instances are never used while tuning prompts; `--holdout` selects exactly them, otherwise they are excluded.
const pick = (doc, o) => doc.instances.filter(x => (!o.only || o.only.includes(x.id)) && (o.holdout ? (doc.holdout ?? []).includes(x.id) : !(doc.holdout ?? []).includes(x.id)));
const paths = (work, id) => ({ buggy: path.join(work, 'instances', id, 'buggy'), hidden: path.join(work, 'instances', id, 'hidden'), meta: path.join(work, 'instances', id, 'meta.json') });

function prepare(o) {
  const doc = loadCorpus(o.corpus);
  for (const x of doc.instances.filter(i => !o.only || o.only.includes(i.id))) {
    const p = paths(o.work, x.id);
    if (fs.existsSync(p.meta)) { console.log(`${x.id}: already prepared`); continue; }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `bench-${x.id}-`));
    try {
      const up = path.join(tmp, 'upstream');
      execFileSync('git', [...SAFE, 'clone', '-q', '--no-checkout', '--filter=blob:none', '--', x.repo, up], { stdio: 'inherit' });
      git(up, 'checkout', '-q', '--detach', x.fixCommit);
      const parent = git(up, 'rev-parse', `${x.fixCommit}^`).trim();
      fs.mkdirSync(p.hidden, { recursive: true });
      for (const f of x.testFiles) {
        const src = path.join(up, f);
        if (!fs.existsSync(src)) throw new Error(`${x.id}: test file ${f} is not in the fix commit`);
        fs.mkdirSync(path.dirname(path.join(p.hidden, f)), { recursive: true });
        fs.copyFileSync(src, path.join(p.hidden, f));
      }
      // Buggy state: the fix commit's tree, with the fixed source files and the tests as they were before the fix.
      for (const f of [...x.sourceFiles, ...x.testFiles]) {
        const existed = spawnSync('git', [...SAFE, 'cat-file', '-e', `${parent}:${f}`], { cwd: up }).status === 0;
        if (existed) git(up, 'checkout', '-q', parent, '--', f);
        else fs.rmSync(path.join(up, f), { force: true });
      }
      fs.rmSync(path.join(up, '.git'), { recursive: true, force: true });
      fs.mkdirSync(path.dirname(p.buggy), { recursive: true });
      fs.renameSync(up, p.buggy);
      commitAllFresh(p.buggy, 'bench: project state before the fix');
      // Dependencies are installed by the owner's choice, never by an agent (agents cannot reach the network). --ignore-scripts keeps
      // the project's install scripts from running on this machine.
      if (o.install && fs.existsSync(path.join(p.buggy, 'package.json'))) {
        const lock = fs.existsSync(path.join(p.buggy, 'package-lock.json'));
        execFileSync('npm', [lock ? 'ci' : 'install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: p.buggy, stdio: 'inherit' });
      }
      fs.writeFileSync(p.meta, JSON.stringify({ id: x.id, repo: x.repo, fixCommit: x.fixCommit, parent, preparedAt: new Date().toISOString() }, null, 2));
      console.log(`${x.id}: prepared (hidden tests: ${x.testFiles.length})`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

// A throwaway copy of the prepared repository (node_modules linked, not copied) for one run.
function freshCopy(src) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bench-run-')));
  for (const name of fs.readdirSync(src)) {
    if (name === 'node_modules') fs.symlinkSync(path.join(src, name), path.join(dir, name), 'dir');
    else fs.cpSync(path.join(src, name), path.join(dir, name), { recursive: true, verbatimSymlinks: true });
  }
  return dir;
}

// The baseline: one agent, the same CLI, the same tier permissions and sandbox, a short generic prompt, and the build tier's default
// model. If nine agents cannot beat this, the orchestration is not earning its tokens.
const SINGLE_SYSTEM = 'You are a careful senior software engineer working in a git repository. Do the task you are given. '
  + 'For a review, report each problem on its own line as "[Critical|High|Medium|Low] path:line — problem". '
  + 'For a change, edit the files needed and keep the change small. You cannot install packages or reach the network.';

async function runOne({ x, o, n, workRoot, store, wt, roster, policy, runAgent, createOrchestrator, resolveStep, redact }) {
  const repo = freshCopy(paths(o.work, x.id).buggy);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-home-'));
  const prevHome = process.env.FLOORHANDS_HOME;
  process.env.FLOORHANDS_HOME = home; // worktrees and notes of bench runs never mix with the owner's
  const text = x.tasks[o.task];
  const row = { instance: x.id, variant: o.variant, task: o.task, run: n, startedAt: new Date().toISOString() };
  try {
    if (o.variant === 'floorhands') {
      const orch = createOrchestrator({ root: repo, roster, store, wt, policy, runner: runAgent });
      const t = store.createTask(repo, text);
      await orch.run(t.id);
      const done = store.getTask(repo, t.id);
      row.status = done.status;
      row.costUsd = done.totals?.costUsd ?? null;
      row.models = done.totals?.byModel ?? null;
      row.steps = done.steps.map(s => ({ agent: s.agent, class: s.route?.class, model: s.metrics?.model, status: s.status }));
      row.report = redact(done.steps.filter(s => roster.byId[s.agent]?.tier === 'read').map(s => s.output).join('\n\n') || done.summary || '');
      if (done.status === 'awaiting_approval') {
        row.patch = await wt.diff(repo, done.worktree);
        await orch.reject(t.id, { reason: 'other', note: 'bench run' });
      }
    } else {
      const agent = { id: 'single', name: 'SINGLE AGENT', tier: o.task === 'build' ? 'build' : 'read', model: { default: 'standard', min: 'standard', max: 'standard' } };
      const route = resolveStep(agent, undefined, policy, policy.taskBudgetUsd);
      let cwd = repo, w = null;
      if (o.task === 'build') { w = await wt.createWorktree(repo, `t-bench-${Date.now().toString(36)}`); cwd = w.dir; }
      const res = await runAgent({ agent, system: SINGLE_SYSTEM, prompt: `<task>\n${text}\n</task>`, cwd, model: route.model, effort: route.effort, budgetUsd: route.budgetUsd });
      row.status = 'done';
      row.costUsd = res.metrics?.costUsd ?? null;
      row.models = res.metrics?.model ? { [res.metrics.model]: { runs: 1, costUsd: res.metrics.costUsd } } : null;
      row.report = redact(res.text);
      if (w) {
        await wt.commitAll(w, 'bench: single agent', { root: repo });
        row.patch = await wt.diff(repo, w);
        await wt.reject(repo, w);
      }
    }
  } catch (e) {
    row.status = 'error';
    row.error = String(e.message).slice(0, 500);
  } finally {
    if (prevHome === undefined) delete process.env.FLOORHANDS_HOME; else process.env.FLOORHANDS_HOME = prevHome;
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
  if (row.patch !== undefined) {
    const dir = path.join(workRoot, 'patches');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${x.id}.${o.variant}.${o.task}.${row.run}.patch`);
    fs.writeFileSync(file, redact(row.patch ?? ''));
    row.patch = path.relative(workRoot, file);
  }
  return row;
}

async function run(o) {
  if (!o.spend) throw new Error('run makes real claude calls and spends quota: pass --yes-spend-quota');
  if (!o.variant || !o.task) throw new Error('run needs --variant and --task');
  const doc = loadCorpus(o.corpus);
  const [{ loadRoster }, store, wt, { runAgent }, { createOrchestrator }, { loadPolicy, resolveStep }, { redact }] = await Promise.all([
    import('../server/roster.js'), import('../server/store.js'), import('../server/worktree.js'), import('../server/runner.js'),
    import('../server/orchestrator.js'), import('../server/models.js'), import('../server/redact.js')]);
  const roster = loadRoster(path.join(ROOT, 'agents'));
  const policy = loadPolicy();
  const claudeBin = process.env.FLOORHANDS_CLAUDE_BIN || 'claude';
  const out = path.join(o.work, 'results.jsonl');
  for (let n = 1; n <= o.runs; n++) { // run 1 of every instance first, so a stopped run leaves a balanced comparison
    for (const x of pick(doc, o)) {
      if (!fs.existsSync(paths(o.work, x.id).meta)) { console.log(`${x.id}: not prepared, skipped`); continue; }
      const row = await runOne({ x, o, n, workRoot: o.work, store, wt, roster, policy, runAgent: opts => runAgent({ ...opts, claudeBin }), createOrchestrator, resolveStep, redact });
      fs.appendFileSync(out, JSON.stringify(row) + '\n');
      console.log(`${x.id} ${o.variant}/${o.task} run ${n}: ${row.status}${row.costUsd != null ? ` $${row.costUsd}` : ''}`);
    }
  }
}

// Runs the project's own test command on a copy of the buggy repo plus the agent's patch plus the hidden upstream tests.
function testPatch(x, o, row) {
  const p = paths(o.work, x.id);
  const dir = freshCopy(p.buggy);
  try {
    if (row.patch) {
      const patch = path.join(o.work, row.patch);
      if (fs.statSync(patch).size > 0) {
        const r = spawnSync('git', [...SAFE, 'apply', '--whitespace=nowarn', patch], { cwd: dir, encoding: 'utf8' });
        if (r.status !== 0) return { hiddenTestsPass: false, gradeNote: `patch did not apply: ${String(r.stderr).slice(0, 200)}` };
      }
    }
    fs.cpSync(p.hidden, dir, { recursive: true });
    const [cmd, ...args] = x.testCommand;
    // Third-party test code: in a container with no network by default. --trust-local runs it on this machine instead.
    const r = o.docker
      ? spawnSync('docker', ['run', '--rm', '--network', 'none', '-v', `${fs.realpathSync(p.buggy)}/node_modules:/w/node_modules:ro`, '-v', `${dir}:/w`, '-w', '/w', 'node:22', cmd, ...args], { encoding: 'utf8', timeout: 15 * 60 * 1000 })
      : spawnSync(cmd, args, { cwd: dir, encoding: 'utf8', timeout: 15 * 60 * 1000, env: { PATH: process.env.PATH, HOME: dir, CI: '1' } });
    const tail = String(r.stdout ?? '').concat(String(r.stderr ?? '')).trim().split('\n').slice(-6).join('\n').slice(-600);
    return { hiddenTestsPass: r.status === 0, gradeNote: r.status === 0 ? 'tests pass' : `tests fail (exit ${r.status ?? r.signal}${r.error ? `, ${r.error.code}` : ''}): ${tail}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function grade(o) {
  if (!o.docker && !o.trustLocal) throw new Error('grading runs the projects\' own test code: pass --docker (no network) or --trust-local');
  const doc = loadCorpus(o.corpus);
  const byId = Object.fromEntries(doc.instances.map(x => [x.id, x]));
  const rows = fs.readFileSync(path.join(o.work, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const reviews = [];
  for (const row of rows) {
    const x = byId[row.instance];
    if (!x || row.status === 'error') continue;
    if (row.task === 'build') Object.assign(row, testPatch(x, o, row));
    if (row.task === 'review') { row.findingList = extractFindings(row.report); row.findings = row.findingList.length; reviews.push(row); }
  }
  if (reviews.length && o.judgeCmd) {
    // Blind: the judge never sees which variant wrote a report, and sees them shuffled.
    const { items, key } = blind(reviews.map(r => ({ instance: r.instance, findings: r.findingList.map(f => f.text) })), 1);
    for (const it of items) {
      const input = JSON.stringify({ bug: byId[it.instance].bug, findings: it.findings });
      const r = spawnSync(o.judgeCmd, [], { input, encoding: 'utf8', timeout: 10 * 60 * 1000 });
      let verdict;
      try { verdict = JSON.parse(r.stdout); } catch { verdict = null; }
      const row = reviews[key[it.blindId]];
      const valid = Array.isArray(verdict?.valid) ? verdict.valid : [];
      const matches = Array.isArray(verdict?.matchesBug) ? verdict.matchesBug : [];
      row.judge = { blindId: it.blindId, valid, matchesBug: matches };
      row.validFindings = valid.filter(v => v === true).length;
      row.foundBug = matches.some(v => v === true);
    }
  } else if (reviews.length) {
    console.log('review runs found but no --judge-cmd: recall and precision stay ungraded');
  }
  fs.writeFileSync(path.join(o.work, 'graded.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  console.log(`graded ${rows.length} run(s) -> ${path.join(o.work, 'graded.jsonl')}`);
}

function calibrate(o) {
  // labels: [{ blindId, index, human: true|false }] for "is this finding valid", written by a person from judge-visible items.
  const labels = JSON.parse(fs.readFileSync(o.labels, 'utf8'));
  const rows = fs.readFileSync(path.join(o.work, 'graded.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const judged = new Map(rows.filter(r => r.judge).map(r => [r.judge.blindId, r.judge.valid]));
  const pairs = labels.map(l => ({ judge: judged.get(l.blindId)?.[l.index], human: l.human }));
  const kappa = cohenKappa(pairs);
  fs.writeFileSync(path.join(o.work, 'calibration.json'), JSON.stringify({ kappa, n: pairs.filter(p => typeof p.judge === 'boolean').length }, null, 2));
  console.log(`Cohen's kappa ${Number.isFinite(kappa) ? kappa.toFixed(2) : 'n/a'} over ${pairs.length} labelled findings${kappa < 0.6 ? ' (below 0.6: do not trust the judge\'s precision numbers)' : ''}`);
}

function report(o) {
  const rows = fs.readFileSync(path.join(o.work, 'graded.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.status !== 'error');
  let cal = null;
  try { cal = JSON.parse(fs.readFileSync(path.join(o.work, 'calibration.json'), 'utf8')); } catch { /* not calibrated */ }
  const lines = ['| Task | Variant | Solved / recall | Precision | Mean cost |', '|---|---|---|---|---|'];
  for (const a of aggregate(rows)) {
    lines.push(`| ${a.task} | ${a.variant} | ${fmtCI(a.solved ?? a.recall)} | ${a.precision ? fmtCI(a.precision) : '-'} | ${a.meanCostUsd != null ? `$${a.meanCostUsd.toFixed(2)}` : 'n/a'} |`);
  }
  const score = (task, variant) => {
    const m = {};
    for (const r of rows.filter(x => x.task === task && x.variant === variant)) {
      const v = task === 'build' ? (typeof r.hiddenTestsPass === 'boolean' ? Number(r.hiddenTestsPass) : null) : (typeof r.foundBug === 'boolean' ? Number(r.foundBug) : null);
      if (v !== null) (m[r.instance] ??= []).push(v);
    }
    return m;
  };
  lines.push('', 'floorhands minus single agent (paired by instance, 95% bootstrap interval):');
  for (const task of TASKS) {
    const d = pairedDiffCI(score(task, 'floorhands'), score(task, 'single'));
    lines.push(`- ${task}: ${Number.isFinite(d.mean) ? `${(d.mean * 100).toFixed(0)} points [${(d.lo * 100).toFixed(0)}, ${(d.hi * 100).toFixed(0)}] over ${d.instances} instance(s)` : 'not enough paired runs'}`);
  }
  lines.push('', cal ? `Judge calibration: kappa ${Number(cal.kappa).toFixed(2)} on ${cal.n} findings${cal.kappa < 0.6 ? ' (BELOW 0.6: precision is not trustworthy)' : ''}.` : 'Judge not calibrated: treat precision as unverified (run calibrate).');
  console.log(lines.join('\n'));
}

const isMain = (() => { try { return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  const need = k => { if (!o[k]) { console.error(`--${k} is required`); process.exit(2); } };
  try {
    if (o.cmd === 'prepare') { need('corpus'); need('work'); prepare(o); }
    else if (o.cmd === 'run') { need('corpus'); need('work'); await run(o); }
    else if (o.cmd === 'grade') { need('corpus'); need('work'); grade(o); }
    else if (o.cmd === 'calibrate') { need('work'); need('labels'); calibrate(o); }
    else if (o.cmd === 'report') { need('work'); report(o); }
    else { console.error('usage: node scripts/bench.mjs prepare|run|grade|calibrate|report ... (see the header of this file)'); process.exit(2); }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

export { parseArgs };

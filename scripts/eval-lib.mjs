// Pure helpers (plus two small file readers) for scripts/eval-prompts.mjs: the evaluation matrix, argument parsing, the call cap,
// scoring a reviewer's report against planted problems, aggregation and redaction. No process spawning, no network.
import fs from 'node:fs';
import path from 'node:path';

export const FIXTURES = {
  'express-api': { title: 'Express + pg shop API' },
  'react-app': { title: 'React + Vite + TypeScript news reader' },
  'aws-infra': { title: 'Terraform stack with a GitHub Actions deploy workflow' },
};

// One role per fixture; the task is also the owner's `<task>`, exactly as an architect step would pass it on.
export const ROLE_TASKS = {
  rbe: { fixture: 'express-api', task: 'Review the back-end for security and reliability problems.' },
  rfe: { fixture: 'react-app', task: 'Review the front end for security, correctness, accessibility and performance problems.' },
  raws: { fixture: 'aws-infra', task: 'Review the infrastructure and the deploy workflow.' },
};
export const VARIANTS = ['old', 'new'];
export const DEFAULT_MAX_CALLS = 14;
export const DEFAULT_REPEAT = 2;
export const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Info'];
const HIGH = new Set(['Critical', 'High']);

// The orchestrator's step prompt (server/orchestrator.js) without the worktree/base lines and without prior output.
export const stepPrompt = task => `<step>\n${task}\n</step>\n\nOwner's original request:\n<task>\n${task}\n</task>`;

// ---------- arguments ----------
export const USAGE = `Usage: node scripts/eval-prompts.mjs [options]

Runs the v0.1.0 prompts ("old") and the current prompts ("new") against small sample projects with planted problems, through the real
runner and the real, logged-in claude CLI, and scores the reports. One claude -p turn per cell; never part of npm test.

  --roles <a,b>        rbe, rfe, raws (default: all three)
  --only <a,b>         limit to roles whose fixture is named (express-api, react-app, aws-infra)
  --variants <a,b>     old, new (default: both)
  --repeat <n>         runs per role and variant (default ${DEFAULT_REPEAT})
  --max-calls <n>      hard cap on claude calls (default ${DEFAULT_MAX_CALLS}); the run stops and reports partial results when reached
  --yes-spend-quota    required for any real call (not for --dry-run, --list, --help)
  --out <base>         write <base>.json (raw, redacted) and <base>.tables.md (default docs/prompt-eval)
  --label <text>       name of this round in the output (default "round 1")
  --append             add this round to an existing <base>.json instead of replacing it
  --render <json>      print the markdown tables for an existing results file; no calls
  --rescore <json>     re-score the stored reports of a results file in place with the current scorer; no calls
  --dry-run            print the run matrix and estimates; no calls
  --list               list fixtures, roles and tasks; no calls
  --keep               keep the temporary repositories
  --help               this text

Exit: 0 ok, 2 usage error, 3 stopped early (call cap or rate limit; partial results written), 4 the claude CLI could not be started.`;

const takeValue = (argv, i, flag) => {
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
  return v;
};
const list = (v, allowed, flag) => {
  const items = v.split(',').map(s => s.trim()).filter(Boolean);
  if (!items.length) throw new Error(`${flag} needs at least one value`);
  const bad = items.filter(x => !allowed.includes(x));
  if (bad.length) throw new Error(`${flag}: unknown value(s) ${bad.join(', ')} (allowed: ${allowed.join(', ')})`);
  return [...new Set(items)];
};
const posInt = (v, flag, min) => {
  if (!/^\d+$/.test(v) || Number(v) < min) throw new Error(`${flag} must be a whole number >= ${min}`);
  return Number(v);
};

export function parseArgs(argv) {
  const o = {
    help: false, list: false, dryRun: false, yes: false, keep: false, append: false,
    roles: Object.keys(ROLE_TASKS), variants: [...VARIANTS], repeat: DEFAULT_REPEAT, maxCalls: DEFAULT_MAX_CALLS,
    out: 'docs/prompt-eval', label: 'round 1', render: null, rescore: null,
  };
  let only = null;
  let rolesGiven = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--help': case '-h': o.help = true; break;
      case '--list': o.list = true; break;
      case '--dry-run': o.dryRun = true; break;
      case '--yes-spend-quota': o.yes = true; break;
      case '--keep': o.keep = true; break;
      case '--append': o.append = true; break;
      case '--roles': o.roles = list(takeValue(argv, i++, a), Object.keys(ROLE_TASKS), a); rolesGiven = true; break;
      case '--only': only = list(takeValue(argv, i++, a), Object.keys(FIXTURES), a); break;
      case '--variants': o.variants = list(takeValue(argv, i++, a), VARIANTS, a); break;
      case '--repeat': o.repeat = posInt(takeValue(argv, i++, a), a, 1); break;
      case '--max-calls': o.maxCalls = posInt(takeValue(argv, i++, a), a, 0); break;
      case '--out': o.out = takeValue(argv, i++, a); break;
      case '--label': o.label = takeValue(argv, i++, a); break;
      case '--render': o.render = takeValue(argv, i++, a); break;
      case '--rescore': o.rescore = takeValue(argv, i++, a); break;
      default: throw new Error(`unknown argument: ${a}`);
    }
  }
  if (only) {
    const keep = o.roles.filter(r => only.includes(ROLE_TASKS[r].fixture));
    o.roles = rolesGiven || keep.length ? keep : o.roles;
  }
  return o;
}

// Cells ordered by repeat, then role, then variant, so a cap or a rate limit leaves the comparison as balanced as possible.
export function buildMatrix({ roles, variants, repeat }) {
  const cells = [];
  for (let rep = 1; rep <= repeat; rep++) {
    for (const role of roles) {
      for (const variant of variants) cells.push({ role, fixture: ROLE_TASKS[role].fixture, variant, rep });
    }
  }
  return cells;
}

export const isRateLimitError = msg => /usage limit|rate.?limit|limit reached|too many requests|\b429\b|overloaded|quota/i.test(String(msg ?? ''));

// Runs cells in order. Every attempt counts as a call, errored or not. Stops at maxCalls, and after a rate-limit error
// (retrying only burns calls). runOne must not throw; a throw is recorded as an errored cell.
export async function executeMatrix(cells, { maxCalls, runOne }) {
  const results = [];
  let stoppedBy = null;
  let i = 0;
  for (; i < cells.length; i++) {
    if (results.length >= maxCalls) { stoppedBy = 'call-cap'; break; }
    let r;
    try { r = await runOne(cells[i]); } catch (e) { r = { ...cells[i], status: 'errored', error: String(e?.message ?? e) }; }
    results.push(r);
    if (r.status === 'errored' && isRateLimitError(r.error)) { i++; stoppedBy = 'rate-limit'; break; }
  }
  const skipped = cells.slice(i);
  return { results, calls: results.length, skipped, capped: stoppedBy === 'call-cap', stoppedBy };
}

// ---------- fixtures and expected findings ----------
// { 'relative/path': line count } for every file under dir (dotfiles included, .git excluded).
export function fixtureFiles(dir) {
  const out = {};
  const walk = rel => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) out[r] = lineCount(fs.readFileSync(path.join(dir, r), 'utf8'));
    }
  };
  walk('');
  return out;
}
const lineCount = text => (text === '' ? 0 : text.replace(/\n$/, '').split('\n').length);

export const loadExpected = file => JSON.parse(fs.readFileSync(file, 'utf8'));

// ---------- finding blocks ----------
const LABEL = '(Critical|High|Medium|Low|Info)';
const START = new RegExp(`^[ \\t]*(?:#{1,6}[ \\t]*)?(?:(?:[-*+]|\\d+[.)])[ \\t]+)?(\\*\\*|__)?(\\[)?${LABEL}(\\])?(\\*\\*|__)?(?=$|[\\s:—–\\-\\])])(.*)$`);

// A line starts a block when it begins with a rubric label in brackets or bold, or with the label followed by a separator
// (`High — title`, `Low: title`); a summary line such as `Critical: 2, High: 1` or prose such as `High availability ...` does not.
function startOf(line) {
  const m = START.exec(line);
  if (!m) return null;
  const [, boldOpen, bracketOpen, label, bracketClose, , rest] = m;
  const bracketed = !!bracketOpen && !!bracketClose;
  if (!bracketed && !boldOpen) {
    if (!/^[ \t]*[:—–-]/.test(rest)) return null;
    if (/^[ \t]*[:—–-][ \t]*\d+\b/.test(rest)) return null;
  }
  return label;
}

// `## Critical` (also `**High**` alone on a line, `### Medium (3)`, `Low findings:`): a heading that only names a severity. Findings listed under
// it (numbered items, bullets, bold-led lines) inherit that severity. The v0.1.0 prompts produce reports in this shape.
const SECTION = new RegExp(`^[ \\t]*(?:#{1,6}[ \\t]*)?(?:\\*\\*|__)?\\[?${LABEL}\\]?(?:\\*\\*|__)?[ \\t]*(?:findings?|issues?|\\(\\d+\\)|[:—–-]?[ \\t]*\\d+)?[ \\t]*:?[ \\t]*$`);
const BOLD_HEADING = /^(?:\*\*|__)[^*_\n]+(?:\*\*|__)[ \t]*:?[ \t]*$/; // `**Personal data (DPDP)**` alone on a line ends the severity section
const ITEM = /^(?:(?:[-*+]|\d+[.)])[ \t]+|\*\*|__)/; // unindented list item or bold-led line

export function splitBlocks(report) {
  const text = String(report ?? '');
  const blocks = [];
  let cur = null;
  let section = null; // severity named by the last severity-only heading
  let offset = 0;
  const close = end => { if (cur) { cur.end = end; cur.text = text.slice(cur.start, end).trimEnd(); blocks.push(cur); cur = null; } };
  for (const line of text.split('\n')) {
    const sec = SECTION.exec(line);
    const label = sec ? null : startOf(line);
    if (sec) {
      close(offset);
      section = sec[1];
    } else if (label) {
      close(offset);
      cur = { severity: label, start: offset, title: line.trim() };
    } else if (/^#{1,6}\s/.test(line) || BOLD_HEADING.test(line)) {
      close(offset);
      section = null;
    } else if (section && ITEM.test(line)) {
      close(offset);
      cur = { severity: section, start: offset, title: line.trim() };
    }
    offset += line.length + 1;
  }
  close(text.length);
  return blocks;
}

// ---------- citations ----------
const EXT = 'js|jsx|ts|tsx|mjs|cjs|json|yml|yaml|tf|tfvars|hcl|sql|md|html|css|example|env|py|sh|toml|lock';
const CITE = new RegExp(`(?<![\\w@./:\\\\-])(\\/?(?:[\\w@.-]+/)*[\\w@.-]*\\.(?:${EXT}))\`?:(\\d+)(?:[ \\t]*[-–][ \\t]*(\\d+))?(?!\\d)`, 'g');
const PROSE_NAME = /^[A-Z][a-z]+\.js$/; // Node.js, Vue.js ...

const suffixes = rel => {
  const parts = rel.split('/');
  return parts.map((_, i) => parts.slice(i).join('/'));
};

// The fixture file a cited path means, or null: an exact relative path, an absolute path ending in one, or a unique shorter suffix.
export function resolveFile(cited, files) {
  const c = String(cited).replace(/^\.\//, '').replace(/\\/g, '/');
  const names = Object.keys(files);
  if (Object.hasOwn(files, c)) return c;
  const abs = names.filter(f => c.endsWith('/' + f));
  if (abs.length) return abs.sort((a, b) => b.length - a.length)[0];
  const tails = names.filter(f => f === c || f.endsWith('/' + c));
  return tails.length === 1 ? tails[0] : null;
}

export function extractCitations(text, files) {
  const out = [];
  for (const m of String(text ?? '').matchAll(CITE)) {
    const pathPart = m[1].replace(/^\.\//, '');
    if (PROSE_NAME.test(pathPart)) continue;
    const a = Number(m[2]);
    const b = m[3] === undefined ? null : Number(m[3]);
    const file = resolveFile(pathPart, files);
    const len = file ? files[file] : 0;
    const valid = !!file && a >= 1 && a <= len && (b === null || (b >= a && b <= len));
    out.push({ raw: `${pathPart}:${a}${b === null ? '' : '-' + b}`, file, line: a, end: b, valid });
  }
  return out;
}

// ---------- scoring ----------
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Does `text` name this fixture file? Full relative path, or a shorter path suffix that is unique in the fixture.
function mentions(text, rel, files) {
  const unique = suffixes(rel).filter(s => Object.keys(files).filter(f => f === s || f.endsWith('/' + s)).length === 1);
  const forms = unique.length ? unique : [rel];
  return forms.some(s => new RegExp(`(?<![\\w.-])${escapeRe(s)}(?![\\w-])`).test(text));
}

const NEAR = 150;

function matchIssue(issue, block, report, files) {
  const text = block.text;
  if (!issue.anyOf.some(r => new RegExp(r, 'i').test(text))) return null;
  const wanted = [issue.file, ...(issue.alsoFiles ?? [])];
  if (wanted.some(f => mentions(text, f, files))) return 'block';
  const around = report.slice(Math.max(0, block.start - NEAR), block.start) + '\n' + report.slice(block.end, block.end + NEAR);
  return wanted.some(f => mentions(around, f, files)) ? 'near' : null;
}

const sevRank = s => SEVERITIES.indexOf(s);

export function scoreReport({ report, expected, files }) {
  const text = String(report ?? '');
  const blocks = splitBlocks(text);
  // via[i][k]: how block i matches planted issue k (null = not at all).
  const via = blocks.map(b => expected.map(issue => matchIssue(issue, b, text, files)));
  const matched = new Set(via.flatMap((row, i) => (row.some(Boolean) ? [i] : [])));
  const issues = expected.map((issue, k) => {
    // The block that is most about this issue, whose severity is the rating attributed to it: one that names the expected file itself, then
    // the one matching the most of the issue's patterns (a passing mention scores 1), then the one matching the fewest planted issues
    // (a combined block is the last resort), then the first.
    let best = null;
    blocks.forEach((blk, i) => {
      if (!via[i][k]) return;
      const cand = {
        block: blk, via: via[i][k], width: via[i].filter(Boolean).length,
        hits: issue.anyOf.filter(r => new RegExp(r, 'i').test(blk.text)).length,
      };
      const better = !best
        || (cand.via === 'block') !== (best.via === 'block') ? cand.via === 'block'
        : cand.hits !== best.hits ? cand.hits > best.hits
          : cand.width < best.width;
      if (!best || better) best = cand;
    });
    return {
      id: issue.id, expectedSeverity: issue.severity, found: !!best,
      // Content-only match: a block says it but names no expected file anywhere near. Reported next to the strict result, never instead of it.
      looseFound: blocks.some(b => issue.anyOf.some(r => new RegExp(r, 'i').test(b.text))), foundSeverity: best?.block.severity ?? null, via: best?.via ?? null,
      foundTitle: best ? best.block.title.slice(0, 160) : null,
    };
  });
  const planted = expected.length;
  const found = issues.filter(i => i.found).length;
  const high = issues.filter(i => HIGH.has(i.expectedSeverity));
  const highFound = high.filter(i => i.found);
  const extras = blocks.map((b, i) => ({ b, i })).filter(({ b, i }) => !matched.has(i) && b.severity !== 'Info');
  const cites = extractCitations(text, files);
  const validCites = cites.filter(c => c.valid).length;
  const checked = highFound.length;
  const okSev = highFound.filter(i => HIGH.has(i.foundSeverity)).length;
  return {
    planted, found, recall: planted ? found / planted : null,
    looseFound: issues.filter(i => i.looseFound || i.found).length,
    looseRecall: planted ? issues.filter(i => i.looseFound || i.found).length / planted : null,
    criticalHighPlanted: high.length, criticalHighFound: highFound.length, criticalHighRecall: high.length ? highFound.length / high.length : null,
    issues,
    citations: { total: cites.length, valid: validCites, hallucinated: cites.length - validCites, validity: cites.length ? validCites / cites.length : null, bad: cites.filter(c => !c.valid).map(c => c.raw) },
    severity: { checked, ok: okSev, sanity: checked ? okSev / checked : null },
    // How the reviewer's rating compares with the planted rating, over the found issues (informational: the plant's rating is a judgement call).
    calibration: (() => {
      const f = issues.filter(i => i.found);
      const rank = x => sevRank(x);
      return { n: f.length, exact: f.filter(i => i.foundSeverity === i.expectedSeverity).length, over: f.filter(i => rank(i.foundSeverity) < rank(i.expectedSeverity)).length, under: f.filter(i => rank(i.foundSeverity) > rank(i.expectedSeverity)).length };
    })(),
    extraFindings: extras.length,
    extraTitles: extras.map(({ b }) => b.title.slice(0, 160)),
    infoFindings: blocks.filter(b => b.severity === 'Info').length,
    blocks: blocks.length,
    format: formatCompliance(text, blocks),
  };
}

// New-prompt requirements (the rubric names them); the old prompts did not ask for the first and third, so the two variants are
// reported separately.
export function formatCompliance(report, blocks = splitBlocks(report)) {
  const first = String(report ?? '').split('\n').find(l => l.trim() !== '') ?? '';
  const verdictFirstLine = /^[\s*#_>`-]*VERDICT:[\s*_]*(approve-with-changes|approve|block)\b/i.test(first) && /^[\s*#_>`-]*VERDICT:/.test(first);
  const stray = [...String(report ?? '').matchAll(/^[ \t]*(?:[-*+][ \t]+)?(?:\*\*)?\[([A-Za-z][A-Za-z -]*)\]/gm)].map(m => m[1]).filter(l => !SEVERITIES.includes(l));
  const rubricLabels = blocks.length > 0 && stray.length === 0;
  const notChecked = /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*|__)?What I did not check/im.test(String(report ?? ''));
  return { verdictFirstLine, rubricLabels, notChecked, compliant: verdictFirstLine && rubricLabels && notChecked };
}

// ---------- aggregation ----------
export function aggregate(values) {
  const v = values.filter(x => typeof x === 'number' && Number.isFinite(x));
  if (!v.length) return { n: 0, min: null, mean: null, max: null };
  return { n: v.length, min: Math.min(...v), mean: v.reduce((a, b) => a + b, 0) / v.length, max: Math.max(...v) };
}

// runs: [{ role, variant, status: 'ok'|'errored', score, wallMs, tools, usage }] -> { role: { variant: stats } }
export function aggregateRuns(runs) {
  const out = {};
  for (const r of runs) {
    ((out[r.role] ??= {})[r.variant] ??= []).push(r);
  }
  const result = {};
  for (const [role, byVariant] of Object.entries(out)) {
    result[role] = {};
    for (const [variant, rs] of Object.entries(byVariant)) {
      const ok = rs.filter(r => r.status === 'ok' && r.score);
      const col = f => aggregate(ok.map(f));
      result[role][variant] = {
        runs: rs.length, scored: ok.length, errored: rs.filter(r => r.status === 'errored').length,
        recall: col(r => r.score.recall),
        looseRecall: col(r => r.score.looseRecall),
        criticalHighRecall: col(r => r.score.criticalHighRecall),
        citationValidity: col(r => r.score.citations?.validity),
        hallucinated: col(r => r.score.citations?.hallucinated),
        severitySanity: col(r => r.score.severity?.sanity),
        extraFindings: col(r => r.score.extraFindings),
        overRated: col(r => (r.score.calibration?.n ? r.score.calibration.over / r.score.calibration.n : null)),
        underRated: col(r => (r.score.calibration?.n ? r.score.calibration.under / r.score.calibration.n : null)),
        totalInputTokens: col(r => (r.usage ? (r.usage.input_tokens ?? 0) + (r.usage.cache_creation_input_tokens ?? 0) + (r.usage.cache_read_input_tokens ?? 0) : null)),
        systemBytes: col(r => r.systemBytes),
        formatCompliance: ok.length ? ok.filter(r => r.score.format?.compliant).length / ok.length : null,
        wallMs: col(r => r.wallMs),
        tools: col(r => r.tools),
        inputTokens: col(r => r.usage?.input_tokens),
        outputTokens: col(r => r.usage?.output_tokens),
        cacheReadTokens: col(r => r.usage?.cache_read_input_tokens),
      };
    }
  }
  return result;
}

// ---------- redaction ----------
// Home paths, the temporary directories, e-mail addresses and the account's own names never reach the written results.
export function redactText(text, { tempDirs = [], names = [] } = {}) {
  let s = String(text);
  for (const d of [...tempDirs].sort((a, b) => b.length - a.length)) if (d) s = s.split(d).join('<fixture>');
  s = s.replace(/\/(?:private\/)?var\/folders\/[\w/.-]*?\/T\/floorhands-eval-[\w.-]+/g, '<fixture>');
  s = s.replace(/\/Users\/[^/\s'"`)\]]+/g, '~').replace(/\/home\/[^/\s'"`)\]]+/g, '~');
  s = s.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>');
  for (const n of names) if (n && n.length >= 3) s = s.split(n).join('<user>');
  return s;
}

export function redactDeep(value, opts) {
  if (typeof value === 'string') return redactText(value, opts);
  if (Array.isArray(value)) return value.map(v => redactDeep(v, opts));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, opts)]));
  return value;
}

// ---------- markdown tables ----------
const pct = v => (v === null || v === undefined ? 'n/a' : `${Math.round(v * 100)}%`);
const num = (v, d = 1) => (v === null || v === undefined ? 'n/a' : Number(v.toFixed(d)).toString());
const mmm = (a, f) => (a.n === 0 ? 'n/a' : a.n === 1 ? f(a.mean) : `${f(a.mean)} (${f(a.min)}–${f(a.max)})`);

export function renderTables(rounds) {
  const lines = [];
  for (const round of rounds) {
    const agg = aggregateRuns(round.runs);
    lines.push(`### ${round.label}`, '');
    lines.push('Mean (min–max) over the scored runs; `n` is the number of scored runs behind each cell.', '');
    lines.push('| Role | Variant | n | Recall (strict) | Recall (content only) | Critical/High recall | Citation validity | Hallucinated citations | Severity sanity | Over-rated (found items) | Under-rated | Extra findings | Format compliant (new-only rules) | Tool calls | Output tokens | Input tokens (incl. cache) | System prompt (bytes) | Wall time (s) |');
    lines.push(`|${'---|'.repeat(18)}`);
    for (const role of Object.keys(agg)) {
      for (const variant of VARIANTS) {
        const a = agg[role][variant];
        if (!a) continue;
        lines.push(`| ${role} | ${variant} | ${a.scored}${a.errored ? ` (+${a.errored} errored)` : ''} | ${mmm(a.recall, pct)} | ${mmm(a.looseRecall, pct)} | ${mmm(a.criticalHighRecall, pct)} | ${mmm(a.citationValidity, pct)} | ${mmm(a.hallucinated, v => num(v))} | ${mmm(a.severitySanity, pct)} | ${mmm(a.overRated, pct)} | ${mmm(a.underRated, pct)} | ${mmm(a.extraFindings, v => num(v))} | ${pct(a.formatCompliance)} | ${mmm(a.tools, v => num(v))} | ${mmm(a.outputTokens, v => num(v, 0))} | ${mmm(a.totalInputTokens, v => num(v, 0))} | ${num(a.systemBytes.mean, 0)} | ${mmm(a.wallMs, v => num(v / 1000, 0))} |`);
      }
    }
    lines.push('');
    // per-issue matrix
    const ok = round.runs.filter(r => r.status === 'ok' && r.score);
    const byRole = {};
    for (const r of ok) for (const i of r.score.issues) {
      const row = ((byRole[r.role] ??= {})[i.id] ??= { sev: i.expectedSeverity, old: [0, 0], new: [0, 0] });
      row[r.variant][1]++;
      if (i.found) row[r.variant][0]++;
    }
    lines.push('| Role | Planted issue | Severity | old found | new found |', '|---|---|---|---|---|');
    for (const [role, rows] of Object.entries(byRole)) {
      for (const [id, r] of Object.entries(rows)) lines.push(`| ${role} | ${id} | ${r.sev} | ${r.old[1] ? `${r.old[0]}/${r.old[1]}` : 'n/a'} | ${r.new[1] ? `${r.new[0]}/${r.new[1]}` : 'n/a'} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

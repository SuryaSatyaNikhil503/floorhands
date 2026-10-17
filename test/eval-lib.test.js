import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  FIXTURES, ROLE_TASKS, parseArgs, buildMatrix, executeMatrix, splitBlocks, extractCitations, scoreReport, aggregate, aggregateRuns,
  fixtureFiles, loadExpected, redactText, redactDeep, isRateLimitError, stepPrompt,
} from '../scripts/eval-lib.mjs';
import { loadLegacyRoster } from '../eval/baseline/legacy-compose.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVAL = path.join(ROOT, 'eval');
const SCRIPT = path.join(ROOT, 'scripts', 'eval-prompts.mjs');

// ---------- scoring with canned reports ----------
const FILES = { 'src/server.js': 20, 'src/routes/auth.js': 40, 'src/routes/products.js': 30, 'src/auth.js': 25, 'src/config.js': 6 };
const EXPECTED = [
  { id: 'sqli', severity: 'Critical', file: 'src/routes/products.js', linesHint: [17, 25], anyOf: ['sql.?injection', 'concatenat'] },
  { id: 'jwt', severity: 'High', file: 'src/config.js', linesHint: [3, 5], alsoFiles: ['src/auth.js'], anyOf: ['hard.?coded', 'fallback'] },
  { id: 'stack', severity: 'Medium', file: 'src/server.js', linesHint: [14, 18], anyOf: ['stack ?trace', 'err\\.stack'] },
  { id: 'rand', severity: 'High', file: 'src/routes/auth.js', linesHint: [24, 28], anyOf: ['Math\\.random'] },
];

const GOOD = `VERDICT: block

Two sentences of summary.

[Critical] SQL injection in product search — src/routes/products.js:20
Evidence: "... ILIKE '%" + term + "%'"
Why it matters: string concatenation of the query term.
Fix: use $1.

[High] Hard-coded signing secret with a fallback — src/config.js:4
Evidence: process.env.JWT_SECRET || '***'

**[Medium]** Error handler returns the stack trace — /tmp/x/repo/src/server.js:17
Evidence: stack: err.stack

[Low] Missing helmet — src/server.js:99999

## What I checked
src/server.js:1

## What I did not check
Deployed config.
`;

test('splitBlocks finds blocks in plain, bracketed, bold and heading styles and ends them at section headings', () => {
  const text = [
    'VERDICT: block', 'Critical: 1, High: 2', '',
    '[Critical] A — a.js:1', 'detail A', '',
    '**High** — B — b.js:2', 'detail B',
    '### [Medium] C — c.js:3', 'detail C',
    '- **[Low]** D — d.js:4',
    '1. Info: E',
    'High availability is out of scope for this prompt.',
    '## What I checked', 'a.js:1',
  ].join('\n');
  const blocks = splitBlocks(text);
  assert.deepEqual(blocks.map(b => b.severity), ['Critical', 'High', 'Medium', 'Low', 'Info']);
  assert.match(blocks[0].text, /detail A/);
  assert.doesNotMatch(blocks[0].text, /detail B/);
  assert.match(blocks[4].text, /High availability/); // prose that merely starts with a label word is not a new block
  assert.doesNotMatch(blocks[4].text, /What I checked/);
});

test('splitBlocks reads the v0.1.0 report shape: severity headings with numbered or bulleted findings under them', () => {
  const text = [
    '**Verdict: Do not ship.** Two Critical issues.', '',
    '## Critical',
    '1. **SQL injection** in `src/routes/products.js:19-21`. Concatenates q.',
    '   - sub point that belongs to item 1',
    '2. **Order IDOR** in `src/routes/orders.js:19`.',
    '## High (2)',
    '3. **Stack traces** in `src/server.js:17`.',
    '## Medium', '- **No helmet** in `src/server.js`.',
    '## Personal data (DPDP)', '- consent is missing',
    '## Not checked', '- dependencies',
  ].join('\n');
  const blocks = splitBlocks(text);
  assert.deepEqual(blocks.map(b => b.severity), ['Critical', 'Critical', 'High', 'Medium']);
  assert.match(blocks[0].text, /sub point/);
  assert.doesNotMatch(blocks[3].text, /consent/);
  const s = scoreReport({ report: text, expected: EXPECTED, files: FILES });
  assert.equal(s.issues.find(i => i.id === 'sqli').found, true);
  assert.equal(s.issues.find(i => i.id === 'stack').found, true);
  assert.equal(s.issues.find(i => i.id === 'sqli').foundSeverity, 'Critical');
  assert.equal(s.format.verdictFirstLine, false); // the old prompts never asked for a VERDICT: line
});

test('splitBlocks: bold-only severity headings open a section and other bold-only headings close it', () => {
  const text = ['**Verdict: Do not ship.** x', '', '**Critical**', '1. **A** at a.js:1', '2. **B** at b.js:2', '**High**', '3. **C** at c.js:3', '**Low**', '- minor', '', '**Personal data (DPDP)**', 'prose that is not a finding', '**Not checked**', '- x'].join('\n');
  const blocks = splitBlocks(text);
  assert.deepEqual(blocks.map(b => b.severity), ['Critical', 'Critical', 'High', 'Low']);
  assert.doesNotMatch(blocks[3].text, /prose/);
});

test('extractCitations validates the file and the line against the fixture', () => {
  const c = extractCitations('See src/routes/auth.js:26, `src/server.js`:17, ./src/config.js:4-5, src/nope.js:3, src/server.js:99, auth.js:3, products.js:12 and https://example.test/a.js:5, Node.js:18.', FILES);
  const by = Object.fromEntries(c.map(x => [x.raw, x]));
  assert.equal(by['src/routes/auth.js:26'].valid, true);
  assert.equal(by['src/server.js:17'].valid, true);
  assert.equal(by['src/config.js:4-5'].valid, true);
  assert.equal(by['src/nope.js:3'].valid, false);
  assert.equal(by['src/server.js:99'].valid, false); // line past the end of the file
  assert.equal(by['auth.js:3'].valid, false); // ambiguous bare name: two files end with auth.js
  assert.equal(by['products.js:12'].valid, true); // unique bare name
  assert.equal(c.length, 7); // the URL and Node.js are not citations
});

test('scoreReport: recall, found-via, citation validity and hallucinated citations', () => {
  const s = scoreReport({ report: GOOD, expected: EXPECTED, files: FILES, variant: 'new' });
  assert.equal(s.planted, 4);
  assert.equal(s.found, 3);
  assert.equal(s.recall, 0.75);
  assert.deepEqual(s.issues.map(i => [i.id, i.found]), [['sqli', true], ['jwt', true], ['stack', true], ['rand', false]]);
  assert.equal(s.issues[0].foundSeverity, 'Critical');
  assert.equal(s.criticalHighPlanted, 3);
  assert.equal(s.criticalHighFound, 2);
  assert.ok(Math.abs(s.criticalHighRecall - 2 / 3) < 1e-9);
  // citations: products.js:20 ok, config.js:4 ok, /tmp/x/repo/src/server.js:17 ok, server.js:99999 bad, server.js:1 ok
  assert.equal(s.citations.total, 5);
  assert.equal(s.citations.hallucinated, 1);
  assert.equal(s.citations.validity, 0.8);
  assert.equal(s.extraFindings, 1); // the [Low] helmet block matches no planted issue
  assert.equal(s.extraTitles.length, 1);
});

test('a keyword in a block that cites a different file is not a hit; the file may also be named just before the block', () => {
  const wrongFile = '[High] Sloppy randomness — src/server.js:3\nMath.random is used.\n';
  assert.equal(scoreReport({ report: wrongFile, expected: EXPECTED, files: FILES }).issues.find(i => i.id === 'rand').found, false);
  const near = '### src/routes/auth.js\n[High] Predictable token\nMath.random() builds the reset token.\n';
  const r = scoreReport({ report: near, expected: EXPECTED, files: FILES }).issues.find(i => i.id === 'rand');
  assert.equal(r.found, true);
  assert.equal(r.via, 'near');
  const own = scoreReport({ report: GOOD, expected: EXPECTED, files: FILES }).issues.find(i => i.id === 'sqli');
  assert.equal(own.via, 'block');
  // alsoFiles: citing src/auth.js is enough for the JWT issue
  const also = '[High] Fallback secret — src/auth.js:3\nhard-coded fallback.\n';
  assert.equal(scoreReport({ report: also, expected: EXPECTED, files: FILES }).issues.find(i => i.id === 'jwt').found, true);
});

test('a block that says it but names no expected file is a content-only hit, not a strict one', () => {
  const report = '[High] Reset tokens are guessable — no file named\nMath.random() is used for the token.\n';
  const s = scoreReport({ report, expected: EXPECTED, files: FILES });
  assert.equal(s.found, 0);
  assert.equal(s.looseFound, 1);
  assert.equal(s.looseRecall, 0.25);
  assert.equal(s.issues.find(i => i.id === 'rand').looseFound, true);
});

test('severity sanity counts planted Critical/High issues rated Critical/High', () => {
  const report = '[Medium] Hard-coded fallback secret — src/config.js:4\n\n[Critical] SQL injection — src/routes/products.js:20\nstring concatenation\n';
  const s = scoreReport({ report, expected: EXPECTED, files: FILES });
  assert.equal(s.severity.checked, 2);
  assert.equal(s.severity.ok, 1);
  assert.equal(s.severity.sanity, 0.5);
  assert.equal(scoreReport({ report: 'nothing', expected: EXPECTED, files: FILES }).severity.sanity, null);
});

test('the severity attributed to an issue comes from the block most about it, not from a combined block that merely mentions it', () => {
  const report = [
    '[High] Reset tokens are predictable and nothing limits guesses — src/routes/auth.js:26',
    'Math.random() builds the token; a SQL injection concatenation elsewhere makes it worse.',
    '',
    '[Low] Error handler returns the stack trace — src/server.js:17',
    'err.stack is sent back.',
  ].join('\n');
  const s = scoreReport({ report, expected: EXPECTED, files: FILES });
  assert.equal(s.issues.find(i => i.id === 'stack').foundSeverity, 'Low');
  assert.equal(s.issues.find(i => i.id === 'rand').foundSeverity, 'High');
});

test('format compliance: VERDICT first line, rubric labels, What I did not check section', () => {
  const good = scoreReport({ report: GOOD, expected: EXPECTED, files: FILES }).format;
  assert.deepEqual([good.verdictFirstLine, good.rubricLabels, good.notChecked, good.compliant], [true, true, true, true]);
  const bad = scoreReport({ report: '**Verdict:** Approve with changes\n\n[Major] thing — src/server.js:1\n\n## What I checked\nx\n', expected: EXPECTED, files: FILES }).format;
  assert.deepEqual([bad.verdictFirstLine, bad.rubricLabels, bad.notChecked, bad.compliant], [false, false, false, false]);
  const lateVerdict = scoreReport({ report: 'Intro\nVERDICT: block\n[High] a\n## What I did not check\nx', expected: [], files: FILES }).format;
  assert.equal(lateVerdict.verdictFirstLine, false);
  const boldVerdict = scoreReport({ report: '**VERDICT: approve-with-changes**\n[High] a\n## What I did not check\nx', expected: [], files: FILES }).format;
  assert.equal(boldVerdict.verdictFirstLine, true);
});

test('a report with no citations has null validity, and an empty report scores zero recall', () => {
  const s = scoreReport({ report: '', expected: EXPECTED, files: FILES });
  assert.equal(s.recall, 0);
  assert.equal(s.citations.validity, null);
  assert.equal(s.citations.total, 0);
});

test('aggregate and aggregateRuns give n, min, mean, max and ignore errored runs', () => {
  assert.deepEqual(aggregate([1, 0.5, null]), { n: 2, min: 0.5, mean: 0.75, max: 1 });
  assert.deepEqual(aggregate([]), { n: 0, min: null, mean: null, max: null });
  const run = (variant, recall, extra = {}) => ({ role: 'rbe', variant, status: 'ok', score: { recall, criticalHighRecall: recall, citations: { validity: 1, hallucinated: 0 }, extraFindings: 1, severity: { sanity: 1 }, format: { compliant: variant === 'new' } }, wallMs: 1000, tools: 4, usage: { input_tokens: 10, output_tokens: 5 }, ...extra });
  const agg = aggregateRuns([run('old', 0.5), run('old', 0.75), run('new', 1), { role: 'rbe', variant: 'new', status: 'errored', error: 'x' }]);
  assert.equal(agg.rbe.old.recall.mean, 0.625);
  assert.equal(agg.rbe.old.recall.min, 0.5);
  assert.equal(agg.rbe.new.recall.n, 1);
  assert.equal(agg.rbe.new.errored, 1);
  assert.equal(agg.rbe.new.formatCompliance, 1);
  assert.equal(agg.rbe.old.formatCompliance, 0);
  assert.equal(agg.rbe.old.tools.mean, 4);
});

// ---------- argument parsing and the call cap ----------
test('parseArgs: defaults, lists, and strict errors', () => {
  const d = parseArgs([]);
  assert.equal(d.maxCalls, 14);
  assert.equal(d.repeat, 2);
  assert.deepEqual(d.roles, ['rbe', 'rfe', 'raws']);
  assert.deepEqual(d.variants, ['old', 'new']);
  assert.equal(d.yes, false);
  const o = parseArgs(['--roles', 'rbe,raws', '--variants', 'new', '--repeat', '1', '--max-calls', '4', '--dry-run', '--yes-spend-quota', '--label', 'round 2', '--append']);
  assert.deepEqual([o.roles, o.variants, o.repeat, o.maxCalls, o.dryRun, o.yes, o.label, o.append], [['rbe', 'raws'], ['new'], 1, 4, true, true, 'round 2', true]);
  for (const bad of [['--nope'], ['--roles', 'xyz'], ['--variants', 'older'], ['--repeat', '0'], ['--max-calls', 'abc'], ['--max-calls', '-1'], ['--roles'], ['stray']]) {
    assert.throws(() => parseArgs(bad), /./, JSON.stringify(bad));
  }
});

test('buildMatrix orders by repeat, then role, then variant, and maps each role to its fixture', () => {
  const m = buildMatrix({ roles: ['rbe', 'rfe'], variants: ['old', 'new'], repeat: 2 });
  assert.equal(m.length, 8);
  assert.deepEqual(m.slice(0, 4).map(c => `${c.role}/${c.variant}/${c.rep}`), ['rbe/old/1', 'rbe/new/1', 'rfe/old/1', 'rfe/new/1']);
  assert.equal(m[0].fixture, 'express-api');
  assert.equal(m[2].fixture, 'react-app');
  assert.equal(ROLE_TASKS.raws.fixture, 'aws-infra');
  assert.deepEqual(Object.keys(FIXTURES).sort(), ['aws-infra', 'express-api', 'react-app']);
});

test('executeMatrix stops at --max-calls and reports the cells it skipped', async () => {
  const cells = buildMatrix({ roles: ['rbe', 'rfe', 'raws'], variants: ['old', 'new'], repeat: 2 });
  assert.equal(cells.length, 12);
  const seen = [];
  const out = await executeMatrix(cells, { maxCalls: 5, runOne: async c => { seen.push(c); return { ...c, status: 'ok' }; } });
  assert.equal(seen.length, 5);
  assert.equal(out.calls, 5);
  assert.equal(out.capped, true);
  assert.equal(out.skipped.length, 7);
  const full = await executeMatrix(cells, { maxCalls: 14, runOne: async c => ({ ...c, status: 'ok' }) });
  assert.equal(full.capped, false);
  assert.equal(full.calls, 12);
});

test('executeMatrix counts errored calls, and stops after a rate-limit error instead of retrying', async () => {
  const cells = buildMatrix({ roles: ['rbe', 'rfe'], variants: ['old', 'new'], repeat: 1 });
  let n = 0;
  const out = await executeMatrix(cells, {
    maxCalls: 14,
    runOne: async c => {
      n++;
      if (n === 2) return { ...c, status: 'errored', error: "You've hit your usage limit" };
      return { ...c, status: 'ok' };
    },
  });
  assert.equal(out.calls, 2);
  assert.equal(out.stoppedBy, 'rate-limit');
  assert.equal(out.skipped.length, 2);
  assert.equal(isRateLimitError("You've hit your usage limit"), true);
  assert.equal(isRateLimitError('429 rate limit exceeded'), true);
  assert.equal(isRateLimitError('claude exited 1'), false);
  // another kind of error does not stop the run
  const out2 = await executeMatrix(cells, { maxCalls: 14, runOne: async c => ({ ...c, status: 'errored', error: 'boom' }) });
  assert.equal(out2.calls, 4);
  assert.equal(out2.stoppedBy, null);
});

test('stepPrompt uses the orchestrator format with no worktree or base lines', () => {
  assert.equal(stepPrompt('Do it.'), "<step>\nDo it.\n</step>\n\nOwner's original request:\n<task>\nDo it.\n</task>");
});

// ---------- the script itself ----------
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 20000 });

test('script: --help and --list make no calls and exit 0', () => {
  const h = run('--help');
  assert.equal(h.status, 0);
  assert.match(h.stdout, /--yes-spend-quota/);
  const l = run('--list');
  assert.equal(l.status, 0);
  assert.match(l.stdout, /express-api/);
  assert.match(l.stdout, /rbe/);
});

test('script: --dry-run prints the matrix and the call estimate without spending', () => {
  const r = run('--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /12 claude -p call/);
  assert.match(r.stdout, /dry run/i);
  assert.match(r.stdout, /rbe\s+express-api\s+old/);
});

test('script: real runs are refused without --yes-spend-quota, and unknown arguments exit 2', () => {
  const r = run();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--yes-spend-quota/);
  const u = run('--bogus');
  assert.equal(u.status, 2);
  assert.match(u.stderr, /unknown argument/i);
});

test('script: importing the module runs nothing', async () => {
  const before = process.exitCode;
  await import('../scripts/eval-prompts.mjs');
  assert.equal(process.exitCode, before);
});

// ---------- redaction ----------
test('redactText removes home paths, the temp directory, e-mail addresses and the user name', () => {
  const t = redactText('see /Users/jane.doe/Projects/x/a.js and /private/var/folders/ab/T/floorhands-eval-1/repo/src/a.js:3 mail jane@example.org home=/home/jane', { tempDirs: ['/private/var/folders/ab/T/floorhands-eval-1'], names: ['jane.doe'] });
  assert.doesNotMatch(t, /jane|Users|\/home\/|example\.org|folders/);
  assert.match(t, /<fixture>\/repo\/src\/a\.js:3/);
  assert.deepEqual(redactDeep({ a: ['/Users/bob/x'], b: 1 }), { a: ['~/x'], b: 1 });
});

// ---------- fixtures and expected findings ----------
const FORBIDDEN = /vulnerab|planted|insecure|fixme|todo|bug/i;

for (const [name, spec] of Object.entries(FIXTURES)) {
  test(`fixture ${name}: at most 12 files, expected findings point at real files and lines, nothing labelled`, () => {
    const dir = path.join(EVAL, 'fixtures', name);
    const files = fixtureFiles(dir);
    const names = Object.keys(files);
    assert.ok(names.length > 0 && names.length <= 12, `${names.length} files`);
    const expected = loadExpected(path.join(EVAL, 'expected', `${name}.json`));
    assert.ok(expected.length >= 6);
    const ids = new Set();
    for (const e of expected) {
      assert.ok(!ids.has(e.id), `duplicate id ${e.id}`);
      ids.add(e.id);
      assert.match(e.severity, /^(Critical|High|Medium|Low)$/);
      assert.ok(files[e.file], `${e.id}: ${e.file} is not in the fixture`);
      for (const f of e.alsoFiles ?? []) assert.ok(files[f], `${e.id}: alsoFile ${f} is not in the fixture`);
      const [a, b] = e.linesHint;
      assert.ok(Number.isInteger(a) && Number.isInteger(b) && a >= 1 && a <= b && b <= files[e.file], `${e.id}: linesHint ${a}-${b} outside ${e.file} (${files[e.file]} lines)`);
      assert.ok(Array.isArray(e.anyOf) && e.anyOf.length > 0);
      for (const r of e.anyOf) assert.doesNotThrow(() => new RegExp(r, 'i'), `${e.id}: bad regex ${r}`);
    }
    for (const rel of names) {
      const text = fs.readFileSync(path.join(dir, rel), 'utf8');
      assert.doesNotMatch(text, FORBIDDEN, `${name}/${rel} contains a labelling word`);
      assert.doesNotMatch(rel, FORBIDDEN);
      // no real secrets, e-mail addresses or home paths
      assert.doesNotMatch(text, /[\w.+-]+@[\w-]+\.[a-z]{2,}/i, `${name}/${rel} has an e-mail address`);
      assert.doesNotMatch(text, /\/(Users|home)\/[\w.-]+/, `${name}/${rel} has a home path`);
      assert.doesNotMatch(text, /AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|sk_live_|xox[bp]-/, `${name}/${rel} looks like a real secret`);
    }
    assert.equal(ROLE_TASKS[Object.keys(ROLE_TASKS).find(r => ROLE_TASKS[r].fixture === name)].fixture, name);
    assert.ok(spec.title);
  });
}

test('express-api and react-app fixtures define the scripts the plan names', () => {
  const read = n => JSON.parse(fs.readFileSync(path.join(EVAL, 'fixtures', n, 'package.json'), 'utf8'));
  for (const s of ['lint', 'test']) assert.ok(read('express-api').scripts[s]);
  for (const s of ['lint', 'build', 'test']) assert.ok(read('react-app').scripts[s]);
});

test('every planted issue is spelled the way a correct finding would be (self-check against a model answer)', () => {
  // Each expected entry must match a block that quotes its own planted line, so a dead regex cannot hide as a "miss".
  for (const [name] of Object.entries(FIXTURES)) {
    const expected = loadExpected(path.join(EVAL, 'expected', `${name}.json`));
    const files = fixtureFiles(path.join(EVAL, 'fixtures', name));
    for (const e of expected) {
      assert.ok(e.sample, `${e.id}: expected entries carry a one-line model finding in "sample"`);
      const report = `[${e.severity}] ${e.sample} — ${e.file}:${e.linesHint[0]}\n`;
      const s = scoreReport({ report, expected: [e], files });
      assert.equal(s.found, 1, `${name}/${e.id}: the model finding "${e.sample}" does not match its own anyOf`);
    }
  }
});

// ---------- baseline fidelity ----------
test('the baseline copies are byte-identical to v0.1.0 on main and compose to the exact v0.1.0 system prompts', { timeout: 60000 }, async t => {
  let hasMain = true;
  try { execFileSync('git', ['rev-parse', '--verify', '-q', 'main^{commit}'], { cwd: ROOT, stdio: 'ignore' }); } catch { hasMain = false; }
  if (!hasMain) return t.skip('no main branch in this checkout');
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'floorhands-baseline-')));
  try {
    const tar = path.join(tmp, 'main.tar');
    execFileSync('git', ['archive', '--format=tar', '-o', tar, 'main'], { cwd: ROOT });
    const co = path.join(tmp, 'v010');
    fs.mkdirSync(co);
    execFileSync('tar', ['-x', '-f', tar, '-C', co]);
    const base = path.join(EVAL, 'baseline', 'agents');
    for (const f of [...fs.readdirSync(path.join(co, 'agents', 'prompts')).map(n => path.join('prompts', n)), 'roster.json']) {
      assert.equal(fs.readFileSync(path.join(base, f), 'utf8'), fs.readFileSync(path.join(co, 'agents', f), 'utf8'), `${f} differs from main`);
    }
    assert.deepEqual(fs.readdirSync(path.join(base, 'prompts')).sort(), fs.readdirSync(path.join(co, 'agents', 'prompts')).sort());
    // that checkout's own loadRoster is the reference
    const ref = await import(path.join(co, 'server', 'roster.js'));
    const real = ref.loadRoster(path.join(co, 'agents'));
    const legacy = loadLegacyRoster(base);
    assert.equal(legacy.agents.length, real.agents.length);
    assert.ok(real.agents.length >= 9);
    for (const a of real.agents) {
      assert.equal(legacy.byId[a.id].system, a.system, `${a.id}: legacy composition differs from v0.1.0`);
      assert.ok(a.system.length > 500);
    }
    assert.match(legacy.byId.rbe.system, /Claude skills to call with the Skill tool when they apply: security-review/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

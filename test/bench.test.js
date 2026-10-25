import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../scripts/bench.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BENCH = path.join(ROOT, 'scripts', 'bench.mjs');
const made = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

test('parseArgs validates variant, task and run count', () => {
  assert.equal(parseArgs(['run', '--variant', 'single', '--task', 'build', '--runs', '3']).runs, 3);
  assert.throws(() => parseArgs(['run', '--variant', 'gpt']), /--variant/);
  assert.throws(() => parseArgs(['run', '--task', 'deploy']), /--task/);
  assert.throws(() => parseArgs(['run', '--runs', '100']), /--runs/);
  assert.throws(() => parseArgs(['run', '--bogus']), /unknown option/);
});

test('run refuses to spend quota without the explicit flag, and grade refuses to run project code unguarded', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-work-'));
  made.push(work);
  const corpus = path.join(ROOT, 'eval', 'bench', 'corpus.example.json');
  const r = (...a) => { try { execFileSync(process.execPath, [BENCH, ...a], { encoding: 'utf8', stdio: 'pipe' }); return ''; } catch (e) { return String(e.stderr); } };
  assert.match(r('run', '--corpus', corpus, '--work', work, '--variant', 'single', '--task', 'build'), /--yes-spend-quota/);
  assert.match(r('grade', '--corpus', corpus, '--work', work), /--docker .* or --trust-local/);
});

// The whole pipeline offline: a hand-made "prepared" instance whose hidden test fails until a file says fixed, the fake claude CLI
// (whose builder writes FLOORHANDS_DEMO.md), local grading, and the report. Checks the plumbing, not any model.
test('run, grade and report work end to end with the fake CLI', () => {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bench-work-')));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-home-'));
  made.push(work, home);
  const id = 'demo-note';
  const inst = path.join(work, 'instances', id);
  const buggy = path.join(inst, 'buggy');
  fs.mkdirSync(path.join(inst, 'hidden', 'test'), { recursive: true });
  fs.mkdirSync(buggy, { recursive: true });
  fs.writeFileSync(path.join(buggy, 'package.json'), JSON.stringify({ name: 'demo', private: true, scripts: { test: 'node --test' } }));
  fs.mkdirSync(path.join(buggy, 'test'));
  fs.writeFileSync(path.join(buggy, 'test', 'ok.test.js'), "import test from 'node:test'; test('ok', () => {});\n");
  fs.writeFileSync(path.join(inst, 'hidden', 'test', 'note.test.js'),
    "import test from 'node:test'; import fs from 'node:fs'; import assert from 'node:assert';\ntest('note', () => assert.ok(fs.existsSync('FLOORHANDS_DEMO.md')));\n");
  const sh = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: buggy });
  sh('init', '-q', '-b', 'main'); sh('add', '-A'); sh('commit', '-q', '-m', 'buggy');
  fs.writeFileSync(path.join(inst, 'meta.json'), JSON.stringify({ id }));
  const corpus = path.join(work, 'corpus.json');
  fs.writeFileSync(corpus, JSON.stringify({ instances: [{
    id, repo: 'https://github.com/example/demo', fixCommit: 'b'.repeat(40), sourceFiles: ['FLOORHANDS_DEMO.md'], testFiles: ['test/note.test.js'],
    testCommand: ['npm', 'test'], tasks: { review: 'Review it.', build: 'Add the demo note.' }, bug: 'the note is missing',
  }] }));
  const env = { ...process.env, FLOORHANDS_CLAUDE_BIN: path.join(ROOT, 'scripts', 'fake-claude.mjs'), FLOORHANDS_HOME: home };
  delete env.FLOORHANDS_AGENT;
  const bench = (...a) => execFileSync(process.execPath, [BENCH, ...a], { encoding: 'utf8', env, cwd: work });
  bench('run', '--corpus', corpus, '--work', work, '--variant', 'floorhands', '--task', 'build', '--runs', '2', '--yes-spend-quota');
  bench('run', '--corpus', corpus, '--work', work, '--variant', 'single', '--task', 'build', '--runs', '1', '--yes-spend-quota');
  const rows = fs.readFileSync(path.join(work, 'results.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(rows.map(r => [r.variant, r.run, r.status]), [['floorhands', 1, 'awaiting_approval'], ['floorhands', 2, 'awaiting_approval'], ['single', 1, 'done']]);
  assert.ok(rows[0].steps.some(s => s.class === 'standard'), 'routing recorded per step');
  bench('grade', '--corpus', corpus, '--work', work, '--trust-local');
  const graded = fs.readFileSync(path.join(work, 'graded.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(graded.map(r => r.hiddenTestsPass), [true, true, true], graded.map(r => r.gradeNote).join(' | '));
  const out = bench('report', '--work', work);
  assert.match(out, /\| build \| floorhands \| 100%/);
  assert.match(out, /Judge not calibrated/);

  // Negative control: the untouched buggy state must FAIL the hidden tests, or the grader proves nothing.
  fs.writeFileSync(path.join(work, 'results.jsonl'), JSON.stringify({ instance: id, variant: 'single', task: 'build', run: 1, status: 'done' }) + '\n');
  bench('grade', '--corpus', corpus, '--work', work, '--trust-local');
  const control = JSON.parse(fs.readFileSync(path.join(work, 'graded.jsonl'), 'utf8').trim());
  assert.equal(control.hiddenTestsPass, false);
});

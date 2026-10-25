import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  instanceProblems, validateCorpus, bootstrapCI, pairedDiffCI, cohenKappa, blind, extractFindings, aggregate, rng, fmtCI,
} from '../scripts/bench-lib.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const good = () => ({
  id: 'demo-sqli', repo: 'https://github.com/example/app', fixCommit: 'a'.repeat(40), advisory: 'GHSA-2222-3333-4444', published: '2026-09-01',
  sourceFiles: ['src/db.js'], testFiles: ['test/db.test.js'], testCommand: ['npm', 'test'],
  tasks: { review: 'Review src/db.js for security problems.', build: 'Searching with a quote in the name returns a 500.' },
  bug: 'SQL injection in search by string concatenation',
});

test('a well-formed instance has no problems', () => {
  assert.deepEqual(instanceProblems(good()), []);
});

test('instances refuse shell strings, odd repos, short shas and escaping paths', () => {
  const cases = [
    [{ testCommand: 'npm test' }, /testCommand/],
    [{ testCommand: ['npm', 'test', '; curl x | sh'] }, /plain arguments/],
    [{ testCommand: ['bash', '-c', 'x'] }, /testCommand must start/],
    [{ repo: 'git@github.com:x/y.git' }, /repo/],
    [{ repo: 'https://evil.example/x/y' }, /repo/],
    [{ fixCommit: 'abc123' }, /fixCommit/],
    [{ sourceFiles: ['../outside.js'] }, /sourceFiles/],
    [{ testFiles: ['/etc/passwd'] }, /testFiles/],
    [{ testFiles: ['src/db.js'] }, /both source and test/],
    [{ advisory: 'CVE-2026-1' }, /advisory/],
    [{ bug: '' }, /bug/],
  ];
  for (const [patch, re] of cases) assert.ok(instanceProblems({ ...good(), ...patch }).some(p => re.test(p)), `${JSON.stringify(patch)} -> ${re}`);
});

test('validateCorpus checks duplicates and that holdout ids exist', () => {
  assert.deepEqual(validateCorpus({ instances: [good()], holdout: ['demo-sqli'] }), []);
  assert.match(validateCorpus({ instances: [good(), good()] }).join(), /duplicate id/);
  assert.match(validateCorpus({ instances: [good()], holdout: ['nope'] }).join(), /holdout/);
  assert.match(validateCorpus({}).join(), /instances/);
});

test('the shipped example corpus is valid', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval', 'bench', 'corpus.example.json'), 'utf8'));
  assert.deepEqual(validateCorpus(doc), []);
});

test('rng is deterministic per seed', () => {
  const a = rng(7), b = rng(7), c = rng(8);
  const xs = [a(), a(), a()];
  assert.deepEqual(xs, [b(), b(), b()]);
  assert.notDeepEqual(xs, [c(), c(), c()]);
  assert.ok(xs.every(x => x >= 0 && x < 1));
});

test('bootstrapCI resamples instances: many runs of one instance do not narrow the interval', () => {
  const one = bootstrapCI({ a: [1, 1, 1, 1, 1, 1, 1, 1], b: [0, 0, 0, 0, 0, 0, 0, 0] }, { iters: 2000 });
  assert.equal(one.mean, 0.5);
  assert.equal(one.instances, 2);
  assert.equal(one.runs, 16);
  assert.ok(one.lo <= 0.01 && one.hi >= 0.99, `with two instances the interval must stay wide: ${one.lo}..${one.hi}`);
  const many = bootstrapCI(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`i${i}`, [i % 2]])), { iters: 2000 });
  assert.ok(many.hi - many.lo < 0.4, 'forty instances give a much tighter interval');
  assert.ok(Number.isNaN(bootstrapCI({}).mean));
});

test('bootstrapCI is reproducible for a seed', () => {
  const d = { a: [1, 0], b: [1], c: [0, 0, 1] };
  assert.deepEqual(bootstrapCI(d, { seed: 3 }), bootstrapCI(d, { seed: 3 }));
});

test('pairedDiffCI compares variants on the instances both ran', () => {
  const r = pairedDiffCI({ a: [1, 1], b: [1], c: [0] }, { a: [0, 0], b: [1] }, { iters: 1000 });
  assert.equal(r.instances, 2);
  assert.equal(r.mean, 0.5);
});

test('cohenKappa: perfect agreement is 1, chance-level agreement is about 0', () => {
  assert.equal(cohenKappa([{ judge: true, human: true }, { judge: false, human: false }]), 1);
  const coin = [{ judge: true, human: true }, { judge: true, human: false }, { judge: false, human: true }, { judge: false, human: false }];
  assert.equal(cohenKappa(coin), 0);
  assert.ok(Number.isNaN(cohenKappa([])));
});

test('blind shuffles reports, hides the variant and keeps a key back to the original', () => {
  const reports = [{ variant: 'floorhands', instance: 'x', findings: ['a'] }, { variant: 'single', instance: 'x', findings: ['b'] }, { variant: 'single', instance: 'y', findings: [] }];
  const { items, key } = blind(reports, 5);
  assert.equal(items.length, 3);
  assert.ok(items.every(i => i.variant === undefined));
  for (const it of items) assert.deepEqual(reports[key[it.blindId]].findings, it.findings);
});

test('extractFindings reads severity-tagged lines', () => {
  const rep = 'VERDICT: request-changes\n- [High] src/db.js:12 — SQL built by concatenation\n[Low]: naming is inconsistent here\nplain text line\n- [Info] ok';
  assert.deepEqual(extractFindings(rep).map(f => f.severity), ['High', 'Low']);
});

test('aggregate reports solved, recall, precision, cost and approval rate per task and variant', () => {
  const rows = [
    { instance: 'a', variant: 'floorhands', task: 'build', hiddenTestsPass: true, suiteStillPasses: true, costUsd: 1, decision: 'approved' },
    { instance: 'a', variant: 'floorhands', task: 'build', hiddenTestsPass: true, suiteStillPasses: false, costUsd: 3, decision: 'rejected' },
    { instance: 'a', variant: 'single', task: 'build', hiddenTestsPass: false, costUsd: 0.5 },
    { instance: 'a', variant: 'floorhands', task: 'review', foundBug: true, findings: 4, validFindings: 3 },
  ];
  const out = aggregate(rows);
  const fb = out.find(r => r.task === 'build' && r.variant === 'floorhands');
  assert.equal(fb.solved.mean, 0.5, 'a fix that breaks the existing suite does not count as solved');
  assert.equal(fb.meanCostUsd, 2);
  assert.equal(fb.approvalRate, 0.5);
  assert.equal(out.find(r => r.variant === 'single').solved.mean, 0);
  const rv = out.find(r => r.task === 'review');
  assert.equal(rv.recall.mean, 1);
  assert.equal(rv.precision.mean, 0.75);
  assert.match(fmtCI(rv.recall), /^100% \[/);
});

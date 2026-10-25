import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compare, baselineVerdicts } from '../scripts/probe-compare.mjs';

const DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const res = (...rows) => ({ results: rows.map(([name, verdict]) => ({ name, verdict })) });

test('the best verdict across merged baseline runs counts', () => {
  const b = baselineVerdicts([res(['a', 'INCONCLUSIVE'], ['a', 'PASS'], ['b', 'KNOWN LIMIT'])]);
  assert.equal(b.get('a'), 'PASS');
  assert.equal(b.get('b'), 'KNOWN LIMIT');
});

test('a PASS that becomes INCONCLUSIVE or FAIL is a regression', () => {
  const base = [res(['a', 'PASS'], ['b', 'PASS'])];
  const r = compare(res(['a', 'INCONCLUSIVE'], ['b', 'FAIL']), base);
  assert.equal(r.ok, false);
  assert.equal(r.regressions.length, 2);
});

test('known limits stay allowed only where recorded; new probes must pass', () => {
  const base = [res(['k', 'KNOWN LIMIT'], ['p', 'PASS'])];
  assert.equal(compare(res(['k', 'KNOWN LIMIT'], ['p', 'PASS']), base).ok, true);
  assert.equal(compare(res(['p', 'KNOWN LIMIT']), base).ok, false);
  const r = compare(res(['new-one', 'INCONCLUSIVE'], ['new-two', 'FAIL']), base);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.regressions.length, 1);
});

test('a known limit that now passes is reported as fixed', () => {
  assert.deepEqual(compare(res(['k', 'PASS']), [res(['k', 'KNOWN LIMIT'])]).fixed.length, 1);
});

test('the committed baselines load and compare cleanly against themselves', () => {
  const docs = ['spike-results.json', 'spike-results-round2.json'].map(f => JSON.parse(fs.readFileSync(path.join(DOCS, f), 'utf8')));
  const best = baselineVerdicts(docs);
  const self = { results: [...best].map(([name, verdict]) => ({ name, verdict })) };
  const r = compare(self, docs);
  assert.deepEqual(r.regressions, []);
  // skill-names is a functional FAIL recorded in round 1 that depends on installed plugins: a warning, not a regression.
  assert.deepEqual(r.warnings.map(l => l.split(':')[0]), ['skill-names']);
});

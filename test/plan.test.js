import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan, MAX_STEPS } from '../server/plan.js';

const F = '`'.repeat(3);
const ids = ['rfe', 'fe', 'e2e'];

test('parses a fenced json plan', () => {
  const text = `Here is the plan.\n${F}json\n{"summary":"Do it","steps":[{"agent":"fe","task":"Build"},{"agent":"rfe","task":"Review"}]}\n${F}\nDone.`;
  const p = parsePlan(text, ids);
  assert.equal(p.summary, 'Do it');
  assert.deepEqual(p.steps, [{ agent: 'fe', task: 'Build' }, { agent: 'rfe', task: 'Review' }]);
  assert.deepEqual(p.problems, []);
});

test('parses bare json and skips earlier non-json fences', () => {
  const text = `${F}python\nprint({})\n${F}\n${F}\n{"summary":"s","steps":[{"agent":"e2e","task":"Run tests"}]}\n${F}`;
  assert.equal(parsePlan(text, ids).steps[0].agent, 'e2e');
  assert.equal(parsePlan('{"summary":"s","steps":[{"agent":"fe","task":"x"}]}', ids).steps.length, 1);
});

test('a direct answer with no steps is a valid plan', () => {
  const p = parsePlan('{"summary":"It is a static site on S3.","steps":[]}', ids);
  assert.equal(p.steps.length, 0);
  assert.match(p.summary, /static site/);
});

test('drops unknown agents and empty tasks but keeps going', () => {
  const p = parsePlan('{"summary":"s","steps":[{"agent":"ghost","task":"x"},{"agent":"fe","task":"  "},{"agent":"rfe","task":"ok"}]}', ids);
  assert.deepEqual(p.steps, [{ agent: 'rfe', task: 'ok' }]);
  assert.equal(p.problems.length, 2);
  assert.match(p.problems[0], /unknown agent "ghost"/);
  assert.match(p.problems[1], /step 2 for fe has no task/);
});

test('caps the number of steps', () => {
  const steps = Array.from({ length: MAX_STEPS + 3 }, (_, i) => ({ agent: 'fe', task: `t${i}` }));
  const p = parsePlan(JSON.stringify({ summary: 's', steps }), ids);
  assert.equal(p.steps.length, MAX_STEPS);
  assert.ok(p.problems.some(x => /more than/.test(x)));
});

test('throws readable errors for prose, broken json and empty plans', () => {
  assert.throws(() => parsePlan('I think you should refactor.', ids), /did not return a plan/);
  assert.throws(() => parsePlan('{"summary": "x", "steps": [}', ids), /not valid JSON/);
  assert.throws(() => parsePlan('{"summary":"","steps":[{"agent":"ghost","task":"x"}]}', ids), /no steps and no answer/);
});

test('summary as an object with a toString key does not throw a TypeError', () => {
  const p = parsePlan('{"summary":{"toString":1},"steps":[{"agent":"fe","task":"x"}]}', ids);
  assert.equal(p.summary, '');
  assert.equal(p.steps.length, 1);
  assert.match(p.problems[0], /summary is not a string/);
});

test('object summary and non-array steps with no valid plan throw "no steps and no answer"', () => {
  assert.throws(() => parsePlan('{"summary":{"a":1},"steps":"x"}', ids), /no steps and no answer/);
});

test('a task that is an object is dropped with a problem, never shown as [object Object]', () => {
  const p = parsePlan('{"summary":"s","steps":[{"agent":"fe","task":{"x":1}}]}', ids);
  assert.deepEqual(p.steps, []);
  assert.equal(p.problems.length, 1);
  assert.match(p.problems[0], /step 1 for fe has no task/);
  assert.ok(!p.problems[0].includes('[object Object]'));
});

test('non-object steps (null, number, string) are skipped with numbered problems', () => {
  const p = parsePlan('{"summary":"s","steps":[null,5,"x",{"agent":"fe","task":"ok"}]}', ids);
  assert.deepEqual(p.steps, [{ agent: 'fe', task: 'ok' }]);
  assert.equal(p.problems.length, 3);
  assert.match(p.problems[0], /step 1 is not an object/);
  assert.match(p.problems[1], /step 2 is not an object/);
  assert.match(p.problems[2], /step 3 is not an object/);
});

test('"__proto__" as an agent id is reported as an unknown agent', () => {
  const p = parsePlan('{"summary":"s","steps":[{"agent":"__proto__","task":"x"}]}', ids);
  assert.deepEqual(p.steps, []);
  assert.match(p.problems[0], /unknown agent "__proto__"/);
});

test('model-supplied agent text in a problem is capped at 40 characters', () => {
  const long = 'x'.repeat(100);
  const p = parsePlan(`{"summary":"s","steps":[{"agent":"${long}","task":"x"}]}`, ids);
  assert.equal(p.problems.length, 1);
  assert.ok(!/x{41}/.test(p.problems[0]));
});

test('an earlier non-plan js fence containing braces does not hide the json plan', () => {
  const text = `${F}js\n{ a: 1 }\n${F}\n${F}json\n{"summary":"ok","steps":[{"agent":"fe","task":"Build"}]}\n${F}`;
  const p = parsePlan(text, ids);
  assert.equal(p.summary, 'ok');
  assert.deepEqual(p.steps, [{ agent: 'fe', task: 'Build' }]);
});

test('non-string text throws the "did not return a plan" error', () => {
  assert.throws(() => parsePlan(undefined, ids), /did not return a plan/);
  assert.throws(() => parsePlan(42, ids), /did not return a plan/);
});

test('validIds that is not an array throws', () => {
  assert.throws(() => parsePlan('{"summary":"s","steps":[]}', 'fe'), /parsePlan needs a list of valid agent ids/);
});

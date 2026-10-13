import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, INJECTION_RE } from '../scripts/smoke.mjs';

const task = (output, over = {}) => ({ status: 'done', steps: [{ agent: 'rbe', output }], ...over });
const result = (checks, name) => checks.find(c => c[0] === name);

test('a review without an injection finding fails the injection check', () => {
  const checks = evaluate(task('No injection found. The file looks fine.'));
  assert.equal(result(checks, 'the review found the SQL injection')[1], false);
});

test('a review naming SQL injection passes the injection check', () => {
  const checks = evaluate(task('Critical: SQL injection via string concatenation in /user.'));
  assert.equal(result(checks, 'the review found the SQL injection')[1], true);
  assert.ok(checks.every(c => c[1]));
});

test('injection text in another agent output does not count', () => {
  const t = { status: 'done', steps: [{ agent: 'arch', output: 'SQL injection' }, { agent: 'rbe', output: 'all good' }] };
  assert.equal(result(evaluate(t), 'the review found the SQL injection')[1], false);
});

test('a failed task fails the first check', () => {
  const checks = evaluate(task('SQL injection', { status: 'failed', error: 'boom' }));
  assert.equal(checks[0][1], false);
  assert.equal(checks[0][2], 'boom');
});

test('a task without a back-end reviewer step fails the reviewer check', () => {
  const checks = evaluate({ status: 'done', steps: [{ agent: 'arch', output: 'SQL injection' }] });
  assert.equal(result(checks, 'the back-end reviewer was used')[1], false);
  assert.equal(result(checks, 'the review found the SQL injection')[1], false);
});

test('a dirty working copy fails its check; the regex needs SQL and injection close together', () => {
  assert.equal(result(evaluate(task('SQL injection'), { workingCopyClean: false }), 'the working copy was not modified')[1], false);
  assert.equal(INJECTION_RE.test('injection'), false);
});

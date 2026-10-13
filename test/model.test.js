import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivity, classifyDiff, classifyDiffLine, isAllowedAttr, isHandlerKey } from '../ui/model.js';

const ev = (phase, agent, taskId, extra = {}) => ({ type: 'agent', taskId, agent, phase, ...extra });

test('activity: start marks an agent working and end clears it', () => {
  const a = createActivity();
  assert.equal(a.isWorking('fe'), false);
  a.apply(ev('start', 'fe', 't1'));
  assert.equal(a.isWorking('fe'), true);
  a.apply(ev('end', 'fe', 't1'));
  assert.equal(a.isWorking('fe'), false);
});

test('activity: tool sets the chip text, strings only, and it clears when the agent finishes', () => {
  const a = createActivity();
  a.apply(ev('start', 'fe', 't1'));
  a.apply(ev('tool', 'fe', 't1', { tool: 'Read' }));
  assert.equal(a.tool('fe'), 'Read');
  a.apply(ev('tool', 'fe', 't1', { tool: 42 }));
  a.apply(ev('tool', 'fe', 't1', { tool: { x: 1 } }));
  assert.equal(a.tool('fe'), 'Read');
  a.apply(ev('end', 'fe', 't1'));
  assert.equal(a.tool('fe'), '');
});

test('activity: two concurrent tasks on one agent cannot clear each other', () => {
  const a = createActivity();
  a.apply(ev('start', 'fe', 't1'));
  a.apply(ev('start', 'fe', 't2'));
  a.apply(ev('end', 'fe', 't1'));
  assert.equal(a.isWorking('fe'), true);
  a.apply({ type: 'task', task: { id: 't1', status: 'done' } });
  assert.equal(a.isWorking('fe'), true);
  a.apply(ev('end', 'fe', 't2'));
  assert.equal(a.isWorking('fe'), false);
});

test('activity: a terminal task event clears that task, a non-terminal one does not', () => {
  for (const status of ['done', 'failed', 'approved', 'rejected', 'awaiting_approval']) {
    const a = createActivity();
    a.apply(ev('start', 'fe', 't1'));
    a.apply(ev('tool', 'fe', 't1', { tool: 'Edit' }));
    a.apply({ type: 'task', task: { id: 't1', status } });
    assert.equal(a.isWorking('fe'), false, status);
    assert.equal(a.tool('fe'), '', status);
  }
  for (const status of ['queued', 'planning', 'running']) {
    const a = createActivity();
    a.apply(ev('start', 'fe', 't1'));
    a.apply({ type: 'task', task: { id: 't1', status } });
    assert.equal(a.isWorking('fe'), true, status);
  }
});

test('activity: clearTask and clearAll', () => {
  const a = createActivity();
  a.apply(ev('start', 'fe', 't1'));
  a.apply(ev('start', 'be', 't1'));
  a.apply(ev('start', 'be', 't2'));
  a.clearTask('t1');
  assert.equal(a.isWorking('fe'), false);
  assert.equal(a.isWorking('be'), true);
  a.clearAll();
  assert.equal(a.isWorking('be'), false);
  assert.equal(a.tool('be'), '');
});

test('activity: hostile agent ids such as __proto__ are harmless', () => {
  const a = createActivity();
  a.apply(ev('start', '__proto__', 't1'));
  a.apply(ev('tool', '__proto__', 't1', { tool: 'Bash' }));
  assert.equal(a.isWorking('__proto__'), true);
  assert.equal(a.tool('__proto__'), 'Bash');
  for (const k of ['constructor', 'toString', 'hasOwnProperty', 'fe']) {
    assert.equal(a.isWorking(k), false, k);
    assert.equal(a.tool(k), '', k);
  }
  assert.equal({}.t1, undefined);
  assert.equal(Object.prototype.t1, undefined);
  a.apply(ev('end', '__proto__', 't1'));
  assert.equal(a.isWorking('__proto__'), false);
});

test('activity: malformed events are ignored', () => {
  const a = createActivity();
  for (const bad of [null, undefined, 7, 'x', {}, { type: 'agent' }, { type: 'agent', phase: 'start', agent: 5 }, { type: 'task' }, { type: 'task', task: null }]) a.apply(bad);
  assert.equal(a.isWorking('5'), false);
  assert.equal(a.isWorking('undefined'), false);
});

const DIFF = [
  'diff --git a/x.sql b/x.sql',
  'index 111..222 100644',
  '--- a/x.sql',
  '+++ b/x.sql',
  '@@ -1,3 +1,3 @@',
  ' keep',
  '-- a removed sql comment',
  '+added',
  '+++ looks like a header but is an added line',
  '\\ No newline at end of file',
  'diff --git a/y b/y',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/y',
  '@@ -0,0 +1 @@',
  '+hello',
].join('\n');

test('classifyDiff: headers are meta, hunks are hunk, +/- inside a hunk are add/del', () => {
  const out = classifyDiff(DIFF + '\n');
  const kinds = out.map(l => l.kind);
  assert.deepEqual(kinds, ['meta', 'meta', 'meta', 'meta', 'hunk', 'ctx', 'del', 'add', 'add', 'meta', 'meta', 'meta', 'meta', 'meta', 'hunk', 'add']);
  assert.equal(out[6].text, '-- a removed sql comment');
  assert.equal(out.length, 16, 'the trailing newline does not add a line');
});

test('classifyDiffLine threads state and resets it on a new file section', () => {
  const s = { inHunk: false };
  assert.equal(classifyDiffLine('--- a/f', s), 'meta');
  assert.equal(classifyDiffLine('@@ -1 +1 @@', s), 'hunk');
  assert.equal(classifyDiffLine('--- inside hunk', s), 'del');
  assert.equal(classifyDiffLine('diff --git a/g b/g', s), 'meta');
  assert.equal(classifyDiffLine('+++ b/g', s), 'meta');
  assert.equal(classifyDiffLine('', { inHunk: true }), 'ctx');
});

test('classifyDiff: empty input yields nothing', () => {
  assert.deepEqual(classifyDiff(''), []);
  assert.deepEqual(classifyDiff(undefined), []);
});

test('classifyDiff: renders at most 3000 lines, then a note with the remainder', () => {
  const lines = ['@@ -1 +1 @@'];
  for (let i = 0; i < 3499; i++) lines.push('+line ' + i);
  const out = classifyDiff(lines.join('\n'));
  assert.equal(out.length, 3001);
  assert.equal(out[2999].text, '+line 2998');
  assert.deepEqual(out[3000], { text: '… 500 more lines not shown', kind: 'meta' });
  assert.equal(classifyDiff(lines.slice(0, 3000).join('\n')).length, 3000, 'exactly 3000 lines needs no note');
});

test('make() attribute allowlist', () => {
  for (const ok of ['class', 'id', 'role', 'tabindex', 'type', 'for', 'title', 'placeholder', 'maxlength', 'rows', 'hidden', 'data-key', 'aria-label', 'aria-pressed', 'aria-live',
    'x', 'y', 'cx', 'cy', 'r', 'rx', 'width', 'height', 'viewBox', 'transform']) assert.equal(isAllowedAttr(ok), true, ok);
  for (const bad of ['style', 'href', 'src', 'srcdoc', 'onclick', 'onerror', 'xlink:href', 'data-x', 'aria-', 'aria-Label', '__proto__', 'constructor', 'formaction', 'action', 'ViewBox', '', 'class ']) assert.equal(isAllowedAttr(bad), false, bad);
  assert.equal(isAllowedAttr(undefined), false);
  assert.equal(isHandlerKey('onclick'), true);
  assert.equal(isHandlerKey('onkeydown'), true);
  for (const k of ['class', 'on', 'ONCLICK', 'on-click', 'x']) assert.equal(isHandlerKey(k), false, k);
});

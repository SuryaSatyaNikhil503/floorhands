import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTask, getTask, saveTask, listTasks, summary, appendEvent, recoverInterrupted, stateDir } from '../server/store.js';

const dirs = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'floorhands-store-'));
  dirs.push(d);
  return d;
};
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const tasksOf = root => path.join(stateDir(root), 'tasks');
const writeRaw = (root, name, body) => {
  fs.mkdirSync(tasksOf(root), { recursive: true });
  fs.writeFileSync(path.join(tasksOf(root), name), body);
};

test('creates, saves and reads back a task', () => {
  const root = tmp();
  const t = createTask(root, 'Review the contact form');
  assert.match(t.id, /^t-[a-z0-9-]+$/);
  assert.equal(t.status, 'queued');
  t.status = 'done';
  saveTask(root, t);
  assert.equal(getTask(root, t.id).status, 'done');
  assert.deepEqual(fs.readdirSync(path.join(stateDir(root), 'tasks')).filter(f => f.endsWith('.tmp')), []);
});

test('rejects ids that are not task ids (path traversal) and missing tasks', () => {
  const root = tmp();
  assert.equal(getTask(root, '../../etc/passwd'), null);
  assert.equal(getTask(root, 't-nope'), null);
});

test('lists newest first and skips corrupt files', () => {
  const root = tmp();
  const a = createTask(root, 'first');
  a.createdAt = '2026-01-01T00:00:00.000Z'; saveTask(root, a);
  const b = createTask(root, 'second');
  b.createdAt = '2026-02-01T00:00:00.000Z'; saveTask(root, b);
  fs.writeFileSync(path.join(stateDir(root), 'tasks', 't-broken.json'), '{not json');
  const list = listTasks(root);
  assert.deepEqual(list.map(s => s.text), ['second', 'first']);
  assert.equal(getTask(root, 't-broken'), null);
});

test('summary keeps only what the UI list needs', () => {
  const root = tmp();
  const t = createTask(root, 'x');
  t.steps = [{ agent: 'fe', task: 'long', status: 'done', output: 'big', tools: [] }];
  assert.deepEqual(summary(t).steps, [{ agent: 'fe', status: 'done', model: null, class: null }]);
  t.steps[0].route = { class: 'standard', model: 'sonnet', budgetUsd: 2 };
  assert.deepEqual(summary(t).steps, [{ agent: 'fe', status: 'done', model: 'sonnet', class: 'standard' }]);
  assert.equal(summary(t).events, undefined);
});

test('appendEvent keeps only the last 500 events', () => {
  const t = { events: [] };
  for (let i = 0; i < 520; i++) appendEvent(t, { n: i });
  assert.equal(t.events.length, 500);
  assert.equal(t.events[0].n, 20);
});

test('recoverInterrupted fails tasks that were mid-run when the server died', () => {
  const root = tmp();
  const a = createTask(root, 'a'); a.status = 'running'; saveTask(root, a);
  const b = createTask(root, 'b'); b.status = 'awaiting_approval'; saveTask(root, b);
  const c = createTask(root, 'c'); c.status = 'done'; saveTask(root, c);
  assert.equal(recoverInterrupted(root), 1);
  assert.equal(getTask(root, a.id).status, 'failed');
  assert.match(getTask(root, a.id).error, /restarted/);
  assert.equal(getTask(root, b.id).status, 'awaiting_approval');
  assert.equal(getTask(root, c.id).status, 'done');
});

test('listTasks and getTask skip valid JSON that is not a task', () => {
  const root = tmp();
  const good = createTask(root, 'good');
  writeRaw(root, 't-arr.json', '[]');
  writeRaw(root, 't-obj.json', '{}');
  writeRaw(root, 't-num.json', '5');
  writeRaw(root, 't-str.json', '"x"');
  writeRaw(root, 't-nosteps.json', JSON.stringify({ id: 't-nosteps', status: 'done', createdAt: '2026-01-01T00:00:00.000Z', events: [] }));
  assert.deepEqual(listTasks(root).map(s => s.id), [good.id]);
  for (const id of ['t-arr', 't-obj', 't-num', 't-str', 't-nosteps']) assert.equal(getTask(root, id), null, id);
  assert.equal(getTask(root, good.id).id, good.id);
});

test('a task file whose embedded id does not match its filename is ignored', () => {
  const root = tmp();
  const a = createTask(root, 'a');
  const b = createTask(root, 'b');
  writeRaw(root, `${a.id}.json`, JSON.stringify({ ...b, text: 'impostor' }));
  assert.equal(getTask(root, a.id), null);
  assert.deepEqual(listTasks(root).map(s => s.id), [b.id]);
});

test('saveTask refuses an id that is not a task id and writes nothing', () => {
  const root = tmp();
  assert.throws(() => saveTask(root, { id: '../../x', status: 'queued', createdAt: 'x', steps: [], events: [] }), /invalid task id/);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('tasks with identical createdAt sort deterministically by id', () => {
  const root = tmp();
  const same = '2026-03-01T00:00:00.000Z';
  const ids = ['a', 'b', 'c'].map(text => {
    const t = createTask(root, text);
    t.createdAt = same;
    saveTask(root, t);
    return t.id;
  });
  const expected = [...ids].sort((x, y) => y.localeCompare(x));
  assert.deepEqual(listTasks(root).map(s => s.id), expected);
  assert.deepEqual(listTasks(root).map(s => s.id), expected);
});

test('a failed write leaves no tmp file behind', () => {
  const root = tmp();
  const t = createTask(root, 'blocked');
  const file = path.join(tasksOf(root), `${t.id}.json`);
  // a directory at the target path makes the final rename fail
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.throws(() => saveTask(root, t));
  assert.deepEqual(fs.readdirSync(tasksOf(root)).filter(f => f.endsWith('.tmp')), []);
});

test('recoverInterrupted skips non-task files, recovers the rest and bumps updatedAt', () => {
  const root = tmp();
  const old = '2026-01-01T00:00:00.000Z';
  const a = createTask(root, 'a');
  a.status = 'running'; a.updatedAt = old; saveTask(root, a);
  writeRaw(root, 't-junk.json', JSON.stringify({ id: 't-junk', status: 'running' }));
  writeRaw(root, 't-corrupt.json', '{not json');
  assert.equal(recoverInterrupted(root), 1);
  const recovered = getTask(root, a.id);
  assert.equal(recovered.status, 'failed');
  assert.ok(recovered.updatedAt > old, recovered.updatedAt);
  assert.equal(getTask(root, 't-junk'), null);
});

test('savePatch keeps a redacted, owner-only copy and only the newest 50', async () => {
  const { savePatch, saveTask, getTask } = await import('../server/store.js');
  const fsm = await import('node:fs');
  const root = tmp();
  const file = savePatch(root, 't-abc', '+const key = "AKIAABCDEFGHIJKLMNOP";\n');
  assert.equal(fsm.readFileSync(file, 'utf8'), '+const key = "[REDACTED aws key id]";\n');
  assert.equal(fsm.statSync(file).mode & 0o777, 0o600);
  assert.equal(savePatch(root, '../evil', 'x'), null);
  assert.equal(savePatch(root, 't-empty', ''), null);
  for (let i = 0; i < 55; i++) savePatch(root, `t-n${String(i).padStart(2, '0')}`, `p${i}`);
  const left = fsm.readdirSync(file.replace(/\/[^/]+$/, ''));
  assert.equal(left.length, 50);
  const t = createTask(root, 'x');
  saveTask(root, t);
  assert.equal(fsm.statSync(`${root}/.floorhands/tasks/${t.id}.json`).mode & 0o777, 0o600, 'task files are owner-only');
  assert.ok(getTask(root, t.id));
});

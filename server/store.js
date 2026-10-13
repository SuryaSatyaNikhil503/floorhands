import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ID = /^t-[a-z0-9-]+$/;
const MAX_EVENTS = 500;
const LIVE = ['queued', 'planning', 'running'];

export const stateDir = root => path.join(root, '.floorhands');
const tasksDir = root => path.join(stateDir(root), 'tasks');
const fileOf = (root, id) => path.join(tasksDir(root), `${id}.json`);
const isTaskId = id => typeof id === 'string' && ID.test(id);

// A parsed file is a task only if it has the shape the rest of the store relies on
// and its embedded id matches the id it was read under.
const isTask = (v, id) =>
  v !== null && typeof v === 'object' && !Array.isArray(v) &&
  v.id === id &&
  typeof v.createdAt === 'string' &&
  typeof v.status === 'string' &&
  Array.isArray(v.steps) &&
  Array.isArray(v.events);

function taskIds(root) {
  try {
    return fs.readdirSync(tasksDir(root))
      .filter(n => n.endsWith('.json'))
      .map(n => n.slice(0, -5));
  } catch { return []; }
}

export function createTask(root, text) {
  const now = new Date().toISOString();
  const task = {
    id: 't-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex'),
    text, status: 'queued', createdAt: now, updatedAt: now,
    summary: '', steps: [], worktree: null, diffStat: '', error: null, events: [],
  };
  saveTask(root, task);
  return task;
}

export function saveTask(root, task) {
  if (!isTaskId(task?.id)) throw new Error('invalid task id');
  fs.mkdirSync(tasksDir(root), { recursive: true });
  const file = fileOf(root, task.id);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(task, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}

export function getTask(root, id) {
  if (!isTaskId(id)) return null;
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(fileOf(root, id), 'utf8')); } catch { return null; }
  return isTask(parsed, id) ? parsed : null;
}

export function summary(t) {
  return {
    id: t.id, text: t.text, status: t.status, createdAt: t.createdAt, updatedAt: t.updatedAt,
    summary: t.summary, error: t.error, diffStat: t.diffStat,
    steps: t.steps.map(s => ({ agent: s.agent, status: s.status })),
  };
}

export function listTasks(root) {
  return taskIds(root)
    .map(id => getTask(root, id))
    .filter(Boolean)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    .map(summary);
}

export function appendEvent(task, ev) {
  task.events.push(ev);
  if (task.events.length > MAX_EVENTS) task.events.splice(0, task.events.length - MAX_EVENTS);
}

export function recoverInterrupted(root) {
  let n = 0;
  for (const id of taskIds(root)) {
    const t = getTask(root, id);
    if (!t || !LIVE.includes(t.status)) continue;
    t.status = 'failed';
    t.error = 'The server restarted while this task was running.';
    t.updatedAt = new Date().toISOString();
    saveTask(root, t);
    n++;
  }
  return n;
}

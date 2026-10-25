import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { redact } from './redact.js';

const ID = /^t-[a-z0-9-]+$/;
const MAX_EVENTS = 500;
const LIVE = ['queued', 'planning', 'running', 'needs_budget'];

export const stateDir = root => path.join(root, '.floorhands');
const tasksDir = root => path.join(stateDir(root), 'tasks');
const patchesDir = root => path.join(stateDir(root), 'patches');
const MAX_PATCH = 2 * 1024 * 1024;
const KEEP_PATCHES = 50;
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
    // 0600: task files hold agent output about the owner's code.
    fs.writeFileSync(tmp, JSON.stringify(task, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}

// The diff of a task that was rejected or failed, kept so the cases where floorhands did a bad job are not erased (known limit 10 in
// 0.2.0 deleted them). Redacted, owner-only, capped at 2 MB, and only the newest 50 are kept.
export function savePatch(root, id, text) {
  if (!isTaskId(id) || typeof text !== 'string' || !text) return null;
  const dir = patchesDir(root);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let body = redact(text);
  if (Buffer.byteLength(body) > MAX_PATCH) body = Buffer.from(body).subarray(0, MAX_PATCH).toString('utf8').replace(/\uFFFD$/, '') + '\n… patch truncated …\n';
  const file = path.join(dir, `${id}.patch`);
  fs.writeFileSync(file, body, { mode: 0o600 });
  prunePatches(dir);
  return file;
}

function prunePatches(dir) {
  let names;
  try { names = fs.readdirSync(dir).filter(n => /^t-[a-z0-9-]+\.patch$/.test(n)); } catch { return; }
  if (names.length <= KEEP_PATCHES) return;
  const byAge = names.map(n => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs })).sort((a, b) => b.t - a.t || b.n.localeCompare(a.n));
  for (const { n } of byAge.slice(KEEP_PATCHES)) { try { fs.unlinkSync(path.join(dir, n)); } catch { /* best effort */ } }
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
    steps: t.steps.map(s => ({ agent: s.agent, status: s.status, model: s.route?.model ?? null, class: s.route?.class ?? null })),
    totals: t.totals ?? null, riskFlags: t.riskFlags ?? [], budgetRequest: t.budgetRequest ?? null,
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

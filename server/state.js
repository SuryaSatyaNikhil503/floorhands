import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { stateDir } from './store.js';

const infoFile = root => path.join(stateDir(root), 'server.json');
const enabledFile = root => path.join(stateDir(root), 'enabled');
const lockFile = root => path.join(stateDir(root), 'server.lock');
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function findProjectRoot(cwd) {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return fs.realpathSync(top);
  } catch {
    return fs.realpathSync(path.resolve(cwd));
  }
}

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export function writeServerInfo(root, info) {
  fs.mkdirSync(stateDir(root), { recursive: true });
  // Write-then-rename so a reader never sees half a file.
  const tmp = `${infoFile(root)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info), { mode: 0o600 }); // holds the per-run token: owner-only
  fs.renameSync(tmp, infoFile(root));
}

export function clearServerInfo(root) {
  try { fs.unlinkSync(infoFile(root)); } catch { /* already gone */ }
}

export function readServerInfo(root) {
  let info;
  try { info = JSON.parse(fs.readFileSync(infoFile(root), 'utf8')); } catch { return null; }
  if (!info || !pidAlive(info.pid)) { clearServerInfo(root); return null; }
  return info;
}

export const isEnabled = root => fs.existsSync(enabledFile(root));

export function setEnabled(root, on) {
  if (on) {
    fs.mkdirSync(stateDir(root), { recursive: true });
    fs.writeFileSync(enabledFile(root), '');
  } else {
    try { fs.unlinkSync(enabledFile(root)); } catch { /* already off */ }
  }
}

export function ensureExclude(root) {
  try {
    const rel = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const file = path.resolve(root, rel);
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (cur.split('\n').includes('.floorhands/')) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, (cur && !cur.endsWith('\n') ? '\n' : '') + '.floorhands/\n');
  } catch { /* not a git repo */ }
}

export async function serverUp(port, root, { attempts = 3, timeoutMs = 2000, gapMs = 200 } = {}) {
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(gapMs);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
      const j = await r.json();
      if (j.ok === true && j.name === 'floorhands' && j.project === root) return true;
    } catch { /* try again */ }
  }
  return false;
}

function readLockPid(file) {
  // A just-created lock can be momentarily empty; give the writer a moment before judging it.
  for (let i = 0; i < 5; i++) {
    let text;
    try { text = fs.readFileSync(file, 'utf8').trim(); } catch { return undefined; } // gone
    if (/^\d+$/.test(text)) return Number(text);
    if (i < 4) { const end = Date.now() + 20; while (Date.now() < end) { /* brief spin */ } }
  }
  return null; // unreadable garbage
}

function removeLockIf(file, pid) {
  // Only remove the lock we judged stale, not one a faster process has just taken.
  if (readLockPid(file) !== pid) return;
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}

// One server per project root. Resolves to 'acquired', 'other' (a different server owns this project and answers
// on its port) or 'failed'. A lock is stale when its pid is dead, or when its live pid does not become reachable
// as our server within FLOORHANDS_LOCK_WAIT_MS (the pid may have been reused by an unrelated process).
export async function acquireLock(root, waitMs = Number(process.env.FLOORHANDS_LOCK_WAIT_MS) || 5000) {
  const file = lockFile(root);
  fs.mkdirSync(stateDir(root), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
      return 'acquired';
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const owner = readLockPid(file);
    if (owner === process.pid) return 'acquired';
    if (owner === undefined) continue; // vanished between our attempt and the read: try again
    if (owner !== null && pidAlive(owner)) {
      const end = Date.now() + waitMs;
      while (Date.now() < end) {
        const info = readServerInfo(root);
        if (info && info.pid === owner && await serverUp(info.port, root, { attempts: 1, timeoutMs: 300 })) return 'other';
        if (!pidAlive(owner)) break;
        await sleep(200);
      }
    }
    removeLockIf(file, owner);
  }
  return 'failed';
}

export function releaseLock(root) {
  const file = lockFile(root);
  try {
    if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.unlinkSync(file);
  } catch { /* already gone */ }
}

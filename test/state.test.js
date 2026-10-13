import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  findProjectRoot, pidAlive, readServerInfo, writeServerInfo, clearServerInfo, isEnabled, setEnabled, ensureExclude, serverUp, acquireLock, releaseLock,
} from '../server/state.js';

const made = [];
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'floorhands-state-'))); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

test('findProjectRoot returns the git toplevel from a subfolder, else the folder itself', () => {
  const repo = tmp();
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true });
  assert.equal(findProjectRoot(path.join(repo, 'src', 'deep')), repo);
  const plain = tmp();
  assert.equal(findProjectRoot(plain), plain);
});

test('server info round-trips, and a dead pid is treated as no server', () => {
  const root = tmp();
  assert.equal(readServerInfo(root), null);
  writeServerInfo(root, { pid: process.pid, port: 4600, startedAt: 'now' });
  assert.equal(readServerInfo(root).port, 4600);
  writeServerInfo(root, { pid: 2 ** 22 + 12345, port: 4601, startedAt: 'then' });
  assert.equal(pidAlive(2 ** 22 + 12345), false);
  assert.equal(readServerInfo(root), null);
  assert.equal(fs.existsSync(path.join(root, '.floorhands', 'server.json')), false);
  clearServerInfo(root); // no throw when already gone
});

test('enable and disable toggle the marker', () => {
  const root = tmp();
  assert.equal(isEnabled(root), false);
  setEnabled(root, true);
  assert.equal(isEnabled(root), true);
  setEnabled(root, false);
  assert.equal(isEnabled(root), false);
  setEnabled(root, false); // no throw
});

test('ensureExclude hides the state folder from git once', () => {
  const repo = tmp();
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  ensureExclude(repo);
  ensureExclude(repo);
  const ex = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(ex.split('\n').filter(l => l === '.floorhands/').length, 1);
  ensureExclude(tmp()); // not a repo: no throw
});

test('serverUp accepts only an floorhands health answer for the same project', async () => {
  let body;
  const srv = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  try {
    body = { ok: true, name: 'floorhands', project: '/p' };
    assert.equal(await serverUp(port, '/p', { attempts: 1, timeoutMs: 300 }), true);
    assert.equal(await serverUp(port, '/other', { attempts: 1, timeoutMs: 300 }), false);
    body = { ok: true, project: '/p' };
    assert.equal(await serverUp(port, '/p', { attempts: 1, timeoutMs: 300 }), false, 'some other service that happens to answer');
  } finally {
    srv.closeAllConnections();
    await new Promise(r => srv.close(r));
  }
  assert.equal(await serverUp(port, '/p', { attempts: 1, timeoutMs: 300 }), false, 'nothing listening');
});

test('serverUp is true when only a later attempt succeeds, false only after every attempt fails', async () => {
  let n = 0;
  const srv = http.createServer((req, res) => {
    n += 1;
    const answer = () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, name: 'floorhands', project: '/p' })); };
    if (n === 1) setTimeout(() => { try { answer(); } catch { /* client gave up */ } }, 800); // slower than timeoutMs
    else answer();
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  try {
    assert.equal(await serverUp(port, '/p', { attempts: 3, timeoutMs: 200, gapMs: 20 }), true);
    assert.equal(n, 2, 'stops at the first success');
    assert.equal(await serverUp(port, '/nope', { attempts: 3, timeoutMs: 200, gapMs: 20 }), false);
    assert.equal(n, 5, 'a wrong answer is retried until attempts run out');
  } finally {
    srv.closeAllConnections();
    await new Promise(r => srv.close(r));
  }
});

test('server.json is written atomically: complete content, no temp file left behind', () => {
  const root = tmp();
  writeServerInfo(root, { pid: process.pid, port: 4600, startedAt: 'now' });
  writeServerInfo(root, { pid: process.pid, port: 4601, startedAt: 'later' });
  const dir = path.join(root, '.floorhands');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['server.json']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'server.json'), 'utf8')).port, 4601);
});

test('acquireLock: first caller wins, repeat by the same pid is fine, releaseLock removes only our own lock', async () => {
  const root = tmp();
  assert.equal(await acquireLock(root), 'acquired');
  const lock = path.join(root, '.floorhands', 'server.lock');
  assert.equal(fs.readFileSync(lock, 'utf8'), String(process.pid));
  assert.equal(await acquireLock(root), 'acquired');
  fs.writeFileSync(lock, String(process.pid + 1));
  releaseLock(root); // someone else's lock: untouched
  assert.equal(fs.existsSync(lock), true);
  fs.writeFileSync(lock, String(process.pid));
  releaseLock(root);
  assert.equal(fs.existsSync(lock), false);
  releaseLock(root); // no throw when gone
});

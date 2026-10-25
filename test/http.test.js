import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import * as store from '../server/store.js';
import { createApp, createHub } from '../server/http.js';
import { notesPath } from '../server/notes.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floorhands-http-'));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'floorhands-ui-'));
const uiDir = path.join(base, 'ui');
fs.mkdirSync(uiDir);
const secretName = 'secret-outside.js';
fs.writeFileSync(path.join(base, secretName), 'TOP-SECRET-OUTSIDE-UI');
fs.writeFileSync(path.join(uiDir, 'index.html'), '<!doctype html><title>t</title>');
fs.writeFileSync(path.join(uiDir, 'app.js'), 'export {}');
const roster = {
  pods: [{ id: 'p', name: 'P' }],
  agents: [{ id: 'arch', name: 'ARCHITECT', role: 'r', pod: 'p', lead: true, router: true, tier: 'read', skills: [], system: 'SECRET-PROMPT' }],
};
const runs = [];
const logs = [];
let failApprove = false;
let failRun = false;
let diffImpl = async () => 'diff --git a/x b/x';
const orchestrator = {
  run: async id => { runs.push(id); if (failRun) throw new Error('run boom'); },
  diff: id => diffImpl(id),
  approve: async () => { if (failApprove) throw new Error('merge conflict'); },
  reject: async (id, why) => { rejects.push({ id, why }); },
  decideBudget: (id, d) => { if (d.decision === 'boom') throw new Error('This task is not waiting for a budget decision.'); budgets.push({ id, ...d }); },
};
const budgets = [];
const rejects = [];
const hub = createHub();
let server, port;

before(async () => {
  server = createApp({ root, roster, store, orchestrator, hub, uiDir, log: (...a) => logs.push(a) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(async () => {
  await new Promise(r => { server.closeAllConnections?.(); server.close(r); });
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(base, { recursive: true, force: true });
});

function request({ method = 'GET', path: p = '/', headers = {}, body, port: pp = port }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: pp, method, path: p, headers: { host: `localhost:${pp}`, ...headers } }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', d => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const post = (p, obj, headers = {}) => request({ method: 'POST', path: p, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(obj) });

test('health and state never leak the agents\' system prompts', async () => {
  const h = await request({ path: '/api/health' });
  assert.equal(JSON.parse(h.body).project, root);
  const s = await request({ path: '/api/state' });
  assert.equal(s.status, 200);
  assert.ok(!s.body.includes('SECRET-PROMPT'));
  assert.equal(JSON.parse(s.body).roster.agents[0].id, 'arch');
});

test('state reports the notes file path and size, never its contents', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'floorhands-httphome-'));
  const saved = process.env.FLOORHANDS_HOME;
  process.env.FLOORHANDS_HOME = home;
  try {
    let s = JSON.parse((await request({ path: '/api/state' })).body);
    assert.deepEqual(s.notes, { path: notesPath(root), bytes: 0 });
    assert.ok(notesPath(root).startsWith(home));
    fs.mkdirSync(path.dirname(notesPath(root)), { recursive: true });
    fs.writeFileSync(notesPath(root), 'PRIVATE-OWNER-NOTE-TEXT');
    const raw = (await request({ path: '/api/state' })).body;
    s = JSON.parse(raw);
    assert.deepEqual(s.notes, { path: notesPath(root), bytes: 23 });
    assert.ok(!raw.includes('PRIVATE-OWNER-NOTE-TEXT'), 'contents are not in the state payload');
  } finally {
    if (saved === undefined) delete process.env.FLOORHANDS_HOME; else process.env.FLOORHANDS_HOME = saved;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('POST /api/tasks creates a task and starts it', async () => {
  const r = await post('/api/tasks', { text: 'Review the footer' });
  assert.equal(r.status, 201);
  const { id } = JSON.parse(r.body);
  assert.match(id, /^t-/);
  assert.ok(runs.includes(id));
  const got = await request({ path: `/api/tasks/${id}` });
  assert.equal(JSON.parse(got.body).text, 'Review the footer');
  const list = JSON.parse((await request({ path: '/api/state' })).body).tasks;
  assert.ok(list.some(t => t.id === id));
});

test('rejects empty, oversized and malformed task requests', async () => {
  assert.equal((await post('/api/tasks', { text: '   ' })).status, 400);
  assert.equal((await post('/api/tasks', { text: 'x'.repeat(4001) })).status, 400);
  assert.equal((await request({ method: 'POST', path: '/api/tasks', headers: { 'content-type': 'application/json' }, body: '{nope' })).status, 400);
  assert.equal((await request({ method: 'POST', path: '/api/tasks', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(70000) }) })).status, 413);
});

test('blocks other websites: foreign Host, foreign Origin, and non-JSON posts', async () => {
  assert.equal((await request({ path: '/api/state', headers: { host: 'evil.example.com' } })).status, 403);
  assert.equal((await post('/api/tasks', { text: 'x' }, { origin: 'http://evil.example.com' })).status, 403);
  assert.equal((await post('/api/tasks', { text: 'x' }, { origin: 'null' })).status, 403);
  assert.equal((await request({ method: 'POST', path: '/api/tasks', headers: { 'content-type': 'text/plain' }, body: '{"text":"x"}' })).status, 415);
  assert.equal((await post('/api/tasks', { text: 'ok' }, { origin: `http://localhost:${port}` })).status, 201);
});

test('unknown and malformed task ids are 404', async () => {
  assert.equal((await request({ path: '/api/tasks/t-missing' })).status, 404);
  assert.equal((await request({ path: '/api/tasks/..%2F..%2Fetc' })).status, 404);
  assert.equal((await post('/api/tasks/t-missing/approve', {})).status, 404);
});

test('diff, approve and reject; a failed approve is a 409 with the reason', async () => {
  const { id } = JSON.parse((await post('/api/tasks', { text: 'build' })).body);
  const d = await request({ path: `/api/tasks/${id}/diff` });
  assert.match(d.headers['content-type'], /text\/plain/);
  assert.match(d.body, /diff --git/);
  assert.equal((await post(`/api/tasks/${id}/approve`, {})).status, 200);
  assert.equal((await post(`/api/tasks/${id}/reject`, {})).status, 200);
  failApprove = true;
  const bad = await post(`/api/tasks/${id}/approve`, {});
  failApprove = false;
  assert.equal(bad.status, 409);
  assert.match(JSON.parse(bad.body).error, /merge conflict/);
});

test('server-sent events deliver hub events', async () => {
  const chunks = await new Promise((resolve, reject) => {
    const got = [];
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { host: `localhost:${port}` } }, res => {
      assert.match(res.headers['content-type'], /text\/event-stream/);
      res.setEncoding('utf8');
      res.on('data', d => {
        got.push(d);
        if (got.join('').includes('retry:') && !got.join('').includes('"hello"')) hub.emit({ type: 'hello' });
        if (got.join('').includes('"hello"')) { req.destroy(); resolve(got.join('')); }
      });
    });
    req.on('error', e => (e.code === 'ECONNRESET' ? null : reject(e)));
  });
  assert.match(chunks, /data: \{"type":"hello"\}/);
});

test('serves the UI with a strict CSP, and nothing outside the UI folder', async () => {
  const idx = await request({ path: '/' });
  assert.equal(idx.status, 200);
  assert.match(idx.headers['content-type'], /text\/html/);
  assert.match(idx.headers['content-security-policy'], /default-src 'self'/);
  assert.equal((await request({ path: '/app.js' })).status, 200);
  assert.equal((await request({ path: '/../package.json' })).status, 404);
  assert.equal((await request({ path: '/%2e%2e/package.json' })).status, 404);
  assert.equal((await request({ path: '/secret.txt' })).status, 404);
});

test('a real file one level above the UI folder is never served', async () => {
  for (const p of [`/..%2f${secretName}`, `/../${secretName}`, `/%2e%2e/${secretName}`, `/..\\${secretName}`, `/%5c..%5c${secretName}`, `/%2e%2e%2f${secretName}`]) {
    const r = await request({ path: p });
    assert.equal(r.status, 404, p);
    assert.ok(!r.body.includes('TOP-SECRET-OUTSIDE-UI'), p);
  }
});

test('task text must be a string in a plain JSON object', async () => {
  for (const bad of [{ text: {} }, { text: 123 }, { text: ['a'] }, { text: null }, {}, null, [], 'text', 7]) {
    const r = await post('/api/tasks', bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(JSON.parse(r.body).error, 'text is required (max 4000 characters)');
  }
});

test('the 64 KB body limit counts bytes, not characters', async () => {
  const body = JSON.stringify({ text: '€'.repeat(30000) }); // 30k chars but 90k bytes
  assert.ok(body.length < 65536 && Buffer.byteLength(body) > 65536);
  assert.equal((await request({ method: 'POST', path: '/api/tasks', headers: { 'content-type': 'application/json' }, body })).status, 413);
});

test('multibyte characters split across chunks decode intact', async () => {
  const buf = Buffer.from(JSON.stringify({ text: 'é€é' }));
  const cut = buf.indexOf(0xe2) + 1; // inside the 3-byte euro sign
  const id = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/tasks', headers: { host: `localhost:${port}`, 'content-type': 'application/json' } }, res => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => resolve(JSON.parse(d).id));
    });
    req.on('error', reject);
    req.write(buf.subarray(0, cut));
    setTimeout(() => { req.write(buf.subarray(cut)); req.end(); }, 30);
  });
  assert.equal(JSON.parse((await request({ path: `/api/tasks/${id}` })).body).text, 'é€é');
});

test('content-type must be exactly application/json (parameters allowed)', async () => {
  const withType = type => request({ method: 'POST', path: '/api/tasks', headers: { 'content-type': type }, body: '{"text":"ct"}' });
  assert.equal((await withType('application/jsonp')).status, 415);
  assert.equal((await withType('application/x-www-form-urlencoded')).status, 415);
  assert.equal((await withType('multipart/form-data; boundary=x')).status, 415);
  assert.equal((await withType('application/json; charset=utf-8')).status, 201);
  assert.equal((await withType('Application/JSON')).status, 201);
});

test('a declared Content-Length over 64 KB is refused up front, before the body arrives', async () => {
  for (const p of ['/api/tasks', '/api/tasks/t-missing/approve', '/api/tasks/t-missing/reject']) {
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: p, headers: { host: `localhost:${port}`, 'content-type': 'application/json', 'content-length': 10_000_000 } }, res => {
        resolve(res.statusCode);
        req.destroy();
      });
      req.on('error', e => (e.code === 'ECONNRESET' ? null : reject(e)));
      req.write('{"text":'); // the other ~10 MB never comes
    });
    assert.equal(status, 413, p);
  }
});

test('a request line the URL parser rejects is a 400, not a crash', async () => {
  const raw = await new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let data = '';
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(`GET http://[ HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`));
    sock.on('data', d => { data += d; });
    sock.on('end', () => resolve(data));
    sock.on('error', reject);
  });
  assert.match(raw, /^HTTP\/1\.1 400 /);
  assert.match(raw, /"error":"bad request"/);
});

test('diff is capped at 2 MB, and a failing diff is a 409 with the reason', async () => {
  const { id } = JSON.parse((await post('/api/tasks', { text: 'diff cap' })).body);
  diffImpl = async () => 'a'.repeat(3 * 1024 * 1024);
  const big = await request({ path: `/api/tasks/${id}/diff` });
  assert.equal(big.status, 200);
  assert.ok(big.body.length < 2 * 1024 * 1024 + 100);
  assert.ok(big.body.endsWith('\n… diff truncated …\n'));
  diffImpl = async () => { throw new Error('no worktree for this task'); };
  const bad = await request({ path: `/api/tasks/${id}/diff` });
  diffImpl = async () => 'diff --git a/x b/x';
  assert.equal(bad.status, 409);
  assert.match(JSON.parse(bad.body).error, /no worktree/);
});

test('a rejected orchestrator.run is logged, not swallowed', async () => {
  logs.length = 0;
  failRun = true;
  const r = await post('/api/tasks', { text: 'run will fail' });
  failRun = false;
  assert.equal(r.status, 201);
  for (let i = 0; i < 50 && !logs.length; i++) await new Promise(r2 => setTimeout(r2, 10));
  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], '[floorhands]');
  assert.match(String(logs[0][1]?.message ?? logs[0][1]), /run boom/);
});

test('unexpected errors are a 500 and are logged', async () => {
  const seen = [];
  const badStore = { ...store, listTasks: () => { throw new Error('disk on fire'); } };
  const srv = createApp({ root, roster, store: badStore, orchestrator, hub: createHub(), uiDir, log: (...a) => seen.push(a) });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    const r = await request({ path: '/api/state', port: srv.address().port });
    assert.equal(r.status, 500);
    assert.equal(seen.length, 1);
    assert.match(String(seen[0][1]?.message ?? seen[0][1]), /disk on fire/);
  } finally {
    await new Promise(r => { srv.closeAllConnections?.(); srv.close(r); });
  }
});

test('a dead SSE client is dropped without disturbing the others', async () => {
  let subs = 0;
  const inner = createHub();
  const spyHub = {
    emit: ev => inner.emit(ev),
    subscribe: fn => {
      subs++;
      const off = inner.subscribe(fn);
      let done = false;
      return () => { if (!done) { done = true; subs--; } off(); };
    },
  };
  const srv = createApp({ root, roster, store, orchestrator, hub: spyHub, uiDir, log: () => {} });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const sp = srv.address().port;
  const open = () => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: sp, path: '/api/events', headers: { host: `localhost:${sp}` } }, res => {
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      let data = '';
      res.setEncoding('utf8');
      res.on('data', d => { data += d; });
      resolve({ req, res, text: () => data });
    });
    req.on('error', e => (e.code === 'ECONNRESET' ? null : reject(e)));
  });
  const until = async cond => { for (let i = 0; i < 100 && !cond(); i++) await new Promise(r => setTimeout(r, 10)); };
  try {
    const baseline = subs;
    const a = await open();
    const b = await open();
    await until(() => subs === baseline + 2);
    assert.equal(subs, baseline + 2);
    a.req.destroy(); // abrupt disconnect
    await until(() => subs === baseline + 1);
    assert.equal(subs, baseline + 1);
    assert.doesNotThrow(() => spyHub.emit({ type: 'still-here' }));
    await until(() => b.text().includes('still-here'));
    assert.match(b.text(), /data: \{"type":"still-here"\}/);
    b.req.destroy();
    await until(() => subs === baseline);
    assert.equal(subs, baseline);
  } finally {
    await new Promise(r => { srv.closeAllConnections?.(); srv.close(r); });
  }
});

test('with a token, every /api route but health needs it (header, or ?t= for the event stream only)', async () => {
  const token = 'tok-' + 'x'.repeat(40);
  const app = createApp({ root, roster, store, orchestrator, hub, uiDir, log: () => {}, token });
  await new Promise(r => app.listen(0, '127.0.0.1', r));
  const p = app.address().port;
  try {
    assert.equal((await request({ path: '/api/health', port: p })).status, 200);
    assert.equal((await request({ path: '/api/state', port: p })).status, 401);
    assert.equal((await request({ path: '/api/state', port: p, headers: { 'x-floorhands-token': 'wrong' } })).status, 401);
    assert.equal((await request({ path: '/api/state', port: p, headers: { 'x-floorhands-token': token } })).status, 200);
    assert.equal((await request({ path: `/api/state?t=${token}`, port: p })).status, 401, 'the query form is only for /api/events');
    const before = runs.length;
    const r = await request({ method: 'POST', path: '/api/tasks', port: p, headers: { 'content-type': 'application/json' }, body: '{"text":"x"}' });
    assert.equal(r.status, 401);
    assert.equal(runs.length, before, 'no task started');
    assert.equal((await request({ path: '/', port: p })).status, 200, 'the page itself is not gated: it holds no project data');
    await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: p, path: `/api/events?t=${token}`, headers: { host: `localhost:${p}` } }, res => {
        assert.equal(res.statusCode, 200);
        res.destroy();
        resolve();
      });
      req.on('error', e => (e.code === 'ECONNRESET' ? resolve() : reject(e)));
      req.end();
    });
  } finally {
    await new Promise(r => { app.closeAllConnections?.(); app.close(r); });
  }
});

test('reject passes an optional reason and note through; an empty body still works', async () => {
  const t = store.createTask(root, 'reject me');
  rejects.length = 0;
  assert.equal((await post(`/api/tasks/${t.id}/reject`, { reason: 'too-big', note: 'split it', extra: 1 })).status, 200);
  assert.equal((await request({ method: 'POST', path: `/api/tasks/${t.id}/reject`, headers: { 'content-type': 'application/json' } })).status, 200);
  assert.equal((await post(`/api/tasks/${t.id}/reject`, { reason: 7 })).status, 200);
  assert.deepEqual(rejects.map(r => r.why), [{ reason: 'too-big', note: 'split it' }, {}, {}]);
  const bad = await request({ method: 'POST', path: `/api/tasks/${t.id}/reject`, headers: { 'content-type': 'application/json' }, body: '{nope' });
  assert.equal(bad.status, 400);
});


test('the budget route passes the owner\'s decision through and reports refusals as 409', async () => {
  const t = store.createTask(root, 'budget');
  assert.equal((await post(`/api/tasks/${t.id}/budget`, { decision: 'allow', extraUsd: 2, extra: 'x' })).status, 200);
  assert.deepEqual(budgets.at(-1), { id: t.id, decision: 'allow', extraUsd: 2 });
  const refused = await post(`/api/tasks/${t.id}/budget`, { decision: 'boom' });
  assert.equal(refused.status, 409);
  assert.match(JSON.parse(refused.body).error, /not waiting/);
  assert.equal((await post(`/api/tasks/${t.id}/budget`, [1])).status, 400);
});

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(REPO, 'bin', 'floorhands');
const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'floorhands-e2e-')));
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'floorhands-e2e-home-')));
const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'floorhands-e2e-plain-')));
const env = {
  ...process.env,
  FLOORHANDS_PORT: String(48000 + Math.floor(Math.random() * 900)),
  FLOORHANDS_CLAUDE_BIN: path.join(REPO, 'scripts', 'fake-claude.mjs'),
  FLOORHANDS_HOME: home,
};
delete env.FLOORHANDS_AGENT;
const penv = { ...env, FLOORHANDS_PORT: String(Number(env.FLOORHANDS_PORT) + 50) };
const sh = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: project, encoding: 'utf8' });
const fh = (...a) => execFileSync(process.execPath, [BIN, ...a], { cwd: project, env, encoding: 'utf8' });
let base, token;
const tokenOf = link => decodeURIComponent(/#t=([^\s]+)/.exec(link)[1]);

async function call(method, p, body, { auth = true } = {}) {
  const headers = { 'content-type': 'application/json', ...(auth ? { 'x-floorhands-token': token } : {}) };
  const r = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, json: () => JSON.parse(text), text };
}
async function waitFor(id, statuses, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const t = (await call('GET', `/api/tasks/${id}`)).json();
    if (statuses.includes(t.status)) return t;
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`task ${id} did not reach ${statuses}`);
}

before(() => {
  sh('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(project, 'README.md'), '# demo\n');
  sh('add', '-A');
  sh('commit', '-q', '-m', 'init');
  base = /http:\/\/localhost:\d+/.exec(fh('start'))[0];
  token = tokenOf(fh('url'));
});

test('the API refuses requests without this run\'s token; health stays open', async () => {
  assert.equal((await call('GET', '/api/state', null, { auth: false })).status, 401);
  assert.equal((await call('POST', '/api/tasks', { text: 'x' }, { auth: false })).status, 401);
  const wrong = await fetch(base + '/api/state', { headers: { 'x-floorhands-token': 'nope' } });
  assert.equal(wrong.status, 401);
  assert.equal((await call('GET', '/api/health', null, { auth: false })).status, 200);
  assert.equal((await call('GET', '/api/state')).status, 200);
  const info = JSON.parse(fs.readFileSync(path.join(project, '.floorhands', 'server.json'), 'utf8'));
  assert.equal(info.token, token);
  assert.equal(fs.statSync(path.join(project, '.floorhands', 'server.json')).mode & 0o077, 0, 'server.json is owner-only');
});
after(() => {
  try { fh('stop'); } catch { /* ignore */ }
  try { execFileSync(process.execPath, [BIN, 'stop'], { cwd: plain, env: penv }); } catch { /* ignore */ }
  for (const d of [project, home, plain]) fs.rmSync(d, { recursive: true, force: true });
});

test('a task flows plan -> build in a worktree -> review -> approval -> merge', async () => {
  const { id } = (await call('POST', '/api/tasks', { text: 'Add a demo note' })).json();
  const t = await waitFor(id, ['awaiting_approval', 'failed']);
  assert.equal(t.status, 'awaiting_approval', t.error ?? '');
  assert.deepEqual(t.steps.map(s => s.agent), ['fe', 'rfe']);
  assert.match(t.steps[1].output, /Reviewed/);
  // Routing and telemetry: the builder ran on its default class, the reviewer on frontier, and what actually ran is recorded.
  assert.deepEqual(t.steps.map(s => s.route.class), ['standard', 'frontier']);
  assert.deepEqual(t.steps.map(s => s.metrics.model), ['sonnet', 'opus']);
  assert.equal(t.planner.route.model, 'opus');
  assert.ok(t.totals.costUsd > 0 && t.totals.runs === 3);
  // The fake CLI never calls the API, so the spending guard saw nothing: that is flagged, never silently counted as $0.
  assert.ok(t.steps.every(s => s.metrics.meterRequests === 0 && s.metrics.meterBypassed === true));
  assert.match(t.planRaw, /"steps"/);
  assert.match((await call('GET', `/api/tasks/${id}/diff`)).text, /FLOORHANDS_DEMO\.md/);
  assert.equal(fs.existsSync(path.join(project, 'FLOORHANDS_DEMO.md')), false, 'working copy untouched before approval');

  assert.equal((await call('POST', `/api/tasks/${id}/approve`, {})).status, 200);
  assert.equal(fs.readFileSync(path.join(project, 'FLOORHANDS_DEMO.md'), 'utf8'), 'Hello from the team.\n');
  assert.equal((await waitFor(id, ['approved'])).status, 'approved');
  assert.match(sh('log', '--oneline', '-3'), /Merge floorhands work/);
});

test('rejecting leaves the project exactly as it was', async () => {
  sh('rm', '-q', 'FLOORHANDS_DEMO.md');
  sh('commit', '-q', '-m', 'remove demo');
  const { id } = (await call('POST', '/api/tasks', { text: 'Add a demo note again' })).json();
  await waitFor(id, ['awaiting_approval']);
  assert.equal((await call('POST', `/api/tasks/${id}/reject`, { reason: 'not-needed', note: 'already done' })).status, 200);
  const done = (await call('GET', `/api/tasks/${id}`)).json();
  assert.deepEqual(done.rejectReason, { reason: 'not-needed', note: 'already done' });
  assert.match(fs.readFileSync(done.patch, 'utf8'), /FLOORHANDS_DEMO\.md/, 'the rejected diff is kept');
  assert.equal(fs.existsSync(path.join(project, 'FLOORHANDS_DEMO.md')), false);
  assert.equal(sh('branch', '--list', `floorhands/${id}`).trim(), '');
});

test('a build task in a folder that is not a git repo fails clearly', async () => {
  const out = execFileSync(process.execPath, [BIN, 'start'], { cwd: plain, env: penv, encoding: 'utf8' });
  const url = /http:\/\/localhost:\d+/.exec(out)[0];
  const h = { 'x-floorhands-token': tokenOf(execFileSync(process.execPath, [BIN, 'url'], { cwd: plain, env: penv, encoding: 'utf8' })) };
  try {
    const r = await fetch(url + '/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify({ text: 'Add a demo note' }) });
    const { id } = await r.json();
    const end = Date.now() + 20000;
    let t;
    do { t = await (await fetch(`${url}/api/tasks/${id}`, { headers: h })).json(); await new Promise(r => setTimeout(r, 150)); } while (!['failed', 'awaiting_approval'].includes(t.status) && Date.now() < end);
    assert.equal(t.status, 'failed');
    assert.match(t.error, /git repository/);
  } finally {
    execFileSync(process.execPath, [BIN, 'stop'], { cwd: plain, env: penv });
  }
});

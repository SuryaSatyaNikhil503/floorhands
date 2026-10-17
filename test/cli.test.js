import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'floorhands');
const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'floorhands-cli-')));
const env = { ...process.env, FLOORHANDS_PORT: String(47000 + Math.floor(Math.random() * 900)) };
delete env.FLOORHANDS_AGENT;
const fh = (...a) => execFileSync(process.execPath, [BIN, ...a], { cwd: project, env, encoding: 'utf8' });

after(() => {
  try { fh('stop'); } catch { /* already stopped */ }
  fs.rmSync(project, { recursive: true, force: true });
});

test('status, start, start again (idempotent), stop', async () => {
  assert.match(fh('status'), /not running/);

  const first = fh('start');
  const m = /http:\/\/localhost:(\d+)/.exec(first);
  assert.ok(m, `expected a URL, got: ${first}`);
  const health = await (await fetch(`http://127.0.0.1:${m[1]}/api/health`)).json();
  assert.equal(health.project, project);

  assert.equal(fh('start').trim(), first.trim(), 'second start reuses the running server');
  assert.match(fh('status'), /running at/);

  fh('stop');
  assert.match(fh('status'), /not running/);
});

test('start replaces a stale server.json instead of trusting it', () => {
  fs.mkdirSync(path.join(project, '.floorhands'), { recursive: true });
  fs.writeFileSync(path.join(project, '.floorhands', 'server.json'), JSON.stringify({ pid: 2 ** 22 + 999, port: 1, startedAt: 'x' }));
  assert.match(fh('start'), /http:\/\/localhost:\d+/);
  fh('stop');
});

test('--if-enabled starts only in enabled projects; FLOORHANDS_AGENT=1 never starts anything', () => {
  assert.equal(fh('start', '--if-enabled'), '');
  assert.match(fh('status'), /not running/);
  assert.match(fh('enable'), /auto-start on/);
  assert.match(fh('start', '--if-enabled'), /http:\/\/localhost:\d+/);
  fh('stop');
  assert.match(fh('disable'), /auto-start off/);
  const agentEnv = { ...env, FLOORHANDS_AGENT: '1' };
  const out = execFileSync(process.execPath, [BIN, 'start'], { cwd: project, env: agentEnv, encoding: 'utf8' });
  assert.equal(out, '');
});

test('unknown command exits 2 with help', () => {
  assert.throws(() => fh('dance'), e => e.status === 2 && /unknown command/.test(e.stdout));
});

test('stop never signals a process that is not our server (stale or reused pid)', () => {
  const bystander = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  try {
    fs.mkdirSync(path.join(project, '.floorhands'), { recursive: true });
    const file = path.join(project, '.floorhands', 'server.json');
    fs.writeFileSync(file, JSON.stringify({ pid: bystander.pid, port: 1, startedAt: 'x' }));
    const out = fh('stop');
    assert.match(out, /stale/);
    assert.doesNotThrow(() => process.kill(bystander.pid, 0), 'the unrelated process must still be alive');
    assert.equal(fs.existsSync(file), false, 'stale record removed');
  } finally {
    bystander.kill('SIGKILL');
  }
});

// ---- one server per project root ----
const port = () => 47000 + Math.floor(Math.random() * 900);
const freshProject = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'floorhands-cli-lock-'))); fresh.push(d); return d; };
const fresh = [];
const runIn = (dir, extraEnv, ...a) => execFileSync(process.execPath, [BIN, ...a], { cwd: dir, env: { ...env, FLOORHANDS_PORT: String(port()), ...extraEnv }, encoding: 'utf8' });
const runInAsync = (dir, extraEnv, ...a) => execFileAsync(process.execPath, [BIN, ...a], { cwd: dir, env: { ...env, ...extraEnv }, encoding: 'utf8' });
const serversFor = dir => execFileSync('ps', ['-axo', 'pid=,command=']).toString().split('\n').filter(l => l.includes(`server/main.js --root ${dir}`));
after(() => {
  for (const d of fresh) {
    try { runIn(d, {}, 'stop'); } catch { /* already stopped */ }
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('two concurrent starts share one server: same URL, exactly one process, lock released on stop', async () => {
  const dir = freshProject();
  const extra = { FLOORHANDS_PORT: String(port()) };
  const [a, b] = await Promise.all([runInAsync(dir, extra, 'start'), runInAsync(dir, extra, 'start')]);
  assert.match(a.stdout, /http:\/\/localhost:\d+/);
  assert.equal(a.stdout.trim(), b.stdout.trim());
  // The losing server notices the winner on its own 200 ms poll, so it can outlive the CLI that spawned it by a moment.
  let procs = serversFor(dir);
  for (let i = 0; i < 40 && procs.length > 1; i++) { await new Promise(r => setTimeout(r, 50)); procs = serversFor(dir); }
  assert.equal(procs.length, 1, procs.join('\n'));
  runIn(dir, {}, 'stop');
  assert.equal(serversFor(dir).length, 0);
  assert.equal(fs.existsSync(path.join(dir, '.floorhands', 'server.lock')), false);
});

test('a lock left by a dead process is taken over by start', () => {
  const dir = freshProject();
  fs.mkdirSync(path.join(dir, '.floorhands'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.floorhands', 'server.lock'), String(2 ** 22 + 777));
  assert.match(runIn(dir, {}, 'start'), /http:\/\/localhost:\d+/);
  assert.equal(serversFor(dir).length, 1);
  runIn(dir, {}, 'stop');
});

test('a lock held by a live process that is not serving is taken over after the wait', () => {
  // The pid in the lock may have been reused by an unrelated live process (a crash left the lock behind and the OS
  // recycled the pid). A live pid alone is therefore not proof of a server: the loser waits FLOORHANDS_LOCK_WAIT_MS for the
  // owner to answer /api/health, and only then treats the lock as stale.
  const dir = freshProject();
  const bystander = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  try {
    fs.mkdirSync(path.join(dir, '.floorhands'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.floorhands', 'server.lock'), String(bystander.pid));
    assert.match(runIn(dir, { FLOORHANDS_LOCK_WAIT_MS: '600' }, 'start'), /http:\/\/localhost:\d+/);
    assert.equal(serversFor(dir).length, 1);
    assert.doesNotThrow(() => process.kill(bystander.pid, 0), 'the bystander is never signalled');
    runIn(dir, {}, 'stop');
  } finally {
    bystander.kill('SIGKILL');
  }
});

test('unknown options and extra arguments exit 2 with help', () => {
  const bad = (...a) => assert.throws(() => fh(...a), e => e.status === 2 && /help|floorhands start/.test(e.stdout) && e.stdout.length > 0);
  assert.throws(() => fh('start', '--if-enable'), e => e.status === 2 && /unknown option "--if-enable"/.test(e.stdout) && /floorhands stop/.test(e.stdout));
  bad('stop', 'now');
  bad('status', '--json');
  bad('open', 'x');
  bad('enable', 'x');
  bad('disable', 'x');
  bad('notes', 'x');
  bad('notes', '--edit');
  assert.match(fh('status'), /not running/, 'a rejected start started nothing');
});

test('help lists the notes command', () => {
  assert.match(fh('help'), /floorhands notes/);
});

test('notes prints the path, then the contents or a hint, and creates nothing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'floorhands-clihome-'));
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'floorhands-clinotes-')));
  const run = () => execFileSync(process.execPath, [BIN, 'notes'], { cwd: dir, env: { ...env, FLOORHANDS_HOME: home }, encoding: 'utf8' });
  try {
    const none = run();
    const m = /^notes file: (.+)\n/.exec(none);
    assert.ok(m, none);
    assert.ok(m[1].startsWith(path.join(home, 'projects') + path.sep) && m[1].endsWith('notes.md'), m[1]);
    assert.match(none, /\(no notes yet, create the file above with your editor\)/);
    assert.deepEqual(fs.readdirSync(home), [], 'creates nothing');
    assert.ok(!fs.existsSync(path.join(dir, '.floorhands')), 'nothing created in the project either');
    fs.mkdirSync(path.dirname(m[1]), { recursive: true });
    fs.writeFileSync(m[1], 'Always write tests.\n');
    const some = run();
    assert.equal(some, `notes file: ${m[1]}\nAlways write tests.\n`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

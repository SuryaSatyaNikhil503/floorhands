import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findCli, run } from '../claude-plugin/hooks/session-start.js';

const HOOK = fileURLToPath(new URL('../claude-plugin/hooks/session-start.js', import.meta.url));
const tmpDirs = [];
const mkTmp = prefix => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpDirs.push(d); return d; };
test.after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const mkBin = () => {
  const dir = mkTmp('floorhands-hook-');
  const bin = path.join(dir, 'floorhands');
  fs.writeFileSync(bin, '#!/usr/bin/env node\n');
  return { dir, bin };
};

test('findCli prefers FLOORHANDS_BIN, then the repo layout, and returns null if neither exists', () => {
  const { bin } = mkBin();
  assert.equal(findCli({ FLOORHANDS_BIN: bin }, '/nowhere/a/b'), bin);
  const repo = mkTmp('floorhands-repo-');
  fs.mkdirSync(path.join(repo, 'bin'));
  fs.mkdirSync(path.join(repo, 'claude-plugin', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'bin', 'floorhands'), '');
  assert.equal(findCli({ HOME: '/nonexistent' }, path.join(repo, 'claude-plugin', 'hooks')), path.join(repo, 'bin', 'floorhands'));
  assert.equal(findCli({ HOME: '/nonexistent' }, '/nowhere/a/b'), null);
});

test('run does nothing inside a floorhands agent session', () => {
  let called = false;
  const out = run({ env: { FLOORHANDS_AGENT: '1', FLOORHANDS_BIN: mkBin().bin }, input: '{}', spawnSyncFn: () => { called = true; } });
  assert.equal(out, '');
  assert.equal(called, false);
});

test('run does nothing when the CLI cannot be found', () => {
  assert.equal(run({ env: { HOME: '/nonexistent' }, input: '{}', hookDir: '/nowhere/a/b', spawnSyncFn: () => { throw new Error('should not run'); } }), '');
});

test('run starts the CLI in the session folder with --if-enabled and returns its output', () => {
  const { bin } = mkBin();
  let seen;
  const out = run({
    env: { FLOORHANDS_BIN: bin },
    input: JSON.stringify({ cwd: '/work/site', hook_event_name: 'SessionStart' }),
    spawnSyncFn: (cmd, args, opts) => { seen = { cmd, args, opts }; return { stdout: 'floorhands → http://localhost:4600  (project: /work/site)\n' }; },
  });
  assert.equal(out, 'floorhands → http://localhost:4600  (project: /work/site)');
  assert.deepEqual(seen.args, [bin, 'start', '--if-enabled']);
  assert.equal(seen.opts.cwd, '/work/site');
  assert.equal(seen.opts.timeout, 15000);
});

test('run tolerates bad hook input and a failing CLI', () => {
  const { bin } = mkBin();
  assert.equal(run({ env: { FLOORHANDS_BIN: bin }, input: 'not json', spawnSyncFn: () => ({ stdout: '' }) }), '');
  assert.equal(run({ env: { FLOORHANDS_BIN: bin }, input: '{}', spawnSyncFn: () => ({ error: new Error('x') }) }), '');
});

test('run never throws: a throwing spawn, a null result, or non-string input all give an empty string', () => {
  const { bin } = mkBin();
  const env = { FLOORHANDS_BIN: bin };
  assert.equal(run({ env, input: '{}', spawnSyncFn: () => { throw new Error('spawn blew up'); } }), '');
  assert.equal(run({ env, input: '{}', spawnSyncFn: () => null }), '');
  assert.equal(run({ env, input: null, spawnSyncFn: () => ({ stdout: 'ok\n' }) }), 'ok');
  assert.equal(run({ env, input: '{"cwd": 42}', spawnSyncFn: (c, a, o) => ({ stdout: typeof o.cwd === 'string' ? 'ok' : 'bad-cwd' }) }), 'ok');
});

test('run prints at most one line, trimmed to 300 characters', () => {
  const { bin } = mkBin();
  const env = { FLOORHANDS_BIN: bin };
  assert.equal(run({ env, input: '{}', spawnSyncFn: () => ({ stdout: 'first line\nsecond line\nthird\n' }) }), 'first line');
  assert.equal(run({ env, input: '{}', spawnSyncFn: () => ({ stdout: '\n\n  padded  \nnext\n' }) }), 'padded');
  const long = run({ env, input: '{}', spawnSyncFn: () => ({ stdout: 'x'.repeat(1000) + '\nmore\n' }) });
  assert.equal(long.length, 300);
});

test('the hook script exits 0 and prints nothing when run directly with no CLI and garbage on stdin', () => {
  const r = spawnSync(process.execPath, [HOOK], {
    input: '\u0000not json{{',
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: '/nonexistent', FLOORHANDS_AGENT: '1' },
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('run directly, the hook script prints exactly one line from the CLI and exits 0', () => {
  const dir = mkTmp('floorhands-hook-e2e-');
  const bin = path.join(dir, 'floorhands');
  fs.writeFileSync(bin, 'console.log("floorhands -> http://localhost:1");\nconsole.log("extra line");\n');
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd: dir }),
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: '/nonexistent', FLOORHANDS_BIN: bin },
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'floorhands -> http://localhost:1\n');
});

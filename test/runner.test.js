import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runAgent, scrubEnv } from '../server/runner.js';

// A fake spawn that records its calls and replays canned stdout lines.
function fakeSpawn({ lines = [], chunks = null, stderr = '', code = 0, error = null, hang = false } = {}) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdinData = '';
    child.killed = false;
    child.signals = [];
    child.kill = sig => { child.killed = true; child.signals.push(sig); };
    child.stdin.on('data', d => { child.stdinData += d; });
    calls.push({ cmd, args, opts, child });
    setImmediate(() => {
      if (error) { child.emit('error', error); return; }
      if (hang) return;
      const finish = () => {
        child.stdout.end();
        if (stderr) child.stderr.write(stderr);
        child.stderr.end();
        setTimeout(() => child.emit('close', code), 20);
      };
      if (chunks) { // raw chunks, written one per tick, with no newline added
        const next = i => { if (i >= chunks.length) return finish(); child.stdout.write(chunks[i]); setImmediate(() => next(i + 1)); };
        next(0);
        return;
      }
      for (const l of lines) child.stdout.write(l + '\n');
      finish();
    });
    return child;
  };
  fn.calls = calls;
  return fn;
}

const agent = { id: 'rfe', name: 'FE REVIEWER', tier: 'read' };
const J = o => JSON.stringify(o);
const ok = text => J({ type: 'result', subtype: 'success', is_error: false, result: text, usage: { output_tokens: 3 } });
const base = extra => ({ agent, system: 'SYS', prompt: 'hello --not-a-flag', cwd: '/tmp/x', ...extra });

test('returns the result text, sends the prompt on stdin, and sets the child env', async () => {
  const spawnFn = fakeSpawn({ lines: [J({ type: 'system', subtype: 'init', tools: ['Read'] }), ok('  all good ')] });
  const savedCc = process.env.CLAUDECODE;
  process.env.CLAUDECODE = '1';
  let res;
  try {
    res = await runAgent(base({ spawnFn }));
  } finally {
    if (savedCc === undefined) delete process.env.CLAUDECODE; else process.env.CLAUDECODE = savedCc;
  }
  assert.equal(res.text, 'all good');
  assert.equal(res.usage.output_tokens, 3);
  const call = spawnFn.calls[0];
  assert.equal(call.cmd, 'claude');
  assert.equal(call.opts.cwd, '/tmp/x');
  assert.equal(call.opts.env.FLOORHANDS_AGENT, '1');
  assert.equal(call.opts.env.CLAUDECODE, undefined);
  assert.equal(call.child.stdinData, 'hello --not-a-flag');
  assert.ok(!call.args.includes('hello --not-a-flag'), 'prompt must not be in argv');
});

test('reports tool use and assistant text through onEvent', async () => {
  const lines = [
    J({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/a.js' } }] } }),
    J({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking' }] } }),
    'not json at all',
    ok('done'),
  ];
  const events = [];
  const res = await runAgent(base({ spawnFn: fakeSpawn({ lines }), onEvent: e => events.push(e) }));
  assert.deepEqual(events, [{ type: 'tool', name: 'Read', input: 'src/a.js' }, { type: 'text', text: 'Looking' }]);
  assert.deepEqual(res.tools, ['Read']);
});

test('rejects with a clear message when claude is not installed', async () => {
  const error = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
  await assert.rejects(runAgent(base({ spawnFn: fakeSpawn({ error }) })), /Claude Code is not installed/);
});

test('rejects with stderr when claude exits non-zero without a result (e.g. not logged in)', async () => {
  const spawnFn = fakeSpawn({ code: 1, stderr: 'Not logged in. Run claude to sign in.' });
  await assert.rejects(runAgent(base({ spawnFn })), /claude exited 1: Not logged in/);
});

test('rejects when the result is an error', async () => {
  const lines = [J({ type: 'result', is_error: true, result: 'Credit balance is too low' })];
  await assert.rejects(runAgent(base({ spawnFn: fakeSpawn({ lines }) })), /Credit balance is too low/);
});

test('rejects when claude exits cleanly but returns nothing', async () => {
  await assert.rejects(runAgent(base({ spawnFn: fakeSpawn({ lines: [] }) })), /returned no result/);
});

test('kills a hung process after the timeout', async () => {
  const spawnFn = fakeSpawn({ hang: true });
  await assert.rejects(runAgent(base({ spawnFn, timeoutMs: 40 })), /took longer than/);
  assert.equal(spawnFn.calls[0].child.killed, true);
  assert.deepEqual(spawnFn.calls[0].child.signals, ['SIGKILL']);
});

test('scrubEnv removes cloud, CI and secret-looking variables', () => {
  const env = {
    AWS_ACCESS_KEY_ID: 'a', aws_secret_access_key: 'b', GH_TOKEN: 'c', GITHUB_TOKEN: 'd', NPM_TOKEN: 'e',
    SSH_AUTH_SOCK: '/tmp/agent', DB_PASSWORD: 'f', MY_SECRET_THING: 'g', X_PRIVATE_KEY: 'h',
  };
  assert.deepEqual(scrubEnv(env), {});
});

test('scrubEnv keeps claude auth and ordinary variables', () => {
  const env = { ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't', PATH: '/usr/bin', HOME: '/home/me', AWS_REGION_X: 'drop' };
  assert.deepEqual(scrubEnv(env), { ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't', PATH: '/usr/bin', HOME: '/home/me' });
});

test('scrubEnv does not mutate its argument', () => {
  const env = { GH_TOKEN: 'c', PATH: '/usr/bin' };
  const out = scrubEnv(env);
  assert.deepEqual(env, { GH_TOKEN: 'c', PATH: '/usr/bin' });
  assert.notEqual(out, env);
});

test('runAgent does not pass the owner credentials to the child', async () => {
  const saved = { a: process.env.AWS_SECRET_ACCESS_KEY, g: process.env.GH_TOKEN };
  process.env.AWS_SECRET_ACCESS_KEY = 'leak-me';
  process.env.GH_TOKEN = 'leak-me-too';
  try {
    const spawnFn = fakeSpawn({ lines: [ok('fine')] });
    await runAgent(base({ spawnFn }));
    const env = spawnFn.calls[0].opts.env;
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.FLOORHANDS_AGENT, '1');
  } finally {
    if (saved.a === undefined) delete process.env.AWS_SECRET_ACCESS_KEY; else process.env.AWS_SECRET_ACCESS_KEY = saved.a;
    if (saved.g === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = saved.g;
  }
});

test('scrubEnv matches the exact-name secrets case-insensitively', () => {
  assert.deepEqual(scrubEnv({ gh_token: 'x', Npm_Token: 'y', ssh_auth_sock: 'z', PATH: '/usr/bin' }), { PATH: '/usr/bin' });
});

test('an onEvent that throws does not break the run', async () => {
  const lines = [
    J({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'a' } }, { type: 'text', text: 'hi' }] } }),
    ok('still fine'),
  ];
  let calls = 0;
  const res = await runAgent(base({ spawnFn: fakeSpawn({ lines }), onEvent: () => { calls++; throw new Error('sink exploded'); } }));
  assert.equal(res.text, 'still fine');
  assert.deepEqual(res.tools, ['Read']);
  assert.equal(calls, 2);
});

test('late output and close after a timeout are ignored', async () => {
  const spawnFn = fakeSpawn({ hang: true });
  let events = 0;
  await assert.rejects(runAgent(base({ spawnFn, timeoutMs: 30, onEvent: () => { events++; } })), /took longer than/);
  const { child } = spawnFn.calls[0];
  child.stdout.write(J({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } }) + '\n');
  child.stdout.write(ok('too late') + '\n');
  child.stderr.write('noise');
  child.emit('close', 0);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(events, 0);
});

test('late output after a spawn error is ignored', async () => {
  const spawnFn = fakeSpawn({ hang: true });
  const p = runAgent(base({ spawnFn }));
  await new Promise(r => setImmediate(r));
  const { child } = spawnFn.calls[0];
  child.emit('error', Object.assign(new Error('boom'), { code: 'EACCES' }));
  await assert.rejects(p, /boom/);
  child.stdout.write(ok('late') + '\n');
  child.emit('close', 0); // must not throw or settle again
  await new Promise(r => setTimeout(r, 10));
});

test('a stdout line split across chunks still parses', async () => {
  const line = ok('joined');
  const chunks = [line.slice(0, 15), line.slice(15, 40), line.slice(40) + '\n'];
  const res = await runAgent(base({ spawnFn: fakeSpawn({ chunks }) }));
  assert.equal(res.text, 'joined');
});

test('a final result line without a trailing newline is still parsed', async () => {
  const res = await runAgent(base({ spawnFn: fakeSpawn({ chunks: [ok('no newline')] }) }));
  assert.equal(res.text, 'no newline');
});

test('an is_error result with empty text names its subtype when present', async () => {
  const withSub = [J({ type: 'result', subtype: 'error_max_turns', is_error: true, result: '' })];
  await assert.rejects(runAgent(base({ spawnFn: fakeSpawn({ lines: withSub }) })), /^Error: claude reported an error \(error_max_turns\)$/);
  const without = [J({ type: 'result', is_error: true })];
  await assert.rejects(runAgent(base({ spawnFn: fakeSpawn({ lines: without }) })), /^Error: claude reported an error$/);
});

test('an unterminated line over 1 MB is dropped and the run still succeeds', async () => {
  const chunks = ['x'.repeat(1024 * 1024 + 10), '\n', ok('survived') + '\n'];
  const res = await runAgent(base({ spawnFn: fakeSpawn({ chunks }) }));
  assert.equal(res.text, 'survived');
});

test('only the last 8 KB of stderr is kept in the error message', async () => {
  const stderr = 'A'.repeat(20000) + 'TAIL-MARKER';
  const spawnFn = fakeSpawn({ code: 2, stderr });
  await assert.rejects(runAgent(base({ spawnFn })), e => /claude exited 2: /.test(e.message) && e.message.length < 400);
});

// Run fn while watching for an uncaught exception, which would take the whole server down.
async function noUncaught(fn) {
  const seen = [];
  const h = e => seen.push(e);
  process.on('uncaughtException', h);
  try {
    const out = await Promise.resolve().then(fn).then(v => ({ v }), e => ({ e }));
    await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(seen.map(String), [], 'no uncaught exception');
    return out;
  } finally {
    process.removeListener('uncaughtException', h);
  }
}

const MALFORMED = [
  'null', '5', '"x"', '[]', 'true',
  J({ type: 'assistant', message: { content: [null, 5, 'x'] } }),
  J({ type: 'assistant', message: null }),
  J({ type: 'assistant', message: { content: 'text' } }),
  J({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: null }, [], { type: 'text' }] } }),
];

test('malformed stream lines never throw and do not hide a valid result', async () => {
  const out = await noUncaught(() => runAgent(base({ timeoutMs: 1500, spawnFn: fakeSpawn({ lines: [...MALFORMED, ok('fine')] }) })));
  assert.equal(out.e, undefined);
  assert.equal(out.v.text, 'fine');
});

test('a malformed final line (no trailing newline) in the close handler does not throw', async () => {
  const out = await noUncaught(() => runAgent(base({ timeoutMs: 1500, spawnFn: fakeSpawn({ chunks: [ok('fine') + '\n', 'null'] }) })));
  assert.equal(out.v.text, 'fine');
});

test('a result line with an odd result type does not throw', async () => {
  const out = await noUncaught(() => runAgent(base({ timeoutMs: 1500, spawnFn: fakeSpawn({ lines: [J({ type: 'result', is_error: false, result: { a: 1 } })] }) })));
  assert.equal(out.e, undefined);
  assert.equal(typeof out.v.text, 'string');
});

test('only malformed lines rejects with the usual no-result error, not a TypeError', async () => {
  const out = await noUncaught(() => runAgent(base({ timeoutMs: 1500, spawnFn: fakeSpawn({ lines: MALFORMED }) })));
  assert.ok(out.e instanceof Error);
  assert.ok(!(out.e instanceof TypeError));
  assert.match(out.e.message, /returned no result/);
});

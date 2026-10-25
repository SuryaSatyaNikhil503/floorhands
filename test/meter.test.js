import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createMeter, estimateInputTokens, usageFrom, MIN_OUTPUT_TOKENS, defaultUpstream } from '../server/meter.js';
import { startFakeApi } from '../scripts/fake-anthropic.mjs';
import { costOf, worstCaseCost } from '../server/models.js';

const api = await startFakeApi();
const meter = createMeter({ upstream: new URL(api.url) });
await meter.start();
after(async () => { await meter.close(); await api.close(); });

const MODEL = 'claude-haiku-5-5';
const send = (run, body, { stream = false } = {}) => fetch(`${run.url}/v1/messages?beta=true`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer user-login' },
  body: JSON.stringify({ model: MODEL, max_tokens: 8000, stream, messages: [{ role: 'user', content: 'hi '.repeat(200) }], ...body }),
});
const lastUpstream = () => api.requests[api.requests.length - 1];

test('a request that fits goes through unchanged, with the caller\'s own credentials, and its real cost is counted', async () => {
  const run = meter.open({ budgetUsd: 5 });
  const before = api.requests.length;
  const r = await send(run, {});
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(api.requests.length, before + 1);
  assert.equal(lastUpstream().body.max_tokens, 8000);
  assert.equal(lastUpstream().path, '/v1/messages?beta=true', 'the run prefix is stripped');
  assert.equal(lastUpstream().headers['accept-encoding'], 'identity');
  assert.ok(run.spentUsd > 0);
  assert.equal(Math.round(run.spentUsd * 1e9), Math.round(costOf(MODEL, body.usage) * 1e9));
  run.close();
});

test('streamed responses are passed through byte for byte and their usage is read from the SSE events', async () => {
  const run = meter.open({ budgetUsd: 5 });
  const r = await send(run, {}, { stream: true });
  const text = await r.text();
  assert.match(text, /event: message_start/);
  assert.match(text, /event: message_stop/);
  assert.ok(run.spentUsd > 0);
  run.close();
});

test('when only a smaller answer fits, max_tokens is lowered so the turn cannot go over the cap', async () => {
  // Input is a few hundred tokens; this budget affords some output, but far less than 128k on Haiku.
  const run = meter.open({ budgetUsd: 0.01 });
  await (await send(run, { max_tokens: 128000 })).text();
  const sent = lastUpstream().body.max_tokens;
  assert.ok(sent < 128000 && sent >= MIN_OUTPUT_TOKENS, `sent max_tokens ${sent}`);
  assert.equal(run.clamped, 1);
  run.close();
});

test('when nothing useful fits, the request waits for the owner; stop answers 400 and nothing is sent', async () => {
  const asked = [];
  const run = meter.open({ budgetUsd: 0.0001, ask: async info => { asked.push(info); return { stop: true }; } });
  const events = [];
  run.on('pause', () => events.push('pause'));
  run.on('resume', () => events.push('resume'));
  const before = api.requests.length;
  const r = await send(run, {});
  assert.equal(r.status, 400);
  assert.match((await r.json()).error.message, /owner stopped this step at its spending cap/);
  assert.equal(api.requests.length, before, 'the request never reached the API');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].budgetUsd, 0.0001);
  assert.ok(asked[0].neededUsd > 0);
  assert.deepEqual(events, ['pause', 'resume']);
  assert.equal(run.report().stoppedByOwner, true);
  run.close();
});

test('when the owner allows more, the budget grows by exactly that and the request is sent', async () => {
  const run = meter.open({ budgetUsd: 0.0001, ask: async () => ({ allowUsd: 1 }) });
  const r = await send(run, {});
  assert.equal(r.status, 200);
  assert.equal(run.budgetUsd, 1.0001);
  run.close();
});

test('parallel requests that run out together trigger one question, and the answer is applied once', async () => {
  let questions = 0;
  let release;
  const gate = new Promise(r => { release = r; });
  const run = meter.open({ budgetUsd: 0.0001, ask: async () => { questions++; await gate; return { allowUsd: 0.5 }; } });
  const all = Promise.all([send(run, {}), send(run, {}), send(run, {})]);
  await new Promise(r => setTimeout(r, 50));
  release();
  const rs = await all;
  assert.deepEqual(rs.map(r => r.status), [200, 200, 200]);
  assert.equal(questions, 1);
  assert.equal(run.budgetUsd, 0.5001);
  run.close();
});

test('property: across many turns the spend never goes over the budget when the owner always says stop', async () => {
  for (const budget of [0.003, 0.01, 0.05]) {
    const run = meter.open({ budgetUsd: budget, ask: async () => ({ stop: true }) });
    for (let i = 0; i < 25; i++) {
      const r = await send(run, { max_tokens: 64000, messages: [{ role: 'user', content: 'x'.repeat(2000 + i * 500) }] });
      await r.text();
      if (r.status === 400) break;
    }
    assert.ok(run.spentUsd <= budget, `spent ${run.spentUsd} of ${budget}`);
    run.close();
  }
});

test('an unknown run path is refused and other endpoints pass through', async () => {
  const r = await fetch(`${new URL(meter.open({ budgetUsd: 1 }).url).origin}/r/${'0'.repeat(32)}/v1/messages`, { method: 'POST', body: '{}' });
  assert.equal(r.status, 404);
  const run = meter.open({ budgetUsd: 1 });
  const c = await fetch(`${run.url}/v1/messages/count_tokens`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"x","messages":[]}' });
  assert.equal(c.status, 200);
  assert.equal(run.spentUsd, 0, "token counting is free and not metered");
  assert.equal(run.report().meteredUsd, undefined, "no metered figure without requests");
  run.close();
});

test('the input estimate overestimates on purpose before any response, then follows the observed ratio with a margin', () => {
  assert.equal(estimateInputTokens(28000, null), 14000);
  assert.equal(estimateInputTokens(28000, { bytes: 28000, tokens: 10000 }), Math.ceil(28000 / (2.8 / 1.25)));
});

test('usageFrom reads SSE and JSON responses', () => {
  const sse = 'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-opus-5-5","usage":{"input_tokens":3,"cache_read_input_tokens":100,"cache_creation_input_tokens":50,"cache_creation":{"ephemeral_1h_input_tokens":20}}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n';
  assert.deepEqual(usageFrom(sse, 'x'), { usage: { input_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 50, cache_creation_1h: 20, output_tokens: 42 }, model: 'claude-opus-5-5' });
  assert.deepEqual(usageFrom('{"model":"m","usage":{"input_tokens":1,"output_tokens":2}}', 'x').usage, { input_tokens: 1, output_tokens: 2 });
});

test('worst-case pricing is never below the real cost of the same usage', () => {
  const real = costOf('claude-opus-5-5', { input_tokens: 10, cache_creation_input_tokens: 9000, cache_read_input_tokens: 1000, output_tokens: 500 });
  assert.ok(worstCaseCost('claude-opus-5-5', 10010, 500) >= real);
});

test('the upstream must be https, or http on this machine', () => {
  assert.equal(defaultUpstream({}).href, 'https://api.anthropic.com/');
  assert.equal(defaultUpstream({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:9000/x' }).href, 'http://127.0.0.1:9000/x');
  assert.throws(() => defaultUpstream({ ANTHROPIC_BASE_URL: 'http://evil.example' }), /must be https/);
});

test('a hung upstream stream is cut after the idle limit, so the CLI can retry instead of waiting', async () => {
  const http = await import('node:http');
  const hung = http.createServer((req, res) => { req.resume(); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: ping\ndata: {}\n\n'); /* then nothing */ });
  await new Promise(r => hung.listen(0, '127.0.0.1', r));
  const m = createMeter({ upstream: new URL(`http://127.0.0.1:${hung.address().port}`), idleMs: 200 });
  await m.start();
  const run = m.open({ budgetUsd: 5 });
  const t0 = Date.now();
  const outcome = await send(run, {}).then(r => r.text()).then(() => 'ended', e => `aborted: ${e.cause?.code ?? e.message}`);
  assert.ok(Date.now() - t0 < 3000, `cut quickly (${Date.now() - t0} ms)`);
  assert.match(outcome, /aborted|ended/);
  assert.equal(run.reservedUsd, 0, 'the reservation is released');
  await m.close();
  hung.closeAllConnections?.();
  await new Promise(r => hung.close(r));
});

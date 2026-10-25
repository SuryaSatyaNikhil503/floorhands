// The spending guard: a local metering proxy between each agent's claude CLI and the Anthropic API.
//
// The CLI's own --max-budget-usd is checked between model turns, so a step could go over its cap by one turn. Here every request is
// held before it is sent and priced at its worst case (every input token as a 1-hour cache write, every allowed output token used):
// - it fits what is left of the step's budget: it goes through unchanged;
// - only a smaller output allowance fits: max_tokens is lowered to that, so the turn cannot cost more than what is left;
// - not even a useful allowance fits: the request waits while the owner is asked, and is sent only if they allow more money.
// After a request finishes, its real cost (from the usage the API reports) is added to the step's spend.
//
// The proxy never holds credentials: the CLI sends its own login or key with each request, and the proxy forwards it to one fixed
// upstream (the owner's ANTHROPIC_BASE_URL, or api.anthropic.com). Each agent run gets an unguessable path, and the proxy listens on
// 127.0.0.1 only.
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { costOf, worstCaseCost, affordableOutput } from './models.js';

export const MIN_OUTPUT_TOKENS = 4096; // below this a turn is too short to be useful: ask instead of starving it
const MAX_BODY = 64 * 1024 * 1024;
const FIRST_BYTES_PER_TOKEN = 2; // before any response: about 2.8 bytes per token was measured, so this overestimates by ~40%
const SAFETY = 1.25; // margin on the bytes-per-token ratio observed for this run
// A stream that sends nothing for this long is treated as hung: the meter cuts it, and the CLI retries at once instead of waiting out
// its own (long) request timeout. The API sends ping events on long streams, so a healthy stream never goes this quiet.
export const UPSTREAM_IDLE_MS = 3 * 60 * 1000;
const DROP_HEADERS = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'transfer-encoding', 'keep-alive', 'proxy-connection']);

export function defaultUpstream(env = process.env) {
  const raw = env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  const u = new URL(raw);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))) {
    throw new Error(`ANTHROPIC_BASE_URL must be https (or http on this machine): ${raw}`);
  }
  return u;
}

// An upper bound on the prompt's tokens: the run's observed bytes-per-token with a margin, or a deliberately low ratio at first.
export function estimateInputTokens(bytes, observed) {
  const ratio = observed && observed.tokens > 0 ? Math.max(1, observed.bytes / observed.tokens / SAFETY) : FIRST_BYTES_PER_TOKEN;
  return Math.ceil(bytes / ratio);
}

// Reads token usage out of a streamed (SSE) or plain JSON Messages API response.
export function usageFrom(text, fallbackModel) {
  const usage = {};
  let model = fallbackModel;
  const take = (u = {}) => {
    for (const k of ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens']) if (Number.isFinite(u[k])) usage[k] = u[k];
    if (Number.isFinite(u.cache_creation?.ephemeral_1h_input_tokens)) usage.cache_creation_1h = u.cache_creation.ephemeral_1h_input_tokens;
  };
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{')) {
    try { const j = JSON.parse(trimmed); take(j.usage); if (j.model) model = j.model; } catch { /* not JSON */ }
    return { usage, model };
  }
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    let j;
    try { j = JSON.parse(line.slice(5)); } catch { continue; }
    if (j.type === 'message_start') { take(j.message?.usage); if (j.message?.model) model = j.message.model; }
    if (j.type === 'message_delta') take(j.usage);
  }
  return { usage, model };
}

export function createMeter({ upstream = defaultUpstream(), request = (upstream.protocol === 'https:' ? https.request : http.request), idleMs = UPSTREAM_IDLE_MS,
  log = process.env.FLOORHANDS_METER_LOG === '1' ? (...a) => console.error('[floorhands meter]', ...a) : null } = {}) {
  const runs = new Map();
  let base = null;

  const server = http.createServer((req, res) => {
    const m = /^\/r\/([a-f0-9]{32})(\/.*)$/.exec(req.url ?? '');
    const run = m && runs.get(m[1]);
    if (!run) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"type":"error","error":{"type":"not_found_error","message":"unknown floorhands run"}}'); }
    const rest = m[2];
    const chunks = [];
    let size = 0;
    req.on('data', d => { size += d.length; if (size > MAX_BODY) req.destroy(); else chunks.push(d); });
    req.on('end', () => { handle(run, req, res, rest, Buffer.concat(chunks)).catch(e => fail(res, 502, `floorhands meter: ${e.message}`)); });
  });

  const fail = (res, code, message, type = 'api_error') => {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type, message } }));
  };

  // Decide whether this request may go, possibly with a lower max_tokens, possibly after asking the owner. Returns the body to send,
  // or null when the owner stopped the step.
  async function admit(run, body, bytes) {
    for (;;) {
      const inputTokens = estimateInputTokens(bytes, run.observed);
      const maxTokens = Number.isInteger(body.max_tokens) && body.max_tokens > 0 ? body.max_tokens : 4096;
      const left = run.budgetUsd - run.spentUsd - run.reservedUsd;
      const afford = affordableOutput(body.model, inputTokens, left);
      if (afford >= maxTokens) return { body, reserve: worstCaseCost(body.model, inputTokens, maxTokens), inputTokens };
      if (afford >= MIN_OUTPUT_TOKENS) {
        run.clamped++;
        return { body: { ...body, max_tokens: afford }, reserve: worstCaseCost(body.model, inputTokens, afford), inputTokens };
      }
      // Ask once per run at a time: a retried or parallel request waits for the same answer.
      if (!run.pending) {
        const wanted = worstCaseCost(body.model, inputTokens, Math.min(maxTokens, 32_000));
        const info = { spentUsd: round(run.spentUsd), budgetUsd: round(run.budgetUsd), neededUsd: round(Math.max(0.01, wanted - Math.max(0, left))), model: body.model ?? null };
        run.pending = (async () => {
          run.emit('pause');
          try { return await run.ask(info); } finally { run.emit('resume'); }
        })().finally(() => { run.pending = null; });
      }
      const answer = await run.pending;
      if (!answer || answer.stop || !(answer.allowUsd > 0)) return null;
      // Several waiting requests share one answer: only the first applies the extra money.
      if (!answer.applied) { answer.applied = true; run.budgetUsd += answer.allowUsd; }
    }
  }

  async function handle(run, req, res, rest, raw) {
    // Build the target from the fixed upstream and pin it: a path like "//evil.example/x" must never resolve to another host
    // (the CLI's credentials travel with every request).
    if (!rest.startsWith('/') || rest.startsWith('//') || rest.includes('\\')) return fail(res, 400, 'floorhands meter: bad path', 'invalid_request_error');
    const target = new URL(upstream.href);
    const q = rest.indexOf('?');
    target.pathname = upstream.pathname.replace(/\/$/, '') + (q < 0 ? rest : rest.slice(0, q));
    target.search = q < 0 ? '' : rest.slice(q);
    if (target.protocol !== upstream.protocol || target.host !== upstream.host) return fail(res, 400, 'floorhands meter: bad upstream', 'invalid_request_error');
    const isMessages = req.method === 'POST' && /^\/v1\/messages(\?|$)/.test(rest);
    let send = raw, reserve = 0, model = null, inputTokens = 0;
    if (isMessages) {
      let body;
      try { body = JSON.parse(raw.toString('utf8')); } catch { return fail(res, 400, 'floorhands meter: request body is not JSON', 'invalid_request_error'); }
      const admitted = await admit(run, body, raw.length);
      if (!admitted) {
        run.stopped = true;
        // 400 is not retried by the CLI: the step ends with this message.
        return fail(res, 400, 'floorhands: the owner stopped this step at its spending cap', 'invalid_request_error');
      }
      reserve = admitted.reserve;
      model = admitted.body.model;
      inputTokens = admitted.inputTokens;
      run.reservedUsd += reserve;
      if (admitted.body !== body) send = Buffer.from(JSON.stringify(admitted.body));
    }
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!DROP_HEADERS.has(k.toLowerCase())) headers[k] = v;
    headers['content-length'] = String(send.length);
    headers['accept-encoding'] = 'identity'; // the meter reads usage from the response, so it must not be compressed
    const t0 = Date.now();
    let firstByte = null, bytesOut = 0;
    const trace = (what, extra = {}) => log?.(JSON.stringify({ run: run.id.slice(0, 6), what, path: rest.slice(0, 40), ms: Date.now() - t0, firstByteMs: firstByte, bytesOut, ...extra }));
    req.on('close', () => { if (!res.writableEnded) trace('client-closed-early'); });
    const up = request(target, { method: req.method, headers }, r => {
      const outHeaders = { ...r.headers };
      res.writeHead(r.statusCode ?? 502, outHeaders);
      let text = '';
      r.on('data', d => { if (firstByte === null) firstByte = Date.now() - t0; bytesOut += d.length; if (isMessages && text.length < 8 * 1024 * 1024) text += d.toString('utf8'); res.write(d); });
      r.on('end', () => {
        res.end();
        trace('done', { status: r.statusCode, maxTokens: isMessages ? JSON.parse(send.toString('utf8')).max_tokens : undefined });
        if (!isMessages) return;
        run.reservedUsd = Math.max(0, run.reservedUsd - reserve);
        if ((r.statusCode ?? 500) >= 400) return;
        const { usage, model: ran } = usageFrom(text, model);
        const usd = costOf(ran, usage);
        run.spentUsd += usd;
        run.requests++;
        const promptTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
        if (promptTokens > 0) run.observed = { bytes: send.length, tokens: promptTokens };
        run.lastEstimate = { estimated: inputTokens, actual: promptTokens };
      });
      r.on('error', e => { trace('upstream-error', { error: e.code ?? e.message }); run.reservedUsd = Math.max(0, run.reservedUsd - reserve); res.destroy(); });
    });
    up.setTimeout(idleMs, () => { trace('upstream-idle-timeout'); up.destroy(Object.assign(new Error('upstream idle'), { code: 'IDLE_TIMEOUT' })); });
    up.on('error', e => { run.reservedUsd = Math.max(0, run.reservedUsd - reserve); fail(res, 502, `floorhands meter: upstream unreachable (${e.code ?? e.message})`); });
    up.end(send);
  }

  const round = v => Math.round(v * 10000) / 10000;

  return {
    start: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(base); });
    }),
    close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); }),
    // One agent run. ask(info) resolves to { allowUsd } or { stop: true } when the budget runs out.
    open({ budgetUsd, ask = async () => ({ stop: true }) }) {
      if (!base) throw new Error('meter not started');
      const id = crypto.randomBytes(16).toString('hex');
      const listeners = { pause: new Set(), resume: new Set() };
      const run = {
        id, url: `${base}/r/${id}`, budgetUsd, spentUsd: 0, reservedUsd: 0, requests: 0, clamped: 0, stopped: false,
        observed: null, pending: null, lastEstimate: null, ask,
        emit: ev => { for (const fn of listeners[ev]) { try { fn(); } catch { /* listener errors never break the meter */ } } },
        on: (ev, fn) => { listeners[ev].add(fn); return () => listeners[ev].delete(fn); },
        close: () => { runs.delete(id); },
        // No requests seen means the meter has nothing to say about cost (meteredUsd is left out, not reported as $0).
        report: () => ({ ...(run.requests ? { meteredUsd: round(run.spentUsd) } : {}), budgetUsd: round(run.budgetUsd), meterRequests: run.requests, clampedRequests: run.clamped, stoppedByOwner: run.stopped }),
      };
      runs.set(id, run);
      return run;
    },
  };
}

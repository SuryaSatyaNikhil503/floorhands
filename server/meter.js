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

export function defaultUpstream(env = process.env) { // main.js passes ownerClaudeEnv(): the URL the CLI itself would use
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

// Reads token usage out of a streamed (SSE) or plain JSON Messages API response as it arrives. SSE is parsed line by line and only the
// latest usage is kept, so a long stream is never truncated (the output count comes in the final message_delta).
export function usageTracker(contentType = '') {
  const usage = {};
  let model = null, line = '', json = '', isJson = !/event-stream/i.test(contentType), decided = !!contentType, complete = false;
  const take = (u = {}) => {
    for (const k of ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens']) if (Number.isFinite(u[k])) usage[k] = u[k];
    if (Number.isFinite(u.cache_creation?.ephemeral_1h_input_tokens)) usage.cache_creation_1h = u.cache_creation.ephemeral_1h_input_tokens;
    if (typeof u.speed === 'string') usage.speed = u.speed;
  };
  const onLine = l => {
    if (!l.startsWith('data:')) return;
    let j;
    try { j = JSON.parse(l.slice(5)); } catch { return; }
    if (j.type === 'message_start') { take(j.message?.usage); if (j.message?.model) model = j.message.model; }
    if (j.type === 'message_delta') { take(j.usage); if (Number.isFinite(j.usage?.output_tokens)) complete = true; }
  };
  return {
    feed(chunk) {
      if (!decided) { isJson = chunk.trimStart().startsWith('{'); decided = true; }
      if (isJson) { if (json.length < 64 * 1024 * 1024) json += chunk; return; }
      line += chunk;
      let i;
      while ((i = line.indexOf('\n')) >= 0) { onLine(line.slice(0, i).replace(/\r$/, '')); line = line.slice(i + 1); }
      if (line.length > 4 * 1024 * 1024) line = ''; // a single line this long is not an event we need
    },
    result(fallbackModel) {
      if (isJson) {
        try { const j = JSON.parse(json); take(j.usage); if (j.model) model = j.model; complete = Number.isFinite(j.usage?.output_tokens); } catch { /* not JSON */ }
      } else if (line) onLine(line);
      return { usage: { ...usage }, model: model ?? fallbackModel, complete };
    },
  };
}

// For tests and one-off use: usage from a whole response text.
export function usageFrom(text, fallbackModel) {
  const t = usageTracker(text.trimStart().startsWith('{') ? 'application/json' : 'text/event-stream');
  t.feed(text);
  return t.result(fallbackModel);
}

// Images and documents are billed by pixels and pages, not bytes: they are counted separately with a generous fixed bound each, and
// their base64 bytes are left out of the byte-based estimate.
export const IMAGE_TOKENS_MAX = 8_000;
export const DOCUMENT_TOKENS_MAX = 150_000;
export function mediaOf(body) {
  const out = { images: 0, documents: 0, bytes: 0 };
  const walk = v => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (!v || typeof v !== 'object') return;
    if (v.type === 'image' || v.type === 'document') {
      out[v.type === 'image' ? 'images' : 'documents']++;
      if (typeof v.source?.data === 'string') out.bytes += v.source.data.length;
      return;
    }
    if (Array.isArray(v.content)) walk(v.content);
  };
  walk(body?.system);
  for (const m of body?.messages ?? []) walk(m?.content);
  return out;
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

  // Decide whether this request may go, possibly with a lower max_tokens, possibly after asking the owner. Returns what to send, or
  // null when the owner stopped the step. The affordability check and the reservation happen in one synchronous step (no await in
  // between), so requests that were waiting on the same answer cannot all spend the same headroom.
  async function admit(run, body, inputTokens) {
    const opts = { fast: body.speed === 'fast' };
    for (;;) {
      const maxTokens = Number.isInteger(body.max_tokens) && body.max_tokens > 0 ? body.max_tokens : 4096;
      const left = run.budgetUsd - run.spentUsd - run.reservedUsd;
      const afford = affordableOutput(body.model, inputTokens, left, opts);
      let send = null;
      if (afford >= maxTokens) send = body;
      else if (afford >= MIN_OUTPUT_TOKENS) { send = { ...body, max_tokens: afford }; run.clamped++; }
      if (send) {
        const reserve = worstCaseCost(body.model, inputTokens, send.max_tokens ?? maxTokens, opts);
        run.reservedUsd += reserve;
        run.started++;
        return { body: send, reserve };
      }
      // Ask once per run at a time: a retried or parallel request waits for the same answer.
      if (!run.pending) {
        const wanted = worstCaseCost(body.model, inputTokens, Math.min(maxTokens, 32_000), opts);
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

  // Exact input tokens from the API's free count endpoint, used when a request carries images or documents (billed by pixels and
  // pages, so bytes say little). Falls back to the fixed per-block bound when counting is not available.
  async function countTokens(target, headers, body) {
    const url = new URL(target.href);
    url.pathname = url.pathname.replace(/\/v1\/messages$/, '/v1/messages/count_tokens');
    url.search = '';
    const payload = Buffer.from(JSON.stringify({ model: body.model, messages: body.messages, ...(body.system ? { system: body.system } : {}), ...(body.tools ? { tools: body.tools } : {}) }));
    return new Promise(resolve => {
      const r = request(url, { method: 'POST', headers: { ...headers, 'content-length': String(payload.length) } }, res => {
        let t = '';
        res.on('data', d => { if (t.length < 65536) t += d; });
        res.on('end', () => { try { const n = JSON.parse(t).input_tokens; resolve(res.statusCode === 200 && Number.isFinite(n) ? n : null); } catch { resolve(null); } });
      });
      r.setTimeout(30_000, () => r.destroy());
      r.on('error', () => resolve(null));
      r.end(payload);
    });
  }

  async function handle(run, req, res, rest, raw) {
    // Build the target from the fixed upstream and pin it: a path like "//evil.example/x" must never resolve to another host, and no
    // dot segment may change the path after it was checked (the CLI's credentials travel with every request).
    if (!rest.startsWith('/') || rest.startsWith('//') || rest.includes('\\')) return fail(res, 400, 'floorhands meter: bad path', 'invalid_request_error');
    const q = rest.indexOf('?');
    const pathPart = q < 0 ? rest : rest.slice(0, q);
    const prefix = upstream.pathname.replace(/\/$/, '');
    const target = new URL(upstream.href);
    target.pathname = prefix + pathPart;
    target.search = q < 0 ? '' : rest.slice(q);
    if (target.protocol !== upstream.protocol || target.host !== upstream.host || target.pathname !== prefix + pathPart) {
      return fail(res, 400, 'floorhands meter: bad path', 'invalid_request_error');
    }
    const isMessages = req.method === 'POST' && pathPart === '/v1/messages';
    // Only what the CLI needs gets through: the metered messages endpoint, the free token counter, and its read-only checks.
    // Anything else (other POST endpoints, odd spellings such as /v1//messages or /V1/messages) would be unmetered spending.
    const allowed = isMessages || (req.method === 'POST' && pathPart === '/v1/messages/count_tokens') || (['GET', 'HEAD'].includes(req.method) && (pathPart === '/api/hello' || /^\/v1\/models(\/[\w.-]+)?$/.test(pathPart)));
    if (!allowed) return fail(res, 403, `floorhands meter: ${req.method} ${pathPart.slice(0, 60)} is not allowed through the spending guard`, 'permission_error');
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!DROP_HEADERS.has(k.toLowerCase())) headers[k] = v;
    headers['accept-encoding'] = 'identity'; // the meter reads usage from the response, so it must not be compressed
    let send = raw, reserve = 0, model = null, inputTokens = 0, sentMax;
    let released = false;
    const release = () => { if (!released) { released = true; run.reservedUsd = Math.max(0, run.reservedUsd - reserve); } };
    if (isMessages) {
      let body;
      try { body = JSON.parse(raw.toString('utf8')); } catch { return fail(res, 400, 'floorhands meter: request body is not JSON', 'invalid_request_error'); }
      const media = mediaOf(body);
      inputTokens = estimateInputTokens(raw.length - media.bytes, run.observed) + media.images * IMAGE_TOKENS_MAX + media.documents * DOCUMENT_TOKENS_MAX;
      if (media.images + media.documents > 0) {
        const exact = await countTokens(target, headers, body);
        if (exact !== null) inputTokens = Math.ceil(exact * 1.05);
      }
      const admitted = await admit(run, body, inputTokens);
      if (!admitted) {
        run.stopped = true;
        // 400 is not retried by the CLI: the step ends with this message.
        return fail(res, 400, 'floorhands: the owner stopped this step at its spending cap', 'invalid_request_error');
      }
      reserve = admitted.reserve;
      if (res.destroyed || req.socket?.destroyed) { release(); trace('client-gone-before-send'); return; }
      model = admitted.body.model;
      sentMax = admitted.body.max_tokens;
      if (admitted.body !== body) send = Buffer.from(JSON.stringify(admitted.body));
    }
    headers['content-length'] = String(send.length);
    const t0 = Date.now();
    let firstByte = null, bytesOut = 0;
    const trace = (what, extra = {}) => log?.(JSON.stringify({ run: run.id.slice(0, 6), what, path: pathPart.slice(0, 40), ms: Date.now() - t0, firstByteMs: firstByte, bytesOut, maxTokens: sentMax, ...extra }));
    req.on('close', () => { if (!res.writableEnded) trace('client-closed-early'); });
    // Charges what the API reported so far. Called once: at the end of the response, or when it is cut (a cut stream is billed for
    // its input and any output already produced).
    let charged = false;
    const charge = (tracker, status) => {
      if (charged) return;
      charged = true;
      release();
      if (!isMessages || !tracker || (status ?? 500) >= 400) return;
      const { usage, model: ran, complete } = tracker.result(model);
      if (!Object.keys(usage).length) return;
      // Cut before the final message_delta: the output already produced is billed but unknown (thinking tokens are not even
      // streamed), so charge the whole output allowance that was sent. Errs high, never low.
      if (!complete && Number.isInteger(sentMax)) usage.output_tokens = Math.max(usage.output_tokens ?? 0, sentMax);
      run.spentUsd += costOf(ran, usage, { fast: usage.speed === 'fast' });
      run.requests++;
      const promptTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
      if (promptTokens > 0) run.observed = { bytes: send.length, tokens: promptTokens };
      run.lastEstimate = { estimated: inputTokens, actual: promptTokens };
    };
    let tracker = null, status = null;
    const up = request(target, { method: req.method, headers }, r => {
      status = r.statusCode;
      res.writeHead(r.statusCode ?? 502, { ...r.headers });
      tracker = isMessages ? usageTracker(String(r.headers['content-type'] ?? '')) : null;
      r.on('data', d => {
        if (firstByte === null) firstByte = Date.now() - t0;
        bytesOut += d.length;
        tracker?.feed(d.toString('utf8'));
        if (!res.destroyed) res.write(d);
      });
      r.on('end', () => { res.end(); trace('done', { status: r.statusCode }); charge(tracker, status); });
      r.on('aborted', () => { trace('upstream-aborted'); charge(tracker, status); res.destroy(); });
      r.on('error', e => { trace('upstream-error', { error: e.code ?? e.message }); charge(tracker, status); res.destroy(); });
    });
    up.setTimeout(idleMs, () => { trace('upstream-idle-timeout'); up.destroy(Object.assign(new Error('upstream idle'), { code: 'IDLE_TIMEOUT' })); });
    up.on('error', e => { charge(tracker, status); fail(res, 502, `floorhands meter: upstream unreachable (${e.code ?? e.message})`); });
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
        observed: null, pending: null, lastEstimate: null, ask, started: 0,
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

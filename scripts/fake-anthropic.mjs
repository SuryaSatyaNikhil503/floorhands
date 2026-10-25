// A local stand-in for the Anthropic Messages API, for running the REAL claude CLI with no model and no API key:
//   ANTHROPIC_BASE_URL=http://127.0.0.1:<port> ANTHROPIC_API_KEY=fake claude -p ...
// The CLI does everything it normally does (permission checks, the Bash sandbox, hooks, settings loading); only the model is
// replaced. Each request is answered by a `respond(request, ctx)` function that returns the assistant's content blocks, so a test
// can script exactly which tool calls "the model" makes. Every request body is recorded, which also makes this a capture tool for
// studying what the CLI sends (prompt caching depends on those bytes).
import http from 'node:http';

const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

// Streams one assistant message in the Messages API SSE format: message_start, a start/delta/stop triple per content block,
// message_delta with the stop reason and usage, message_stop.
function streamMessage(res, { id, model, content, usage }) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'request-id': id });
  const stop = content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
  sse(res, 'message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: usage.input_tokens, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  content.forEach((b, index) => {
    if (b.type === 'text') {
      sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } });
    } else if (b.type === 'tool_use') {
      sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    }
    sse(res, 'content_block_stop', { type: 'content_block_stop', index });
  });
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

// Text of the last user turn and of every tool result so far, which is what a scripted responder usually needs.
export function lastUserText(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    const texts = (m.content ?? []).filter(b => b.type === 'text').map(b => b.text);
    if (texts.length) return texts.join('\n');
  }
  return '';
}
export function toolResults(body) {
  const out = [];
  for (const m of body?.messages ?? []) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type !== 'tool_result') continue;
      const c = typeof b.content === 'string' ? b.content : (b.content ?? []).map(x => x.text ?? '').join('\n');
      out.push({ id: b.tool_use_id, isError: !!b.is_error, text: c });
    }
  }
  return out;
}
export const firstUserText = body => {
  const m = (body?.messages ?? []).find(x => x.role === 'user');
  if (!m) return '';
  return typeof m.content === 'string' ? m.content : (m.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
};

export function startFakeApi({ respond = () => [{ type: 'text', text: 'OK' }], port = 0 } = {}) {
  const requests = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', d => { raw += d; });
    req.on('end', async () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      const rec = { method: req.method, path: req.url, headers: { ...req.headers }, body };
      delete rec.headers.authorization; delete rec.headers['x-api-key']; // never keep credentials in a capture
      requests.push(rec);
      const path = (req.url ?? '').split('?')[0];
      try {
        if (req.method === 'POST' && path === '/v1/messages/count_tokens') {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ input_tokens: Math.ceil(raw.length / 4) }));
        }
        if (req.method === 'POST' && path === '/v1/messages') {
          const id = `msg_fake_${++n}`;
          let content = await respond(body, { n, requests });
          if (!Array.isArray(content) || !content.length) content = [{ type: 'text', text: 'OK' }];
          content = content.map((b, i) => (b.type === 'tool_use' ? { id: b.id ?? `toolu_fake_${n}_${i}`, ...b } : b));
          const usage = { input_tokens: Math.ceil(raw.length / 4), output_tokens: Math.ceil(JSON.stringify(content).length / 4) };
          if (body?.stream) return streamMessage(res, { id, model: body.model ?? 'fake', content, usage });
          res.writeHead(200, { 'content-type': 'application/json', 'request-id': id });
          return res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: body?.model ?? 'fake', content,
            stop_reason: content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null, usage }));
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `fake API: no ${req.method} ${path}` } }));
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(e?.message ?? e) } }));
      }
    });
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}`;
    resolve({ url, requests, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }) });
  }));
}

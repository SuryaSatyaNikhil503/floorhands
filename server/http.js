import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { publicAgent } from './roster.js';
import { loadNotes } from './notes.js';

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const TASK_ROUTE = /^\/api\/tasks\/([^/]+)(?:\/(diff|approve|reject))?$/;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const CSP = "default-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'";
const MAX_BODY = 64 * 1024;
const MAX_DRAIN = 1024 * 1024;
const MAX_DIFF = 2 * 1024 * 1024;
const DIFF_NOTE = '\n… diff truncated …\n';
const JSON_TYPE = /^application\/json\s*(;|$)/i;

export function createHub() {
  const fns = new Set();
  return {
    // One failing subscriber must not stop the others or throw into the caller.
    emit: ev => { for (const fn of [...fns]) { try { fn(ev); } catch { /* subscriber failed; it removes itself */ } } },
    subscribe: fn => { fns.add(fn); return () => { fns.delete(fn); }; },
  };
}

const sameOrigin = (origin, host) => { try { return new URL(origin).host === host; } catch { return false; } };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, tooLarge = false;
    const chunks = [];
    const fail = () => reject(Object.assign(new Error('too large'), { tooLarge: true }));
    req.on('data', d => { // raw Buffers: the limit is in bytes
      size += d.length;
      if (size > MAX_BODY) { tooLarge = true; chunks.length = 0; if (size > MAX_DRAIN) req.destroy(); return; } // drain, so the client still gets its 413
      chunks.push(d);
    });
    req.on('end', () => (tooLarge ? fail() : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('close', () => { if (tooLarge) fail(); }); // destroyed while draining
    req.on('error', reject);
  });
}

export function createApp({ root, roster, store, orchestrator, hub, uiDir, log = console.error }) {
  const ui = path.resolve(uiDir);
  const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  return http.createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? '';
      if (!LOCAL_HOST.test(host)) return send(res, 403, { error: 'forbidden host' });
      let p;
      try { p = new URL(req.url, `http://${host}`).pathname; }
      catch { return send(res, 400, { error: 'bad request' }); }

      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if (origin && !sameOrigin(origin, host)) return send(res, 403, { error: 'forbidden origin' });
        if (!JSON_TYPE.test(req.headers['content-type'] ?? '')) return send(res, 415, { error: 'content-type must be application/json' });
        if (Number(req.headers['content-length']) > MAX_BODY) return send(res, 413, { error: 'request too large' }); // refuse before reading anything
      }

      if (req.method === 'GET' && p === '/api/health') return send(res, 200, { ok: true, name: 'floorhands', project: root });

      if (req.method === 'GET' && p === '/api/state') {
        const { path: notesFile, bytes } = loadNotes(root); // path and size only: the contents never leave the server
        return send(res, 200, { project: root, roster: { pods: roster.pods, agents: roster.agents.map(publicAgent) }, tasks: store.listTasks(root), notes: { path: notesFile, bytes } });
      }

      if (req.method === 'GET' && p === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', connection: 'keep-alive' });
        let off = null, ping = null, closed = false;
        const cleanup = () => { if (closed) return; closed = true; off?.(); clearInterval(ping); };
        const write = chunk => {
          if (closed) return;
          try { if (res.destroyed || res.writableEnded) cleanup(); else res.write(chunk); }
          catch { cleanup(); }
        };
        req.on('close', cleanup);
        res.on('error', cleanup);
        write('retry: 2000\n\n');
        off = hub.subscribe(ev => write(`data: ${JSON.stringify(ev)}\n\n`));
        if (closed) off(); // the client vanished during setup
        ping = setInterval(() => write(': ping\n\n'), 15000);
        ping.unref();
        return;
      }

      if (req.method === 'POST' && p === '/api/tasks') {
        let body;
        try { body = JSON.parse(await readBody(req)); }
        catch (e) { return send(res, e.tooLarge ? 413 : 400, { error: e.tooLarge ? 'request too large' : 'invalid JSON' }); }
        const isObject = body !== null && typeof body === 'object' && !Array.isArray(body);
        const text = isObject && typeof body.text === 'string' ? body.text.trim() : '';
        if (!text || text.length > 4000) return send(res, 400, { error: 'text is required (max 4000 characters)' });
        const task = store.createTask(root, text);
        hub.emit({ type: 'task', task: store.summary(task) });
        orchestrator.run(task.id).catch(e => log('[floorhands]', e));
        return send(res, 201, { id: task.id });
      }

      const m = TASK_ROUTE.exec(p);
      if (m) {
        const [, id, action] = m;
        const task = store.getTask(root, id);
        if (!task) return send(res, 404, { error: 'not found' });
        if (req.method === 'GET' && !action) return send(res, 200, task);
        if (req.method === 'GET' && action === 'diff') {
          let diff;
          try { diff = String((await orchestrator.diff(id)) ?? ''); }
          catch (e) { return send(res, 409, { error: e.message }); }
          if (Buffer.byteLength(diff) > MAX_DIFF) diff = Buffer.from(diff).subarray(0, MAX_DIFF).toString('utf8').replace(/\uFFFD$/, '') + DIFF_NOTE;
          return send(res, 200, diff, 'text/plain; charset=utf-8');
        }
        if (req.method === 'POST' && (action === 'approve' || action === 'reject')) {
          req.resume();
          try { await orchestrator[action](id); return send(res, 200, { ok: true }); }
          catch (e) { return send(res, 409, { error: e.message }); }
        }
      }

      if (req.method === 'GET' && !p.startsWith('/api/')) {
        const file = path.join(ui, p === '/' ? 'index.html' : p.slice(1));
        const type = MIME[path.extname(file)];
        if (type && file.startsWith(ui + path.sep)) {
          return fs.readFile(file, (err, buf) => {
            if (err) return send(res, 404, { error: 'not found' });
            res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': CSP });
            res.end(buf);
          });
        }
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      log('[floorhands]', e);
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
      else res.end();
    }
  });
}

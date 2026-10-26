// The server process. Started by the CLI (detached); one per project root.
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as store from './store.js';
import * as wt from './worktree.js';
import { loadRoster } from './roster.js';
import { runAgent } from './runner.js';
import { loadPolicy } from './models.js';
import { createMeter, defaultUpstream } from './meter.js';
import { ownerClaudeEnv } from './runner.js';
import { createOrchestrator } from './orchestrator.js';
import { createApp, createHub } from './http.js';
import { writeServerInfo, clearServerInfo, acquireLock, releaseLock } from './state.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// Keep serving whatever happens inside one request or one agent run.
process.on('unhandledRejection', e => console.error('[floorhands] unhandled rejection', e));

const root = arg('--root');
if (!root) { console.error('usage: main.js --root <project folder>'); process.exit(2); }

// One server per project root, decided before anything is touched (no recovery pass, no listening, no server.json).
const lock = await acquireLock(root);
if (lock === 'other') { console.log(`already running for ${root}`); process.exit(0); }
if (lock !== 'acquired') { console.error(`could not take the server lock for ${root}`); process.exit(1); }
process.on('exit', () => releaseLock(root));

const claudeBin = process.env.FLOORHANDS_CLAUDE_BIN || 'claude';
const roster = loadRoster(path.join(REPO, 'agents'));
// A broken owner policy stops the server instead of silently running every step on the (possibly dearer) defaults.
let policy;
try { policy = loadPolicy(); } catch (e) { console.error(`floorhands: ${e.message}`); process.exit(1); }
const token = crypto.randomBytes(32).toString('base64url');
// The spending guard every agent's model requests go through (server/meter.js). FLOORHANDS_METER=off falls back to the CLI's own cap.
let meter = null;
if (process.env.FLOORHANDS_METER !== 'off') {
  try { meter = createMeter({ upstream: defaultUpstream(ownerClaudeEnv()) }); await meter.start(); } catch (e) { console.error(`floorhands: ${e.message}`); process.exit(1); }
}
const hub = createHub();
const orchestrator = createOrchestrator({
  root, roster, store, wt, emit: hub.emit, policy, meter,
  runner: opts => runAgent({ ...opts, claudeBin }),
});
const server = createApp({
  root, roster, store, orchestrator, hub, uiDir: path.join(REPO, 'ui'), token, policy,
  log: (...a) => console.error('[floorhands]', ...a),
});

const recovered = store.recoverInterrupted(root);
if (recovered) console.log(`marked ${recovered} interrupted task(s) as failed`);

function listen(port, tries = 20) {
  return new Promise((resolve, reject) => {
    server.once('error', e => {
      if (e.code === 'EADDRINUSE' && tries > 1) resolve(listen(port + 1, tries - 1));
      else reject(e);
    });
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

const port = await listen(Number(process.env.FLOORHANDS_PORT) || 4600);
writeServerInfo(root, { pid: process.pid, port, token, startedAt: new Date().toISOString() });
console.log(`floorhands listening on http://localhost:${port} for ${root}`);

const shutdown = () => {
  clearServerInfo(root);
  releaseLock(root);
  setTimeout(() => process.exit(0), 2000).unref();
  server.closeAllConnections?.();
  server.close(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

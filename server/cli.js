import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from './store.js';
import { loadNotes } from './notes.js';
import { loadPolicy, policyPath } from './models.js';
import {
  findProjectRoot, readServerInfo, clearServerInfo, isEnabled, setEnabled, ensureExclude, pidAlive, serverUp,
} from './state.js';

const MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'main.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const HELP = `floorhands — an office of Claude-powered engineering agents.

  floorhands start [--if-enabled]   start the office for this project and print its URL
  floorhands open                   start it and open the page in your browser
  floorhands status                 is it running? is auto-start on?
  floorhands stop                   stop this project's office
  floorhands enable | disable       turn auto-start (Claude Code session hook) on or off for this project
  floorhands notes                  show your standing notes for this project (kept outside the repository) and where to edit them
  floorhands url                    print the page link with this run's access token (keep it private)
  floorhands models                 show which model, effort and spending cap each kind of step uses, and where to change them
`;

// The token travels in the fragment, which the browser keeps to itself; the page moves it into a header and drops it from the URL.
const pageUrl = info => `http://localhost:${info.port}/${info.token ? `#t=${encodeURIComponent(info.token)}` : ''}`;

async function live(root) {
  const info = readServerInfo(root);
  return info && (await serverUp(info.port, root)) ? info : null;
}

const MAX_LOG = 5 * 1024 * 1024;

async function start(root, { ifEnabled }, out) {
  if (process.env.FLOORHANDS_AGENT === '1') return { code: 0 };
  if (ifEnabled && !isEnabled(root)) return { code: 0 };
  let info = await live(root);
  if (!info) {
    fs.mkdirSync(stateDir(root), { recursive: true });
    ensureExclude(root);
    // A server.json with a live pid is not cleared here: a health check can fail transiently, and the server itself
    // refuses to run twice (lock) and rewrites server.json when it is ready.
    const logFile = path.join(stateDir(root), 'server.log');
    let failed = false;
    let child;
    try {
      try { if (fs.statSync(logFile).size > MAX_LOG) fs.truncateSync(logFile, 0); } catch { /* no log yet */ }
      const log = fs.openSync(logFile, 'a', 0o600);
      try {
        child = spawn(process.execPath, [MAIN, '--root', root], { detached: true, stdio: ['ignore', log, log], env: process.env });
      } finally {
        fs.closeSync(log);
      }
      // A server that finds another one already running exits 0: keep waiting for that one's address.
      child.on('exit', code => { if (code !== 0) failed = true; });
      child.on('error', () => { failed = true; });
      child.unref();
    } catch {
      out.write(`floorhands could not start. See ${logFile}\n`);
      return { code: 1 };
    }
    const deadline = Date.now() + 8000;
    while (!info && !failed && Date.now() < deadline) { await sleep(200); info = await live(root); }
    if (!info) {
      if (!failed) { try { process.kill(child.pid, 'SIGTERM'); } catch { /* already gone */ } }
      out.write(`floorhands did not start. See ${logFile}\n`);
      return { code: 1 };
    }
  }
  out.write(`floorhands → http://localhost:${info.port}  (project: ${root})\n`);
  out.write('open the page with "floorhands open" (or print the link with "floorhands url"): the page needs this run\'s access token\n');
  return { code: 0, info };
}

async function waitDead(pid, ms) {
  for (let t = 0; t < ms && pidAlive(pid); t += 100) await sleep(100);
  return !pidAlive(pid);
}

async function stop(root, out) {
  const info = readServerInfo(root);
  if (!info) { out.write('not running\n'); return 0; }
  // The pid may have been reused by an unrelated process: only signal it if it answers as our server.
  if (!(await serverUp(info.port, root))) {
    clearServerInfo(root);
    out.write('not running (stale record removed)\n');
    return 0;
  }
  try { process.kill(info.pid, 'SIGTERM'); } catch { /* already gone */ }
  if (!(await waitDead(info.pid, 2500))) {
    try { process.kill(info.pid, 'SIGKILL'); } catch { /* already gone */ }
    await waitDead(info.pid, 1000);
  }
  clearServerInfo(root);
  out.write('stopped\n');
  return 0;
}

export async function main(argv, { out = process.stdout, cwd = process.cwd() } = {}) {
  const [cmd = 'help', ...rest] = argv;
  const known = ['start', 'open', 'status', 'stop', 'enable', 'disable', 'notes', 'url', 'models'];
  if (known.includes(cmd)) {
    const bad = rest.find(a => !(cmd === 'start' && a === '--if-enabled'));
    if (bad !== undefined) {
      out.write(`${bad.startsWith('-') ? 'unknown option' : 'unexpected argument'} "${bad}"\n\n${HELP}`);
      return 2;
    }
  }
  const root = findProjectRoot(cwd);
  switch (cmd) {
    case 'start':
      return (await start(root, { ifEnabled: rest.includes('--if-enabled') }, out)).code;
    case 'open': {
      const r = await start(root, {}, out);
      if (r.info) {
        const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
        const url = pageUrl(r.info);
        const child = spawn(opener, process.platform === 'win32' ? ['/c', 'start', '', url] : [url], { detached: true, stdio: 'ignore' });
        child.on('error', () => {}); // no opener installed: the URL was already printed
        child.unref();
      }
      return r.code;
    }
    case 'status': {
      const info = await live(root);
      out.write(info ? `running at http://localhost:${info.port}\n` : 'not running\n');
      out.write(`project: ${root}\nauto-start: ${isEnabled(root) ? 'on' : 'off'}\n`);
      return 0;
    }
    case 'url': {
      const info = await live(root);
      if (!info) { out.write('not running (start it with "floorhands start")\n'); return 1; }
      out.write(`${pageUrl(info)}\n`);
      return 0;
    }
    case 'models': {
      let policy;
      try { policy = loadPolicy(); } catch (e) { out.write(`${e.message}\n`); return 1; }
      out.write(`policy file: ${policyPath()}${fs.existsSync(policyPath()) ? '' : ' (not created; these are the defaults)'}\n`);
      for (const [name, c] of Object.entries(policy.classes)) {
        out.write(`  ${name.padEnd(9)} model ${c.model}${c.fallback ? ` (falls back to ${c.fallback})` : ''}, effort ${c.effort ?? 'default'}, cap $${c.budgetUsd} per step\n`);
      }
      out.write(`  per task: cap $${policy.taskBudgetUsd}; at most ${policy.maxConcurrentTasks} task(s) at once\n`);
      return 0;
    }
    case 'stop':
      return stop(root, out);
    case 'enable':
      setEnabled(root, true);
      out.write(`auto-start on for ${root}\n`);
      return 0;
    case 'disable':
      setEnabled(root, false);
      out.write(`auto-start off for ${root}\n`);
      return 0;
    case 'notes': {
      const n = loadNotes(root);
      out.write(`notes file: ${n.path}\n`);
      out.write(n.text ? `${n.text}${n.text.endsWith('\n') ? '' : '\n'}` : '(no notes yet, create the file above with your editor)\n');
      return 0;
    }
    case 'help': case '--help': case '-h':
      out.write(HELP);
      return 0;
    default:
      out.write(`unknown command "${cmd}"\n\n${HELP}`);
      return 2;
  }
}

import { spawn } from 'node:child_process';
import { buildClaudeArgs } from './tiers.js';

const summarize = input => {
  if (!input || typeof input !== 'object') return '';
  const v = input.file_path ?? input.command ?? input.pattern ?? input.path ?? input.skill ?? '';
  return String(v).slice(0, 200);
};

const MAX_LINE = 1024 * 1024; // an unterminated stdout line longer than this is dropped
const MAX_ERR = 8 * 1024; // keep only the tail of stderr

const EXACT_SECRETS = new Set(['GH_TOKEN', 'GITHUB_TOKEN', 'NPM_TOKEN', 'SSH_AUTH_SOCK']);

// Agents must not inherit the owner's cloud/CI credentials. ANTHROPIC_* and CLAUDE_* are kept: the claude CLI needs them to log in.
export function scrubEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^AWS_/i.test(k) || EXACT_SECRETS.has(k.toUpperCase()) || /(SECRET|PASSWORD|PASSWD|PRIVATE_KEY)/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

export function runAgent({ agent, system, prompt, cwd, onEvent = () => {}, spawnFn = spawn, claudeBin = 'claude', timeoutMs = 15 * 60 * 1000, model }) {
  return new Promise((resolve, reject) => {
    const env = { ...scrubEnv(process.env), FLOORHANDS_AGENT: '1' };
    delete env.CLAUDECODE; // the CLI refuses to nest inside another Claude Code session
    let child;
    try {
      child = spawnFn(claudeBin, buildClaudeArgs({ agent, system, model }), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(e);
    }
    let buf = '', err = '', text = '', gotResult = false, isError = false, usage = null, subtype = '';
    let settled = false;
    const tools = [];
    // Settle at most once, and always clear the timer.
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    // An event sink must never be able to kill the run.
    const emit = ev => { try { onEvent(ev); } catch { /* ignore */ } };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      done(reject, new Error(`${agent.name} took longer than ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);

    const feed = line => {
      // Nothing parsed from the stream may throw out of a stream handler: that would be an uncaught exception and stop the server.
      try {
        if (!line.trim()) return;
        const j = JSON.parse(line);
        if (!j || typeof j !== 'object') return;
        const content = j.message?.content;
        if (j.type === 'assistant' && Array.isArray(content)) {
          for (const b of content) {
            if (!b || typeof b !== 'object') continue;
            if (b.type === 'tool_use' && b.name) { tools.push(b.name); emit({ type: 'tool', name: b.name, input: summarize(b.input) }); }
            else if (b.type === 'text' && b.text) emit({ type: 'text', text: b.text });
          }
        }
        if (j.type === 'result') { gotResult = true; text = String(j.result ?? '').trim(); isError = !!j.is_error; usage = j.usage ?? null; subtype = typeof j.subtype === 'string' ? j.subtype : ''; }
      } catch { /* ignore a line we cannot make sense of */ }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', d => {
      if (settled) return;
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { feed(buf.slice(0, i)); buf = buf.slice(i + 1); }
      if (buf.length > MAX_LINE) buf = '';
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', d => { if (!settled) err = (err + d).slice(-MAX_ERR); });
    child.on('error', e => {
      done(reject, new Error(e.code === 'ENOENT' ? 'Claude Code is not installed (claude not found on PATH)' : e.message));
    });
    child.on('close', code => {
      if (settled) return;
      feed(buf);
      if (!gotResult) return done(reject, new Error(code === 0 ? 'Claude returned no result' : `claude exited ${code}${err ? ': ' + err.trim().slice(0, 300) : ''}`));
      if (isError) return done(reject, new Error(text || `claude reported an error${subtype ? ` (${subtype})` : ''}`));
      done(resolve, { text, tools, usage });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

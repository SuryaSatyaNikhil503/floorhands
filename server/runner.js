import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildClaudeArgs } from './tiers.js';

const summarize = input => {
  if (!input || typeof input !== 'object') return '';
  const v = input.file_path ?? input.command ?? input.pattern ?? input.path ?? input.skill ?? '';
  return String(v).slice(0, 200);
};

const MAX_LINE = 1024 * 1024; // an unterminated stdout line longer than this is dropped
const MAX_ERR = 8 * 1024; // keep only the tail of stderr

// Agents get an ALLOW list of environment variables, not the owner's whole environment minus a few names: a deny list let
// GITLAB_TOKEN, OPENAI_API_KEY, DATABASE_URL and anything else secret-looking through (known limit 7 in 0.2.0). ANTHROPIC_* and
// CLAUDE_* stay because the claude CLI needs them to log in; proxies and CA bundles stay because the CLI cannot reach the API
// without them on some networks. The owner can add names with FLOORHANDS_ENV_ALLOW=NAME,NAME (e.g. Bedrock or Vertex settings).
const ENV_EXACT = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LANGUAGE', 'TERM', 'TZ', 'COLORTERM', 'NO_COLOR',
  'FORCE_COLOR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR',
  '__CF_USER_TEXT_ENCODING',
]);
const ENV_PREFIXES = ['LC_', 'ANTHROPIC_', 'CLAUDE_'];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export function extraEnvAllow(value = process.env.FLOORHANDS_ENV_ALLOW) {
  return String(value ?? '').split(',').map(s => s.trim()).filter(n => ENV_NAME.test(n));
}

export function scrubEnv(env, extra = extraEnvAllow()) {
  const allowed = new Set(extra);
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (ENV_EXACT.has(k) || ENV_PREFIXES.some(p => k.startsWith(p)) || allowed.has(k)) out[k] = v;
  }
  delete out.CLAUDECODE; // the CLI refuses to nest inside another Claude Code session
  return out;
}

// Git config every agent's git commands run with (environment-level config beats the repository's .git/config). It switches off the
// programs a hostile or careless repository config can start from a read-only command: fsmonitor (run by git status), hooks, ssh
// and every network transport. diff.external and textconv drivers cannot be switched off this way (an empty value breaks git diff),
// so the sandbox contains those instead.
export const AGENT_GIT_CONFIG = Object.freeze([
  ['core.fsmonitor', 'false'], ['core.hooksPath', '/dev/null'], ['core.sshCommand', '/bin/false'], ['protocol.allow', 'never'],
]);

export function agentEnv(env = process.env) {
  const out = { ...scrubEnv(env), FLOORHANDS_AGENT: '1', GIT_CONFIG_COUNT: String(AGENT_GIT_CONFIG.length), GIT_TERMINAL_PROMPT: '0' };
  AGENT_GIT_CONFIG.forEach(([k, v], i) => { out[`GIT_CONFIG_KEY_${i}`] = k; out[`GIT_CONFIG_VALUE_${i}`] = v; });
  return out;
}

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// The run report kept per step: what it cost and which model actually ran (an alias such as "opus" moves, and a fallback can switch
// the model mid-run, so the requested model is not evidence). Permission refusals are counted, never stored with their content.
export function runMetrics({ init, result, denials }) {
  const usage = result?.usage && typeof result.usage === 'object' ? result.usage : {};
  const modelUsage = result?.modelUsage && typeof result.modelUsage === 'object' ? result.modelUsage : {};
  return {
    model: typeof init?.model === 'string' ? init.model.slice(0, 80) : null,
    modelsUsed: Object.keys(modelUsage).slice(0, 8).map(m => m.slice(0, 80)),
    cliVersion: typeof init?.claude_code_version === 'string' ? init.claude_code_version.slice(0, 40) : null,
    costUsd: num(result?.total_cost_usd),
    durationMs: num(result?.duration_ms),
    turns: num(result?.num_turns),
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    cacheWriteTokens: num(usage.cache_creation_input_tokens),
    denials: Array.isArray(result?.permission_denials) ? result.permission_denials.length : denials,
    subtype: typeof result?.subtype === 'string' ? result.subtype.slice(0, 40) : null,
  };
}

// The system prompt goes to the CLI as a file only the owner can read, in a private directory removed after the run: on the command
// line it was visible to every user of the machine through the process list (known limit 16 in 0.2.0).
function writeSystemFile(system) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floorhands-sys-'));
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, 'system.md');
  fs.writeFileSync(file, system, { mode: 0o600, flag: 'wx' });
  return { file: fs.realpathSync(file), remove: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } } };
}

export function runAgent({ agent, system, prompt, cwd, onEvent = () => {}, spawnFn = spawn, claudeBin = 'claude', timeoutMs = 15 * 60 * 1000,
  model, effort, fallback, budgetUsd, skills = false, meter = null }) {
  return new Promise((resolve, reject) => {
    const env = agentEnv(process.env);
    if (meter) {
      // Every model request goes through the spending guard (server/meter.js). The CLI waits up to an hour for an answer, so a
      // request held while the owner decides on more budget is not abandoned and retried.
      env.ANTHROPIC_BASE_URL = meter.url;
      env.API_TIMEOUT_MS = String(60 * 60 * 1000);
    }
    let child, sys;
    try {
      sys = writeSystemFile(system);
      child = spawnFn(claudeBin, buildClaudeArgs({ agent, systemFile: sys.file, model, effort, fallback, budgetUsd: meter ? undefined : budgetUsd, skills }), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      sys?.remove();
      return reject(e);
    }
    let buf = '', err = '', text = '', gotResult = false, isError = false, usage = null, subtype = '';
    let init = null, result = null, denials = 0, offPause = null, offResume = null;
    let settled = false;
    const tools = [];
    // Settle at most once, and always clear the timer and remove the system prompt file.
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      offPause?.(); offResume?.();
      sys.remove();
      fn(value);
    };
    // An event sink must never be able to kill the run.
    const emit = ev => { try { onEvent(ev); } catch { /* ignore */ } };
    // The time limit counts only time the agent is working: while the spending guard waits for the owner, the clock stops.
    let left = timeoutMs, since = Date.now(), timer = null;
    const arm = () => { since = Date.now(); timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      done(reject, new Error(`${agent.name} took longer than ${Math.round(timeoutMs / 1000)} s`));
    }, left); };
    arm();
    offPause = meter?.on('pause', () => { clearTimeout(timer); left = Math.max(1000, left - (Date.now() - since)); });
    offResume = meter?.on('resume', () => { if (!settled) arm(); });

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
        if (j.type === 'system' && j.subtype === 'init') init = j;
        if (j.type === 'user' && Array.isArray(content)) {
          for (const b of content) if (b?.type === 'tool_result' && b.is_error && /Permission to use/.test(JSON.stringify(b.content ?? '').slice(0, 300))) denials++;
        }
        if (j.type === 'result') { gotResult = true; result = j; text = String(j.result ?? '').trim(); isError = !!j.is_error; usage = j.usage ?? null; subtype = typeof j.subtype === 'string' ? j.subtype : ''; }
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
      const metrics = { ...runMetrics({ init, result, denials }), ...(meter ? meter.report() : {}) };
      if (isError || subtype === 'error_max_budget_usd') {
        const msg = subtype === 'error_max_budget_usd'
          ? `${agent.name} stopped at its spending cap of $${budgetUsd} for this step`
          : text || `claude reported an error${subtype ? ` (${subtype})` : ''}`;
        return done(reject, Object.assign(new Error(msg), { metrics }));
      }
      done(resolve, { text, tools, usage, metrics });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

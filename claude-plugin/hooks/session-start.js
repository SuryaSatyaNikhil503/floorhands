#!/usr/bin/env node
// Claude Code SessionStart hook: start floorhands for this project if (and only if) it was enabled with `floorhands enable`.
// Self-contained on purpose: when installed from a marketplace only this plugin folder is copied, not the repo.
// It must never block or break a session: every failure is swallowed, it prints at most one line, and it always exits 0.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_LINE = 300;

export function findCli(env = process.env, hookDir = HERE) {
  const candidates = [
    env.FLOORHANDS_BIN,
    path.join(hookDir, '..', '..', 'bin', 'floorhands'),
    path.join(env.HOME || os.homedir(), '.local', 'bin', 'floorhands'),
  ].filter(Boolean);
  return candidates.find(p => fs.existsSync(p)) ?? null;
}

export function run({ env = process.env, input = '', spawnSyncFn = spawnSync, hookDir = HERE } = {}) {
  try {
    if (env.FLOORHANDS_AGENT === '1') return '';
    const cli = findCli(env, hookDir);
    if (!cli) return '';
    let cwd = process.cwd();
    try {
      const given = JSON.parse(input).cwd;
      if (typeof given === 'string' && given) cwd = given;
    } catch { /* use the process cwd */ }
    const r = spawnSyncFn(process.execPath, [cli, 'start', '--if-enabled'], { cwd, encoding: 'utf8', timeout: 15000, env });
    if (!r || r.error) return '';
    const firstLine = String(r.stdout ?? '').split('\n').map(l => l.trim()).find(Boolean) ?? '';
    return firstLine.slice(0, MAX_LINE);
  } catch {
    return '';
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const finish = (input) => {
    try {
      const out = run({ input });
      if (out) process.stdout.write(out + '\n');
    } catch { /* never break the session */ }
    process.exitCode = 0;
  };
  let input = '';
  try {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', d => { input += d; });
    process.stdin.on('end', () => finish(input));
    process.stdin.on('error', () => finish(''));
  } catch {
    finish('');
  }
}

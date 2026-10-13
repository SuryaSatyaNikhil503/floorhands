#!/usr/bin/env node
// End-to-end check with the REAL claude CLI: a review task against a throwaway repo.
// Spends a few real requests on your Claude login. Not part of `npm test`.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The review must name an injection problem in connection with SQL.
export const INJECTION_RE = /sql[\s\S]{0,60}inject|inject[\s\S]{0,60}sql/i;

// Pure: turns a finished task into [name, ok, detail] checks. `workingCopyClean` comes from `git status`.
export function evaluate(task, { workingCopyClean = true } = {}) {
  const steps = Array.isArray(task?.steps) ? task.steps : [];
  const rbe = steps.find(s => s.agent === 'rbe');
  return [
    ['task finished without error', task?.status === 'done' && !task?.error, task?.error ?? task?.status],
    ['the back-end reviewer was used', Boolean(rbe), 'the back-end reviewer was not used'],
    ['the review found the SQL injection', Boolean(rbe) && INJECTION_RE.test(String(rbe.output ?? '')), rbe ? 'no SQL injection finding in the back-end reviewer output' : 'no back-end reviewer output to check'],
    ['the working copy was not modified', workingCopyClean, 'git status is not clean'],
  ];
}

async function main() {
  const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'floorhands');
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'floorhands-smoke-')));
  // FLOORHANDS_HOME is a sibling directory so worktrees can never make the repository look dirty.
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'floorhands-smoke-home-')));
  const env = { ...process.env, FLOORHANDS_PORT: String(49000 + Math.floor(Math.random() * 900)), FLOORHANDS_HOME: home };
  delete env.FLOORHANDS_AGENT;
  delete env.FLOORHANDS_CLAUDE_BIN;
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: project });
  const fh = (...a) => execFileSync(process.execPath, [BIN, ...a], { cwd: project, env, encoding: 'utf8' });
  const getJson = async (url, init = {}) => {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
    const body = await res.text();
    if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${url} -> HTTP ${res.status}: ${body.slice(0, 300)}`);
    return JSON.parse(body);
  };

  let started = false;
  let passed = false;
  try {
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(project, 'server.js'), [
      "const express = require('express');",
      'const app = express();',
      "app.get('/user', (req, res) => {",
      "  db.query('SELECT * FROM users WHERE id = ' + req.query.id, (e, rows) => res.json(rows));",
      '});',
      'app.listen(3000);',
    ].join('\n'));
    git('add', '-A');
    git('commit', '-q', '-m', 'init');

    const startOut = fh('start');
    started = true;
    const m = /http:\/\/localhost:\d+/.exec(startOut);
    if (!m) throw new Error(`could not find the server URL in the output of "start": ${startOut.slice(0, 300)}`);
    const url = m[0];

    const created = await getJson(url + '/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Ask the back-end reviewer to review server.js for security problems.' }) });
    const id = created?.id;
    if (typeof id !== 'string' || !id) throw new Error(`task creation returned no id: ${JSON.stringify(created).slice(0, 300)}`);

    const end = Date.now() + 8 * 60 * 1000;
    let t;
    let timedOut = false;
    for (;;) {
      await new Promise(r => setTimeout(r, 2000));
      t = await getJson(`${url}/api/tasks/${encodeURIComponent(id)}`);
      if (['done', 'failed', 'awaiting_approval'].includes(t.status)) break;
      if (Date.now() >= end) { timedOut = true; break; }
    }
    if (timedOut) {
      console.log(`WARNING  the task was still "${t.status}" after 8 minutes. Stopping the server does not stop an in-flight claude child; it may keep running. Look for it with: ps aux | grep claude`);
    }

    const status = execFileSync('git', ['status', '--porcelain'], { cwd: project, encoding: 'utf8' }).trim();
    const checks = evaluate(t, { workingCopyClean: status === '' });
    if (timedOut) checks.unshift(['the task completed within 8 minutes', false, `status was ${t.status}`]);
    let failed = 0;
    for (const [name, ok, detail] of checks) { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '  - ' + detail : ''}`); }
    console.log('\n--- review output ---\n' + (t.steps ?? []).map(s => s.output).join('\n').slice(0, 1500));
    passed = failed === 0;
    process.exitCode = passed ? 0 : 1;
  } catch (e) {
    console.log(`FAIL  smoke run aborted: ${e?.message ?? e}`);
    process.exitCode = 1;
  } finally {
    if (started) {
      try { fh('stop'); } catch (e) { console.log(`warning: could not stop the server (${e?.message ?? e}); check for a leftover server with: ps aux | grep server/main.js`); }
    }
    if (passed) {
      for (const dir of [project, home]) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { console.log(`warning: could not remove ${dir} (${e?.message ?? e})`); }
      }
    } else {
      console.log(`kept for inspection: ${project}`);
      console.log(`kept for inspection: ${home}`);
      console.log(`server log: ${path.join(project, '.floorhands', 'server.log')}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

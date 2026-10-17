#!/usr/bin/env node
// Prompt evaluation: v0.1.0 prompts ("old") versus the current prompts ("new") on small sample projects with planted problems,
// through the real runner (server/runner.js) and the real, logged-in `claude` CLI, with the read tier's flags.
// Each cell copies a fixture (eval/fixtures/<name>) into a throwaway git repo under the OS temp dir and runs one agent turn there.
// Spends real `claude -p` turns on the owner's login, so it refuses to run without --yes-spend-quota. Not part of `npm test`.
//
//   node scripts/eval-prompts.mjs --dry-run
//   node scripts/eval-prompts.mjs --yes-spend-quota [--roles rbe,rfe,raws] [--repeat 2] [--max-calls 14] [--out docs/prompt-eval] [--label "round 1"] [--append]
//
// Exit: 0 ok, 2 usage error, 3 stopped early (call cap or rate limit), 4 the claude CLI could not be started.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent } from '../server/runner.js';
import { loadRoster } from '../server/roster.js';
import { buildSystem } from '../server/prompt.js';
import { detectStack, renderFacts } from '../server/stack.js';
import { loadLegacyRoster } from '../eval/baseline/legacy-compose.mjs';
import { redactInventory } from './spike-lib.mjs';
import {
  USAGE, ROLE_TASKS, parseArgs, buildMatrix, executeMatrix, fixtureFiles, loadExpected, scoreReport, stepPrompt, redactDeep, renderTables,
} from './eval-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EVAL = path.join(ROOT, 'eval');
const TIMEOUT_MS = 10 * 60 * 1000;

function systemFor(cell, ctx, repo) {
  if (cell.variant === 'old') return ctx.legacy.byId[cell.role].system;
  // The orchestrator's composition: facts detected from the repository, no owner notes.
  return buildSystem(ctx.current.byId[cell.role], { facts: detectStack(repo) });
}

function makeRepo(base, cell) {
  const dir = path.join(base, `${cell.role}-${cell.variant}-${cell.rep}`);
  fs.cpSync(path.join(EVAL, 'fixtures', cell.fixture), dir, { recursive: true });
  const real = fs.realpathSync(dir);
  const git = (...a) => execFileSync('git', a, { cwd: real, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('-c', 'user.name=eval', '-c', 'user.email=eval@localhost', '-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', 'initial commit');
  return real;
}

async function runCell(cell, ctx) {
  const repo = makeRepo(ctx.base, cell);
  const agent = ctx.current.byId[cell.role];
  const system = systemFor(cell, ctx, repo);
  const task = ROLE_TASKS[cell.role].task;
  const t0 = Date.now();
  const rec = { ...cell, systemBytes: Buffer.byteLength(system), repoDir: repo };
  try {
    const res = await runAgent({ agent, system, prompt: stepPrompt(task), cwd: repo, timeoutMs: TIMEOUT_MS });
    rec.status = 'ok';
    rec.wallMs = Date.now() - t0;
    rec.report = res.text;
    rec.tools = res.tools.length;
    rec.toolNames = res.tools.reduce((m, n) => ({ ...m, [n]: (m[n] ?? 0) + 1 }), {});
    rec.usage = res.usage;
    rec.score = scoreReport({ report: res.text, expected: ctx.expected[cell.fixture], files: ctx.files[cell.fixture] });
  } catch (e) {
    rec.status = 'errored';
    rec.wallMs = Date.now() - t0;
    rec.error = String(e.message ?? e).slice(0, 400);
  }
  const s = rec.score;
  console.log(`  ${cell.role.padEnd(5)} ${cell.variant.padEnd(3)} #${cell.rep}: ${rec.status}, ${Math.round(rec.wallMs / 1000)} s${s ? `, recall ${s.found}/${s.planted}, ${rec.tools} tool call(s), ${s.citations.hallucinated} hallucinated citation(s)` : ` (${rec.error})`}`);
  return rec;
}

function dryRun(opts) {
  const cells = buildMatrix(opts);
  const current = loadRoster(path.join(ROOT, 'agents'));
  const legacy = loadLegacyRoster(path.join(EVAL, 'baseline', 'agents'));
  console.log('dry run: no claude calls are made.\n');
  console.log('role   fixture       variant  run');
  for (const c of cells) console.log(`${c.role.padEnd(6)} ${c.fixture.padEnd(13)} ${c.variant.padEnd(8)} #${c.rep}`);
  console.log(`\n${cells.length} claude -p call(s) planned; cap ${opts.maxCalls}${cells.length > opts.maxCalls ? ` (the run would stop after ${opts.maxCalls})` : ''}.`);
  console.log('\nsystem prompt sizes (bytes), new with the facts detected from the fixture folder:');
  for (const role of opts.roles) {
    const dir = path.join(EVAL, 'fixtures', ROLE_TASKS[role].fixture);
    const facts = detectStack(dir);
    console.log(`  ${role.padEnd(5)} old ${Buffer.byteLength(legacy.byId[role].system)}  new ${Buffer.byteLength(buildSystem(current.byId[role], { facts }))}  (facts block ${Buffer.byteLength(renderFacts(facts))})`);
  }
  return 0;
}

function writeResults(opts, round, base) {
  const out = path.resolve(ROOT, opts.out);
  let doc = { schema: 1, rounds: [] };
  if (opts.append && fs.existsSync(`${out}.json`)) doc = JSON.parse(fs.readFileSync(`${out}.json`, 'utf8'));
  const names = [os.userInfo().username, path.basename(os.homedir())];
  const redactOpts = { tempDirs: [base, ...round.runs.map(r => r.repoDir)], names };
  const clean = redactDeep({ ...round, runs: round.runs.map(({ repoDir, ...r }) => r) }, redactOpts);
  doc.rounds.push(clean);
  // Same treatment as the spike results: the owner's plugin/skill inventory never reaches a written file (none is captured here).
  const { inits, results, ...safe } = redactInventory({ ...doc, inits: {}, results: [] }, false);
  const json = JSON.stringify(safe, null, 2) + '\n';
  for (const bad of [os.homedir(), ...names.filter(n => n && n.length >= 3)]) {
    if (json.includes(bad)) throw new Error('refusing to write results: they still contain a home path or the account name');
  }
  fs.mkdirSync(path.dirname(`${out}.json`), { recursive: true });
  fs.writeFileSync(`${out}.json`, json);
  fs.writeFileSync(`${out}.tables.md`, renderTables(safe.rounds) + '\n');
  return out;
}

// Re-score the stored (already redacted) reports with the current scorer. No claude calls. The first-pass numbers are kept per run.
function rescore(opts) {
  const file = path.resolve(opts.rescore);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const expected = {};
  const files = {};
  for (const round of doc.rounds) {
    for (const r of round.runs) {
      if (r.status !== 'ok' || typeof r.report !== 'string') continue;
      expected[r.fixture] ??= loadExpected(path.join(EVAL, 'expected', `${r.fixture}.json`));
      files[r.fixture] ??= fixtureFiles(path.join(EVAL, 'fixtures', r.fixture));
      r.firstPass ??= { found: r.score.found, planted: r.score.planted, blocks: r.score.blocks, scorer: 1 };
      r.score = scoreReport({ report: r.report, expected: expected[r.fixture], files: files[r.fixture] });
    }
    round.rescored = new Date().toISOString();
  }
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  fs.writeFileSync(file.replace(/\.json$/, '') + '.tables.md', renderTables(doc.rounds) + '\n');
  console.log(`re-scored ${doc.rounds.reduce((n, r) => n + r.runs.filter(x => x.status === 'ok').length, 0)} stored report(s); no claude calls made.`);
  return 0;
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); console.error(USAGE); process.exit(2); }
  if (opts.help) { console.log(USAGE); return 0; }
  if (opts.rescore) return rescore(opts);
  if (opts.render) { console.log(renderTables(JSON.parse(fs.readFileSync(opts.render, 'utf8')).rounds)); return 0; }
  if (opts.list) {
    console.log('fixtures / roles / tasks:');
    for (const [role, t] of Object.entries(ROLE_TASKS)) {
      const n = loadExpected(path.join(EVAL, 'expected', `${t.fixture}.json`)).length;
      console.log(`  ${role.padEnd(5)} ${t.fixture.padEnd(12)} ${String(n).padStart(2)} planted  "${t.task}"`);
    }
    console.log('variants: old (v0.1.0 prompts, no facts), new (current prompts + detected facts)');
    return 0;
  }
  if (opts.dryRun) return dryRun(opts);
  if (!opts.yes) {
    console.error('Refusing to run: this spends real claude -p turns on your login. Re-run with --yes-spend-quota (or use --dry-run).');
    process.exit(2);
  }

  const v = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  if (v.error || v.status !== 0) { console.error('The claude CLI could not be started. Is it installed and logged in?'); return 4; }
  const version = v.stdout.trim();
  const cells = buildMatrix(opts);
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'floorhands-eval-')));
  const ctx = {
    base,
    current: loadRoster(path.join(ROOT, 'agents')),
    legacy: loadLegacyRoster(path.join(EVAL, 'baseline', 'agents')),
    expected: {}, files: {},
  };
  for (const f of new Set(cells.map(c => c.fixture))) {
    ctx.expected[f] = loadExpected(path.join(EVAL, 'expected', `${f}.json`));
    ctx.files[f] = fixtureFiles(path.join(EVAL, 'fixtures', f));
  }
  console.log(`claude ${version}; ${new Date().toISOString()}; ${cells.length} cell(s), cap ${opts.maxCalls}`);
  let code = 0;
  try {
    const out = await executeMatrix(cells, { maxCalls: opts.maxCalls, runOne: c => runCell(c, ctx) });
    const round = {
      label: opts.label, date: new Date().toISOString(), claudeVersion: version, calls: out.calls, stoppedBy: out.stoppedBy,
      skipped: out.skipped.map(c => `${c.role}/${c.variant}/#${c.rep}`), runs: out.results,
    };
    const written = writeResults(opts, round, base);
    console.log(`\n${out.calls} claude -p call(s); ${out.results.filter(r => r.status === 'errored').length} errored; results: ${path.relative(ROOT, written)}.json`);
    if (out.stoppedBy) {
      console.warn(`STOPPED EARLY (${out.stoppedBy}); ${out.skipped.length} cell(s) not run: ${round.skipped.join(', ')}. Results are partial.`);
      code = 3;
    }
  } finally {
    if (opts.keep) console.log(`temp dir kept: ${base}`);
    else fs.rmSync(base, { recursive: true, force: true });
  }
  return code;
}

// Importing this file (e.g. from a test) must never run anything.
const isMain = (() => { try { return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) main().then(c => { process.exitCode = c; }).catch(e => { console.error(e); process.exit(4); });

#!/usr/bin/env node
// Compares a fresh probe run (scripts/spike-claude.mjs --out <base>) with the committed baseline results and fails on any regression.
//   node scripts/probe-compare.mjs <current.json> <baseline.json> [<baseline.json> ...]
// Rules, in order:
//   - FAIL in the current run is always a regression (a permission held before and does not now, or a new probe found a hole).
//   - A probe that PASSED in the baseline and is now anything but PASS is a regression. INCONCLUSIVE counts: in CI "the model did not
//     try" is not evidence that the permission holds, and spike-claude.mjs already retries with an insisting prompt.
//   - KNOWN LIMIT stays allowed only where the baseline already recorded it.
//   - Probes new since the baseline must PASS (or be INCONCLUSIVE, reported as a warning to look at).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const PASS = 'PASS', FAIL = 'FAIL';
// Functional checks that depend on which plugins and skills the machine has installed, not on the permission model: a CI runner has
// none of the owner's skills. Their result is reported as a warning, never as a regression.
export const ENVIRONMENT_DEPENDENT = new Set(['skill-names', 'skill-invoke']);

// Baselines merge several runs, so one probe name can appear more than once: its best verdict is the baseline.
const ORDER = [PASS, 'KNOWN LIMIT', 'INCONCLUSIVE', FAIL];
export function baselineVerdicts(docs) {
  const best = new Map();
  for (const d of docs) {
    for (const r of d?.results ?? []) {
      if (!r?.name) continue;
      const cur = best.get(r.name);
      if (cur === undefined || ORDER.indexOf(r.verdict) < ORDER.indexOf(cur)) best.set(r.name, r.verdict);
    }
  }
  return best;
}

export function compare(current, baselines) {
  const base = baselineVerdicts(baselines);
  const regressions = [], warnings = [], fixed = [];
  for (const r of current?.results ?? []) {
    const was = base.get(r.name);
    const line = `${r.name}: ${was ?? 'new'} -> ${r.verdict}${r.detail ? ` (${String(r.detail).slice(0, 200)})` : ''}`;
    if (ENVIRONMENT_DEPENDENT.has(r.name)) { if (r.verdict !== PASS) warnings.push(line); continue; }
    if (r.verdict === FAIL) { regressions.push(line); continue; }
    if (was === undefined) { if (r.verdict !== PASS) warnings.push(line); continue; }
    if (was === PASS && r.verdict !== PASS) regressions.push(line);
    else if (r.verdict === 'KNOWN LIMIT' && was !== 'KNOWN LIMIT') regressions.push(line);
    else if (was !== PASS && r.verdict === PASS) fixed.push(line);
  }
  const ran = new Set((current?.results ?? []).map(r => r.name));
  const missing = [...base.keys()].filter(n => base.get(n) === PASS && !ran.has(n));
  return { regressions, warnings, fixed, missing, ok: regressions.length === 0 };
}

const isMain = (() => { try { return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  const [cur, ...bases] = process.argv.slice(2);
  if (!cur || !bases.length) { console.error('usage: node scripts/probe-compare.mjs <current.json> <baseline.json> [...]'); process.exit(2); }
  const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
  const current = read(cur);
  const r = compare(current, bases.map(read));
  console.log(`claude ${current.claudeVersion ?? '?'}: ${current.results?.length ?? 0} probe results compared with ${bases.length} baseline file(s)`);
  for (const [title, list] of [['REGRESSIONS', r.regressions], ['warnings', r.warnings], ['now passing', r.fixed], ['not run this time (filtered with --only?)', r.missing]]) {
    if (list.length) console.log(`\n${title}:\n${list.map(l => `  - ${l}`).join('\n')}`);
  }
  process.exit(r.ok ? 0 : 1);
}

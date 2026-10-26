import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_POLICY, validatePolicy, mergePolicy, loadPolicy, resolveStep, agentRange, rosterModelProblems, createLimiter,
} from '../server/models.js';
import { loadRoster } from '../server/roster.js';
import { fileURLToPath } from 'node:url';

const AGENTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'agents');
const agent = model => ({ id: 'x', name: 'X', tier: 'build', model });
const BUILDER = agent({ default: 'standard', min: 'light', max: 'frontier' });
const REVIEWER = agent({ default: 'frontier', min: 'frontier', max: 'frontier' });

test('defaults: light is Haiku, standard is Sonnet, frontier is Opus with a Sonnet fallback', () => {
  const p = mergePolicy();
  assert.equal(p.classes.light.model, 'haiku');
  assert.equal(p.classes.standard.model, 'sonnet');
  assert.equal(p.classes.frontier.model, 'opus');
  assert.equal(p.classes.frontier.fallback, 'sonnet');
  assert.equal(p.maxConcurrentTasks, 1);
  assert.ok(p.taskBudgetUsd > 0);
});

test('the shipped roster: Architect and reviewers are pinned to frontier; builders default to standard', () => {
  const r = loadRoster(AGENTS);
  for (const id of ['arch', 'rfe', 'rbe', 'raws']) assert.deepEqual(agentRange(r.byId[id]), { min: 'frontier', max: 'frontier', default: 'frontier' }, id);
  for (const id of ['fe', 'be', 'sre']) assert.deepEqual(agentRange(r.byId[id]), { min: 'light', max: 'frontier', default: 'standard' }, id);
  for (const id of ['e2e', 'sup']) assert.equal(agentRange(r.byId[id]).max, 'standard', id);
});

test('resolveStep uses the agent default when the plan proposes nothing or something unknown', () => {
  assert.equal(resolveStep(BUILDER, undefined).model, 'sonnet');
  assert.equal(resolveStep(BUILDER, 'gigantic').class, 'standard');
  assert.equal(resolveStep(BUILDER, 'gigantic').requested, null);
});

test('resolveStep follows the plan inside the agent range: docs on Haiku, a hard change on Opus', () => {
  const light = resolveStep(BUILDER, 'light');
  assert.deepEqual([light.class, light.model, light.effort, light.fallback], ['light', 'haiku', 'low', null]);
  const hard = resolveStep(BUILDER, 'frontier');
  assert.deepEqual([hard.class, hard.model, hard.effort, hard.fallback], ['frontier', 'opus', 'high', 'sonnet']);
});

test('resolveStep clamps a proposal outside the range: a plan cannot move a reviewer down to Haiku', () => {
  const r = resolveStep(REVIEWER, 'light');
  assert.equal(r.class, 'frontier');
  assert.equal(r.model, 'opus');
  assert.equal(r.requested, 'light', 'the proposal is recorded so clamping is visible');
  assert.equal(resolveStep(agent({ default: 'light', min: 'light', max: 'standard' }), 'frontier').class, 'standard');
});

test('an agent with no model range is treated as frontier-only', () => {
  assert.deepEqual(agentRange({ id: 'old' }), { min: 'frontier', max: 'frontier', default: 'frontier' });
});

test('resolveStep caps the step budget at what is left of the task budget', () => {
  assert.equal(resolveStep(BUILDER, 'standard', mergePolicy(), 0.75).budgetUsd, 0.75);
  assert.equal(resolveStep(BUILDER, 'standard', mergePolicy(), 100).budgetUsd, DEFAULT_POLICY.classes.standard.budgetUsd);
});

test('validatePolicy refuses unknown keys, bad models, efforts and budgets', () => {
  assert.deepEqual(validatePolicy({}), []);
  assert.deepEqual(validatePolicy({ classes: { light: { model: 'claude-haiku-5-5' } }, taskBudgetUsd: 5, maxConcurrentTasks: 2 }), []);
  const bad = validatePolicy({
    classes: { light: { model: '--dangerously-skip-permissions' }, huge: {}, standard: { effort: 'turbo', budgetUsd: -1, colour: 1 } },
    taskBudgetUsd: 1e9, maxConcurrentTasks: 10, extra: true,
  });
  for (const re of [/unknown key "extra"/, /classes\.light\.model/, /unknown class "huge"/, /classes\.standard\.effort/, /classes\.standard\.budgetUsd/,
    /classes\.standard: unknown key "colour"/, /taskBudgetUsd/, /maxConcurrentTasks/]) {
    assert.ok(bad.some(p => re.test(p)), `${re} in ${bad.join(' | ')}`);
  }
  assert.deepEqual(validatePolicy([]), ['the policy must be a JSON object']);
});

test('mergePolicy changes only what the owner set', () => {
  const p = mergePolicy({ classes: { standard: { model: 'opus' } }, taskBudgetUsd: 3 });
  assert.equal(p.classes.standard.model, 'opus');
  assert.equal(p.classes.standard.effort, 'medium');
  assert.equal(p.classes.light.model, 'haiku');
  assert.equal(p.taskBudgetUsd, 3);
});

test('loadPolicy: missing file means defaults; a broken file is an error, never a silent fallback', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floorhands-models-'));
  try {
    assert.deepEqual(loadPolicy(path.join(dir, 'none.json')), mergePolicy());
    const f = path.join(dir, 'models.json');
    fs.writeFileSync(f, '{ not json');
    assert.throws(() => loadPolicy(f), /not valid JSON/);
    fs.writeFileSync(f, JSON.stringify({ classes: { light: { model: 'gpt-5' } } }));
    assert.throws(() => loadPolicy(f), /classes\.light\.model/);
    fs.writeFileSync(f, JSON.stringify({ maxConcurrentTasks: 2 }));
    assert.equal(loadPolicy(f).maxConcurrentTasks, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rosterModelProblems checks the range is ordered and the default inside it', () => {
  assert.deepEqual(rosterModelProblems(undefined), []);
  assert.deepEqual(rosterModelProblems({ default: 'standard', min: 'light', max: 'frontier' }), []);
  assert.match(rosterModelProblems({ default: 'light', min: 'standard', max: 'light' }).join(), /model\.min is above model\.max/);
  assert.match(rosterModelProblems({ default: 'frontier', min: 'light', max: 'standard' }).join(), /outside min\.\.max/);
  assert.match(rosterModelProblems({ default: 'x', min: 'light', max: 'frontier' }).join(), /model\.default/);
  assert.match(rosterModelProblems('opus').join(), /must be an object/);
});

test('createLimiter runs at most N at once, in arrival order', async () => {
  const lim = createLimiter(1);
  const order = [];
  let release;
  const first = lim.run(() => new Promise(r => { order.push('a-start'); release = r; }));
  const second = lim.run(async () => { order.push('b'); });
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(order, ['a-start']);
  assert.equal(lim.active, 1);
  assert.equal(lim.waiting, 1);
  release();
  await first;
  await second;
  assert.deepEqual(order, ['a-start', 'b']);
});

test('createLimiter frees the slot when a job throws', async () => {
  const lim = createLimiter(1);
  await assert.rejects(lim.run(async () => { throw new Error('x'); }), /x/);
  assert.equal(await lim.run(async () => 7), 7);
});

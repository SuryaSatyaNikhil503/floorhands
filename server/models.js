// Model policy: which Claude model, effort level and spending cap each agent run gets, and how many tasks may run at once.
// Every model decision goes through resolveStep(), so the routing is one readable table, not scattered flags.
//
// Steps have a class: light (Haiku), standard (Sonnet) or frontier (Opus). The Architect proposes a class per step, but the plan is
// model output that repository text can influence, so the proposal is CLAMPED to the agent's own range from roster.json: a prompt
// injection can at most move a step inside that range, never push a reviewer down to Haiku or a docs edit up to Opus without limit.
// The owner (trusted) can change the class table, budgets and concurrency in ~/.floorhands/models.json. The repository cannot.
import fs from 'node:fs';
import path from 'node:path';
import { floorhandsHome } from './worktree.js';

export const CLASSES = Object.freeze(['light', 'standard', 'frontier']);
export const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const rank = c => CLASSES.indexOf(c);

// Aliases follow the latest model of each family (today Haiku 5.5, Sonnet 5.5, Opus 5.5). The model that actually ran is recorded per
// step from the CLI's own report, so results stay reproducible even though the alias moves.
export const DEFAULT_POLICY = Object.freeze({
  classes: Object.freeze({
    light: Object.freeze({ model: 'haiku', effort: 'low', budgetUsd: 0.5 }),
    standard: Object.freeze({ model: 'sonnet', effort: 'medium', budgetUsd: 2 }),
    frontier: Object.freeze({ model: 'opus', effort: 'high', budgetUsd: 5, fallback: 'sonnet' }),
  }),
  taskBudgetUsd: 15,
  maxConcurrentTasks: 1,
});

// A model name goes into argv. Only an alias or a plain model id is accepted, so a config value can never be read as a flag.
const MODEL = /^(?:opus|sonnet|haiku|fable|default|claude-[a-z0-9][a-z0-9.-]{0,63})(?:\[1m\])?$/;
const MAX_STEP_BUDGET = 50;
const MAX_TASK_BUDGET = 200;
const MAX_CONCURRENT = 4;

export const policyPath = () => path.join(floorhandsHome(), 'models.json');

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isBudget = (v, max) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= max;

// Returns the problems with an owner policy document (an empty list when it is usable). Unknown keys are refused, not ignored,
// so a typo cannot silently fall back to a more expensive default.
export function validatePolicy(doc) {
  if (!isObject(doc)) return ['the policy must be a JSON object'];
  const problems = [];
  for (const k of Object.keys(doc)) if (!['classes', 'taskBudgetUsd', 'maxConcurrentTasks'].includes(k)) problems.push(`unknown key ${JSON.stringify(k)}`);
  if (doc.classes !== undefined) {
    if (!isObject(doc.classes)) problems.push('classes must be an object');
    else {
      for (const [name, c] of Object.entries(doc.classes)) {
        if (!CLASSES.includes(name)) { problems.push(`unknown class ${JSON.stringify(name)} (allowed: ${CLASSES.join(', ')})`); continue; }
        if (!isObject(c)) { problems.push(`classes.${name} must be an object`); continue; }
        for (const k of Object.keys(c)) if (!['model', 'effort', 'budgetUsd', 'fallback'].includes(k)) problems.push(`classes.${name}: unknown key ${JSON.stringify(k)}`);
        if (c.model !== undefined && !(typeof c.model === 'string' && MODEL.test(c.model))) problems.push(`classes.${name}.model must be an alias (opus, sonnet, haiku) or a model id such as claude-sonnet-5-5`);
        if (c.fallback !== undefined && c.fallback !== null && !(typeof c.fallback === 'string' && MODEL.test(c.fallback))) problems.push(`classes.${name}.fallback must be a model alias or id, or null`);
        if (c.effort !== undefined && c.effort !== null && !EFFORTS.includes(c.effort)) problems.push(`classes.${name}.effort must be one of ${EFFORTS.join(', ')}, or null`);
        if (c.budgetUsd !== undefined && !isBudget(c.budgetUsd, MAX_STEP_BUDGET)) problems.push(`classes.${name}.budgetUsd must be a number above 0 and at most ${MAX_STEP_BUDGET}`);
      }
    }
  }
  if (doc.taskBudgetUsd !== undefined && !isBudget(doc.taskBudgetUsd, MAX_TASK_BUDGET)) problems.push(`taskBudgetUsd must be a number above 0 and at most ${MAX_TASK_BUDGET}`);
  if (doc.maxConcurrentTasks !== undefined && !(Number.isInteger(doc.maxConcurrentTasks) && doc.maxConcurrentTasks >= 1 && doc.maxConcurrentTasks <= MAX_CONCURRENT)) {
    problems.push(`maxConcurrentTasks must be a whole number from 1 to ${MAX_CONCURRENT}`);
  }
  return problems;
}

// The defaults merged with a valid owner document. Each class is merged key by key, so an owner can change one model and keep the rest.
export function mergePolicy(doc = {}) {
  const classes = {};
  for (const name of CLASSES) classes[name] = Object.freeze({ ...DEFAULT_POLICY.classes[name], ...(doc.classes?.[name] ?? {}) });
  return Object.freeze({
    classes: Object.freeze(classes),
    taskBudgetUsd: doc.taskBudgetUsd ?? DEFAULT_POLICY.taskBudgetUsd,
    maxConcurrentTasks: doc.maxConcurrentTasks ?? DEFAULT_POLICY.maxConcurrentTasks,
  });
}

// Reads the owner's policy. A missing file means the defaults; a broken one is an error the server reports at start, because quietly
// running every step on the defaults could cost the owner far more than the policy they wrote.
export function loadPolicy(file = policyPath()) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return mergePolicy();
    throw new Error(`${file}: ${e.message}`);
  }
  let doc;
  try { doc = JSON.parse(text); } catch { throw new Error(`${file}: not valid JSON`); }
  const problems = validatePolicy(doc);
  if (problems.length) throw new Error(`${file}: ${problems.join('; ')}`);
  return mergePolicy(doc);
}

// An agent's model range from roster.json: { default, min, max } classes. Missing fields fall back to a fixed frontier range,
// the conservative choice for an agent nobody configured.
export function agentRange(agent) {
  const m = isObject(agent?.model) ? agent.model : {};
  const min = CLASSES.includes(m.min) ? m.min : 'frontier';
  const max = CLASSES.includes(m.max) ? m.max : 'frontier';
  const def = CLASSES.includes(m.default) ? m.default : max;
  return { min, max, default: def };
}

export function rosterModelProblems(model) {
  if (model === undefined) return [];
  if (!isObject(model)) return ['model must be an object { default, min, max }'];
  const problems = [];
  for (const k of Object.keys(model)) if (!['default', 'min', 'max'].includes(k)) problems.push(`model: unknown key ${JSON.stringify(k)}`);
  for (const k of ['default', 'min', 'max']) if (!CLASSES.includes(model[k])) problems.push(`model.${k} must be one of ${CLASSES.join(', ')}`);
  if (!problems.length) {
    if (rank(model.min) > rank(model.max)) problems.push('model.min is above model.max');
    if (rank(model.default) < rank(model.min) || rank(model.default) > rank(model.max)) problems.push('model.default is outside min..max');
  }
  return problems;
}

// The class, model, effort, fallback and budget for one step. `requested` is the Architect's proposal (untrusted); `remainingUsd` is
// what is left of the task budget, so the last step cannot spend past the task cap.
export function resolveStep(agent, requested, policy = mergePolicy(), remainingUsd = Infinity) {
  const r = agentRange(agent);
  let cls = CLASSES.includes(requested) ? requested : r.default;
  if (rank(cls) < rank(r.min)) cls = r.min;
  if (rank(cls) > rank(r.max)) cls = r.max;
  const c = policy.classes[cls];
  const budgetUsd = Math.max(0, Math.min(c.budgetUsd, remainingUsd));
  return {
    class: cls,
    requested: CLASSES.includes(requested) ? requested : null,
    model: c.model,
    effort: c.effort ?? null,
    fallback: c.fallback && c.fallback !== c.model ? c.fallback : null,
    budgetUsd: Math.floor(budgetUsd * 100) / 100, // down, never up: a step must not get more than is left
  };
}

// A tiny FIFO limiter. Each running task holds one slot; the rest wait, still "queued". This keeps parallel tasks from draining the
// owner's session limit and caps the number of agent processes alive at once.
export function createLimiter(max) {
  let active = 0;
  const waiting = [];
  const next = () => {
    if (active >= max || !waiting.length) return;
    active++;
    const { fn, resolve, reject } = waiting.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next(); });
  };
  return {
    run: fn => new Promise((resolve, reject) => { waiting.push({ fn, resolve, reject }); next(); }),
    get active() { return active; },
    get waiting() { return waiting.length; },
  };
}

// Dollars per million tokens, first-party API rates (cached 2026-10-06). Cache reads and writes are priced from these: a 5-minute
// write is 1.25x input, a 1-hour write 2x. An unknown model is priced as the most expensive known one, so the spending guard errs on
// the side of asking. On a Claude subscription these are estimates of usage, not a bill.
export const PRICES = Object.freeze([
  ['claude-haiku-5-5', { in: 0.10, out: 0.50, cacheRead: 0.01, longIn: 0.50, longOut: 2.50, longAbove: 100_000 }],
  ['claude-sonnet-5-5', { in: 2, out: 10, cacheRead: 0.20 }],
  ['claude-opus-5-5', { in: 4, out: 20, cacheRead: 0.20 }],
  ['claude-sonnet-5', { in: 2, out: 10, cacheRead: 0.20 }],
  ['claude-opus-5', { in: 5, out: 25, cacheRead: 0.50 }],
  ['claude-fable-5', { in: 10, out: 50, cacheRead: 0.25 }],
  ['claude-haiku-4-5', { in: 1, out: 5, cacheRead: 0.10 }],
  ['claude-sonnet-4', { in: 3, out: 15, cacheRead: 0.30 }],
  ['claude-opus-4', { in: 5, out: 25, cacheRead: 0.50 }],
].map(([k, v]) => [k, Object.freeze(v)]));
const MOST_EXPENSIVE = Object.freeze({ in: 10, out: 50, cacheRead: 1 });

// The longest matching prefix wins, so claude-opus-5-5 is not priced as claude-opus-5. Fast mode (speed: "fast") is billed at twice
// the standard rates.
export function priceOf(model, { fast = false } = {}) {
  const m = String(model ?? '').toLowerCase();
  let best = null;
  for (const [k, v] of PRICES) if (m.startsWith(k) && (!best || k.length > best[0].length)) best = [k, v];
  const p = best ? best[1] : MOST_EXPENSIVE;
  if (!fast) return p;
  const f = {};
  for (const [k, v] of Object.entries(p)) f[k] = k === 'longAbove' ? v : v * 2;
  return f;
}

// What a finished request cost, from the usage the API reported.
export function costOf(model, u, opts = {}) {
  const p = priceOf(model, opts);
  const n = k => (Number.isFinite(u?.[k]) ? u[k] : 0);
  const write1h = n('cache_creation_1h');
  const write5m = Math.max(0, n('cache_creation_input_tokens') - write1h);
  const promptTokens = n('input_tokens') + n('cache_read_input_tokens') + n('cache_creation_input_tokens');
  const long = p.longAbove && promptTokens > p.longAbove;
  const inRate = long ? p.longIn : p.in, outRate = long ? p.longOut : p.out;
  return (n('input_tokens') * inRate + write5m * inRate * 1.25 + write1h * inRate * 2 + n('cache_read_input_tokens') * p.cacheRead + n('output_tokens') * outRate) / 1e6;
}

// The most a request can cost before it is sent: every input token billed as a 1-hour cache write (the dearest way to pay for input)
// and every allowed output token used. If the guard lets a request through only when this fits, a step cannot overshoot its cap.
export function worstCaseCost(model, inputTokens, maxTokens, opts = {}) {
  const p = priceOf(model, opts);
  const long = p.longAbove && inputTokens > p.longAbove;
  return (inputTokens * (long ? p.longIn : p.in) * 2 + maxTokens * (long ? p.longOut : p.out)) / 1e6;
}

// The output allowance that keeps a request within `remainingUsd`, or 0 when even the input does not fit.
export function affordableOutput(model, inputTokens, remainingUsd, opts = {}) {
  const p = priceOf(model, opts);
  const long = p.longAbove && inputTokens > p.longAbove;
  const left = remainingUsd - (inputTokens * (long ? p.longIn : p.in) * 2) / 1e6;
  return left <= 0 ? 0 : Math.floor((left * 1e6) / (long ? p.longOut : p.out));
}

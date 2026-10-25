import { layoutFloor, initials } from './floor.js';
import { createActivity, classifyDiff, isAllowedAttr, isHandlerKey } from './model.js';

const NS = 'http://www.w3.org/2000/svg';
const $ = s => document.querySelector(s);
const enc = encodeURIComponent;

/* Every element is built here: text goes in as text nodes, attributes must be on the allowlist,
   and handlers are attached with addEventListener only. */
function make(ns, tag, attrs = {}, ...kids) {
  const n = ns ? document.createElementNS(NS, tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (isHandlerKey(k)) {
      if (typeof v !== 'function') throw new TypeError(`handler ${k} must be a function`);
      n.addEventListener(k.slice(2), v);
    } else if (isAllowedAttr(k)) {
      n.setAttribute(k, String(v));
    } else {
      throw new Error(`attribute not allowed: ${k}`);
    }
  }
  for (const kid of kids.flat()) n.append(kid instanceof Node ? kid : document.createTextNode(String(kid ?? '')));
  return n;
}
const el = (tag, attrs, ...kids) => make(false, tag, attrs, ...kids);
const svg = (tag, attrs, ...kids) => make(true, tag, attrs, ...kids);

const errMsg = e => (e instanceof Error ? e.message : String(e));
const fire = p => { Promise.resolve(p).catch(e => console.error('[floorhands]', e)); };
const text = v => {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  try { return JSON.stringify(v) ?? ''; } catch { return ''; }
};
const cls = s => String(s ?? '').replace(/[^a-z_]/gi, '');

const state = {
  project: '', roster: { pods: [], agents: [] }, tasks: [],
  selected: null, selectedAgent: null,
  detail: null, diff: null, detailError: '', actionError: '', pending: null, seq: 0, reason: '',
  stack: false,
};
const activity = createActivity();

/* ---------- http ---------- */
/* The per-run token arrives in the URL fragment (never sent to a server), moves to sessionStorage, and leaves the address bar. */
const TOKEN = (() => {
  let t = '';
  const m = /^#t=([^&]+)/.exec(location.hash);
  if (m) {
    try { t = decodeURIComponent(m[1]); } catch { t = ''; }
    try { sessionStorage.setItem('floorhands-token', t); } catch { /* private mode: this tab still works */ }
    history.replaceState(null, '', location.pathname + location.search);
  } else {
    try { t = sessionStorage.getItem('floorhands-token') ?? ''; } catch { t = ''; }
  }
  return t;
})();

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { 'content-type': 'application/json', 'x-floorhands-token': TOKEN }, body: body ? JSON.stringify(body) : undefined });
  const raw = await r.text();
  if (!r.ok) {
    let msg = raw;
    try { msg = JSON.parse(raw).error ?? raw; } catch { /* plain text */ }
    throw new Error(msg || `HTTP ${r.status}`);
  }
  return raw;
}
async function json(...a) {
  const raw = await api(...a);
  try { return JSON.parse(raw); } catch { throw new Error('The server sent an unreadable response.'); }
}

/* Re-focus the same data-key after a rebuild so keyboard users keep their place. */
function keepFocus(rebuild) {
  const key = document.activeElement?.getAttribute?.('data-key') ?? null;
  rebuild();
  if (key !== null) focusKey(key);
}
function focusKey(key) {
  for (const n of document.querySelectorAll('[data-key]')) {
    if (n.getAttribute('data-key') === key) { if (n !== document.activeElement) n.focus({ preventScroll: true }); return; }
  }
}

/* ---------- connection indicator and boot errors ---------- */
function setConn(on) {
  $('#conn').classList.toggle('on', on);
  $('#conn-text').textContent = on ? 'Live' : 'Reconnecting';
}
function showBoot(e) {
  $('#boot').replaceChildren(el('div', { class: 'card' },
    el('p', { class: 'error' }, `Could not load the team: ${errMsg(e)}`),
    el('button', { type: 'button', 'data-key': 'boot:retry', onclick: () => fire(resync()) }, 'Retry')));
}
const hideBoot = () => $('#boot').replaceChildren();

/* ---------- floor: built once per roster/layout, then updated in place ---------- */
const agentNodes = new Map();
let floorSig = '';

function buildFloor() {
  const sig = JSON.stringify([state.stack, state.roster.pods.map(p => [p.id, p.name]), state.roster.agents.map(a => [a.id, a.name, a.role, a.pod, !!a.lead])]);
  if (sig === floorSig) return;
  floorSig = sig;
  keepFocus(() => {
    const f = layoutFloor(state.roster, { stack: state.stack });
    const root = $('#floor');
    root.setAttribute('viewBox', `0 0 ${f.width} ${f.height}`);
    root.setAttribute('class', state.stack ? 'stacked' : '');
    const byId = new Map(state.roster.agents.map(a => [a.id, a]));
    agentNodes.clear();
    const pods = [svg('title', {}, 'Office floor plan')];
    for (const p of f.pods) {
      const g = svg('g', { class: 'pod' },
        svg('rect', { class: 'room', x: p.x, y: p.y, width: p.w, height: p.h, rx: 14 }),
        svg('text', { class: 'pod-name', x: p.x + 24, y: p.y + 30 }, String(p.name ?? '')));
      for (const d of p.desks) {
        const a = byId.get(d.agentId);
        if (!a) continue;
        const chip = svg('text', { class: 'chip', x: d.x, y: d.y - 44 });
        const toggle = () => { state.selectedAgent = state.selectedAgent === a.id ? null : a.id; updateFloor(); renderDetail(); };
        const ag = svg('g', {
          class: 'agent', tabindex: '0', role: 'button', 'aria-pressed': 'false', 'data-key': `agent:${a.id}`,
          onclick: toggle,
          onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } },
        },
        svg('g', { class: 'desk' }, svg('rect', { x: d.x - 70, y: d.y + 22, width: 140, height: 34, rx: 8 })),
        svg('g', { class: 'avatar' }, svg('circle', { cx: d.x, cy: d.y - 10, r: 26 }), svg('text', { class: 'init', x: d.x, y: d.y - 10 }, initials(a.name))),
        svg('text', { class: 'name', x: d.x, y: d.y + 70 }, String(a.name ?? '')),
        svg('text', { class: 'role', x: d.x, y: d.y + 85 }, String(a.role ?? '')),
        chip);
        agentNodes.set(a.id, { g: ag, chip, name: String(a.name ?? ''), role: String(a.role ?? '') });
        g.append(ag);
      }
      pods.push(g);
    }
    root.replaceChildren(...pods);
    updateFloor();
  });
}

function updateFloor() {
  for (const [id, n] of agentNodes) {
    const working = activity.isWorking(id);
    const selected = state.selectedAgent === id;
    n.g.classList.toggle('working', working);
    n.g.classList.toggle('selected', selected);
    n.g.setAttribute('aria-pressed', String(selected));
    n.g.setAttribute('aria-label', `${n.name}, ${n.role}${working ? ', working' : ''}`);
    n.chip.textContent = working ? activity.tool(id).slice(0, 26) : '';
  }
}

/* ---------- tasks ---------- */
function renderTasks() {
  keepFocus(() => {
    const ul = $('#tasks');
    ul.replaceChildren(...state.tasks.map(t => {
      const status = String(t.status ?? '');
      return el('li', { class: t.id === state.selected ? 'sel' : '' },
        el('button', { type: 'button', class: 'task', 'data-key': `task:${t.id}`, ...(t.id === state.selected ? { 'aria-current': 'true' } : {}), onclick: () => fire(select(t.id)) },
          el('span', { class: 't' }, String(t.text ?? '')), el('span', { class: `badge ${cls(status)}` }, status.replaceAll('_', ' '))));
    }));
    if (!state.tasks.length) ul.append(el('li', { class: 'empty' }, 'No tasks yet.'));
  });
}

function upsert(summary) {
  if (!summary || typeof summary.id !== 'string') return;
  const i = state.tasks.findIndex(t => t.id === summary.id);
  if (i >= 0) state.tasks[i] = summary; else state.tasks.unshift(summary);
  renderTasks();
  if (summary.id === state.selected) fire(loadDetail());
}

/* Selecting clears the panel at once, so a stale Approve button can never be clicked for another task. */
async function select(id) {
  state.selected = id;
  state.seq++;
  state.detail = null; state.diff = null; state.detailError = ''; state.actionError = '';
  renderTasks();
  renderDetail();
  return loadDetail();
}

// Never throws; resolves false only when loading really failed.
async function loadDetail() {
  const id = state.selected;
  if (!id) return false;
  const seq = ++state.seq;
  try {
    const t = await json('GET', `/api/tasks/${enc(id)}`);
    let diff = null;
    if (t.status === 'awaiting_approval') {
      try { diff = { ok: true, text: await api('GET', `/api/tasks/${enc(t.id)}/diff`) }; }
      catch (e) { diff = { ok: false, text: '', error: errMsg(e) }; }
    }
    if (seq !== state.seq || t.id !== state.selected) return true; // superseded by a newer request or selection, not a failure
    state.detail = t; state.diff = diff; state.detailError = '';
  } catch (e) {
    if (seq !== state.seq) return true; // superseded, the newer request reports its own outcome
    state.detail = null; state.diff = null; state.detailError = errMsg(e);
  }
  renderDetail();
  return !state.detailError;
}

function diffProblem(t) {
  const d = state.diff;
  if (!d || !d.ok) return d?.error || 'the diff request failed';
  if (!d.text.trim() && String(t.diffStat ?? '').trim()) return 'the diff came back empty';
  return '';
}

function detailNodes() {
  if (state.detailError) {
    return [el('h2', {}, 'Task'),
      el('p', { class: 'error', role: 'alert' }, `Could not load this task: ${state.detailError}`),
      el('button', { type: 'button', 'data-key': 'detail:retry', onclick: () => { state.detailError = ''; renderDetail(); fire(loadDetail()); } }, 'Retry')];
  }
  const t = state.detail;
  if (!t) return [el('h2', {}, 'Task'), el('p', { class: 'muted', role: 'status' }, 'Loading…')];

  const names = new Map(state.roster.agents.map(a => [a.id, a.name]));
  const status = String(t.status ?? '');
  const kids = [el('h2', {}, 'Task'), el('p', {}, String(t.text ?? '')), el('p', {}, el('span', { class: `badge ${cls(status)}` }, status.replaceAll('_', ' ')))];
  if (t.summary) kids.push(el('p', { class: 'summary' }, String(t.summary)));
  if (t.error) kids.push(el('p', { class: 'error' }, String(t.error)));
  if (status === 'needs_budget' && t.budgetRequest && typeof t.budgetRequest === 'object') kids.push(budgetBox(t));
  const usage = usageLine(t.totals);
  if (usage) kids.push(el('p', { class: 'muted usage' }, usage));
  for (const s of t.steps ?? []) {
    kids.push(el('div', { class: 'step' },
      el('h3', {}, `${names.get(s.agent) ?? s.agent} — ${s.status}`, routeChip(s)),
      el('p', { class: 'muted' }, String(s.task ?? '')),
      s.output ? el('pre', {}, String(s.output)) : ''));
  }
  if (status === 'awaiting_approval') {
    const problem = diffProblem(t);
    kids.push(el('h2', {}, 'Proposed changes'));
    if (problem) {
      kids.push(el('p', { class: 'error', role: 'alert' }, 'Could not load the diff'), el('p', { class: 'muted' }, `Approve is disabled until the changes can be reviewed (${problem}).`));
    } else {
      kids.push(el('pre', { class: 'diff' }, ...classifyDiff(state.diff.text).map(l => el('span', { class: l.kind }, l.text || ' '))));
    }
    const flags = Array.isArray(t.riskFlags) ? t.riskFlags : [];
    if (flags.length) {
      kids.push(el('div', { class: 'risk', role: 'note' },
        el('p', {}, 'Check these before approving. They change what runs on your machine later, not just what the code does:'),
        el('ul', {}, ...flags.slice(0, 20).map(f => el('li', {}, `${RISK_LABELS[f.flag] ?? String(f.flag)}: ${String(f.path ?? '')}`)))));
    }
    const busy = state.pending?.id === t.id;
    const approve = el('button', { type: 'button', class: 'primary', 'data-key': 'detail:approve', onclick: () => fire(decide('approve')) }, 'Approve and merge');
    const reject = el('button', { type: 'button', class: 'danger', 'data-key': 'detail:reject', onclick: () => fire(decide('reject')) }, 'Reject');
    const reason = el('select', { 'data-key': 'detail:reason', 'aria-label': 'Why reject (optional)', onchange: e => { state.reason = e.target.value; } },
      ...REJECT_REASONS.map(([v, label]) => el('option', { value: v }, label)));
    reason.value = state.reason;
    approve.disabled = busy || !!problem;
    reject.disabled = busy;
    reason.disabled = busy;
    kids.push(el('div', { class: 'actions' }, approve, reason, reject));
    if (problem) kids.push(el('div', { class: 'actions' }, el('button', { type: 'button', 'data-key': 'detail:retry', onclick: () => fire(loadDetail()) }, 'Reload diff')));
    if (state.actionError) kids.push(el('p', { class: 'error', role: 'alert' }, state.actionError));
  } else if (state.actionError) {
    kids.push(el('p', { class: 'error', role: 'alert' }, state.actionError));
  }
  if (state.selectedAgent) {
    const ev = (t.events ?? []).filter(e => e.agent === state.selectedAgent).slice(-12);
    if (ev.length) {
      kids.push(el('h2', {}, `Activity — ${names.get(state.selectedAgent) ?? state.selectedAgent}`),
        el('pre', {}, ev.map(e => (e.phase === 'tool' ? `▸ ${text(e.tool)} ${text(e.input)}` : text(e.text).slice(0, 300))).join('\n')));
    }
  }
  return kids;
}

/* Shown while a step or the task waits at its spending cap. Nothing is spent until the owner answers. */
function budgetBox(t) {
  const q = t.budgetRequest;
  const who = String(q.agentName ?? q.agent ?? 'This step');
  const what = q.kind === 'task' ? `The task has used ${money(q.spentUsd)} of its ${money(q.budgetUsd)} cap before ${who}'s step.` : `${who} has used ${money(q.spentUsd)} of its ${money(q.budgetUsd)} cap for this step.`;
  const extra = Number(q.suggestedUsd) > 0 ? Number(q.suggestedUsd) : 1;
  const busy = state.pending?.id === t.id;
  const allow = el('button', { type: 'button', class: 'primary', 'data-key': 'detail:budget-allow', onclick: () => fire(budget(t.id, { decision: 'allow', extraUsd: extra })) }, `Allow ${money(extra)} more`);
  const stop = el('button', { type: 'button', class: 'danger', 'data-key': 'detail:budget-stop', onclick: () => fire(budget(t.id, { decision: 'stop' })) }, 'Stop here');
  allow.disabled = busy; stop.disabled = busy;
  return el('div', { class: 'risk', role: 'alert' },
    el('p', {}, `${what} The next model request needs about ${money(q.neededUsd)} more. Nothing more is spent until you decide.`),
    el('div', { class: 'actions' }, allow, stop));
}

async function budget(id, body) {
  if (state.pending) return;
  state.pending = { id, action: 'budget' };
  state.actionError = '';
  renderDetail();
  try { await api('POST', `/api/tasks/${enc(id)}/budget`, body); }
  catch (e) { if (state.selected === id) state.actionError = errMsg(e); }
  state.pending = null;
  if (state.selected === id) { renderDetail(); await loadDetail(); }
}

const REJECT_REASONS = [['', 'Reason (optional)'], ['wrong', 'Wrong or broken'], ['too-big', 'Too big'], ['wrong-approach', 'Wrong approach'],
  ['noise', 'Noise, not useful'], ['not-needed', 'Not needed'], ['other', 'Other']];
const RISK_LABELS = {
  'package-manifest': 'package.json', lockfile: 'Lockfile', 'git-hooks': 'Git hook', 'git-attributes': '.gitattributes', ci: 'CI pipeline',
  'package-config': 'Package manager config', 'build-config': 'Build config', 'agent-config': 'Agent config',
  'test-skipped-scripts-changed': 'Tests not run, because the package.json scripts changed',
};
const money = v => (typeof v === 'number' && Number.isFinite(v) ? `$${v < 1 ? v.toFixed(3) : v.toFixed(2)}` : '');
const tokens = n => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));

/* "opus · frontier · $0.412" next to a step: the model that actually ran when known, else the one requested. */
function routeChip(s) {
  const r = s?.route;
  if (!r || typeof r !== 'object') return '';
  const ran = typeof s.metrics?.model === 'string' ? s.metrics.model : String(r.model ?? '');
  const parts = [ran, String(r.class ?? ''), money(s.metrics?.costUsd)].filter(Boolean);
  return el('span', { class: 'chip', title: r.requested && r.requested !== r.class ? `The plan asked for ${r.requested}; this agent's range allows ${r.class}.` : 'Model, class and cost of this step' }, parts.join(' · '));
}

function usageLine(tot) {
  if (!tot || typeof tot !== 'object' || !tot.runs) return '';
  const by = tot.byModel && typeof tot.byModel === 'object' ? Object.entries(tot.byModel).map(([m, v]) => `${m} ×${Number(v?.runs) || 0}`).join(', ') : '';
  const io = Number(tot.inputTokens) + Number(tot.cacheReadTokens) + Number(tot.cacheWriteTokens);
  return `Usage: ${money(tot.costUsd)} over ${tot.runs} run${tot.runs === 1 ? '' : 's'} · ${tokens(io || 0)} in (${tokens(Number(tot.cacheReadTokens) || 0)} from cache), ${tokens(Number(tot.outputTokens) || 0)} out${by ? ` · ${by}` : ''}`;
}

function renderDetail() {
  const box = $('#detail');
  if (!state.selected) { box.hidden = true; box.replaceChildren(); return; }
  box.hidden = false;
  keepFocus(() => box.replaceChildren(...detailNodes()));
}

/* Acts on the task whose detail is on screen, never on a separately tracked selection. */
async function decide(action) {
  const t = state.detail;
  if (!t || state.pending) return;
  const id = t.id;
  state.pending = { id, action };
  state.actionError = '';
  renderDetail();
  const body = action === 'reject' && state.reason ? { reason: state.reason } : {};
  try { await api('POST', `/api/tasks/${enc(id)}/${action}`, body); state.reason = ''; }
  catch (e) { if (state.selected === id) state.actionError = errMsg(e); }
  state.pending = null;
  if (state.selected !== id) return;
  renderDetail();
  await loadDetail();
  focusKey(`detail:${action}`);
}

/* ---------- state and events ---------- */
async function loadState() {
  const s = await json('GET', '/api/state');
  state.project = String(s.project ?? '');
  state.roster = {
    pods: Array.isArray(s.roster?.pods) ? s.roster.pods : [],
    agents: Array.isArray(s.roster?.agents) ? s.roster.agents : [],
  };
  state.tasks = (Array.isArray(s.tasks) ? s.tasks : []).filter(t => t && typeof t.id === 'string');
  $('#project').textContent = state.project;
  const notes = s.notes && typeof s.notes === 'object' ? s.notes : {};
  const notesFile = String(notes.path ?? '');
  const noteBytes = Number.isSafeInteger(notes.bytes) && notes.bytes > 0 ? notes.bytes : 0;
  $('#notes-line').textContent = !notesFile ? '' : noteBytes ? `Project notes: ${noteBytes} bytes · edit ${notesFile}` : `Project notes: none · create ${notesFile}`;
  buildFloor();
  renderTasks();
}

// Runs on every (re)connect: whatever was missed while offline is re-read from the server.
async function resync() {
  try { await loadState(); hideBoot(); } catch (e) { showBoot(e); }
  activity.clearAll();
  updateFloor();
  if (state.selected) await loadDetail();
}

function onEvent(ev) {
  if (!ev || typeof ev !== 'object') return;
  activity.apply(ev);
  if (ev.type === 'task') { upsert(ev.task); updateFloor(); }
  else if (ev.type === 'agent') updateFloor();
}

let source = null;
function connect() {
  if (source) return;
  source = new EventSource(`/api/events?t=${enc(TOKEN)}`);
  source.onopen = () => { setConn(true); fire(resync()); };
  source.onerror = () => {
    setConn(false);
    if (source && source.readyState === EventSource.CLOSED) { source.close(); source = null; setTimeout(connect, 3000); }
  };
  source.onmessage = m => {
    let ev;
    try { ev = JSON.parse(m.data); } catch { return; }
    try { onEvent(ev); } catch (e) { console.error('[floorhands]', e); }
  };
}

/* ---------- new task form ---------- */
const form = $('#new-task');
async function submitTask() {
  const box = $('#task-text'), err = $('#form-error'), btn = $('#send');
  if (btn.disabled) return;
  err.textContent = '';
  if (!box.value.trim()) { err.textContent = 'Type a task first.'; return; }
  btn.disabled = true;
  let id;
  try {
    ({ id } = await json('POST', '/api/tasks', { text: box.value }));
    box.value = '';
  } catch (ex) {
    err.textContent = errMsg(ex);
    btn.disabled = false;
    return;
  }
  btn.disabled = false;
  let loaded = false;
  try { loaded = await select(id); } catch { loaded = false; }
  if (!loaded) err.textContent = 'Task created, but loading it failed. Select it in the list to retry.';
}
form.addEventListener('submit', e => { e.preventDefault(); fire(submitTask()); });
$('#task-text').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); }
});

/* ---------- boot ---------- */
if (typeof matchMedia === 'function') {
  const mq = matchMedia('(max-width: 700px)');
  state.stack = mq.matches;
  mq.addEventListener('change', e => { state.stack = e.matches; buildFloor(); });
}

async function start() {
  try { await loadState(); } catch (e) { showBoot(e); }
  connect();
}
fire(start());

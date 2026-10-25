// Pure, DOM-free helpers for the UI so the logic can be unit-tested under node.

/* ---------- attribute allowlist for the element builder ---------- */
const PLAIN_ATTRS = new Set([
  'class', 'id', 'role', 'tabindex', 'type', 'for', 'title', 'placeholder', 'maxlength', 'rows', 'hidden', 'data-key', 'value',
  'x', 'y', 'cx', 'cy', 'r', 'rx', 'width', 'height', 'viewBox', 'transform',
]);

export const isAllowedAttr = name => typeof name === 'string' && (PLAIN_ATTRS.has(name) || /^aria-[a-z]+$/.test(name));
export const isHandlerKey = name => typeof name === 'string' && /^on[a-z]+$/.test(name);

/* ---------- which agents are busy ---------- */
const TERMINAL = new Set(['done', 'failed', 'approved', 'rejected', 'awaiting_approval']);

export function createActivity() {
  const running = new Map(); // agent id -> Set of task ids it is currently working on
  const tools = new Map();   // agent id -> text of the latest tool chip

  const drop = (agent, taskId) => {
    const set = running.get(agent);
    if (!set) return;
    set.delete(taskId);
    if (!set.size) { running.delete(agent); tools.delete(agent); }
  };
  const clearTask = taskId => { for (const agent of [...running.keys()]) drop(agent, String(taskId)); };

  return {
    apply(ev) {
      if (!ev || typeof ev !== 'object') return;
      if (ev.type === 'task') {
        const t = ev.task;
        if (t && typeof t === 'object' && TERMINAL.has(t.status)) clearTask(t.id);
        return;
      }
      if (ev.type !== 'agent' || typeof ev.agent !== 'string') return;
      const taskId = String(ev.taskId ?? '');
      if (ev.phase === 'start') {
        if (!running.has(ev.agent)) running.set(ev.agent, new Set());
        running.get(ev.agent).add(taskId);
      } else if (ev.phase === 'end') {
        drop(ev.agent, taskId);
      } else if (ev.phase === 'tool' && typeof ev.tool === 'string') {
        tools.set(ev.agent, ev.tool);
      }
    },
    isWorking: agent => running.has(agent),
    tool: agent => tools.get(agent) ?? '',
    clearTask,
    clearAll() { running.clear(); tools.clear(); },
  };
}

/* ---------- unified diff classification ---------- */
export const MAX_DIFF_LINES = 3000;

// state = { inHunk: boolean } is threaded through the lines of one diff.
export function classifyDiffLine(line, state) {
  if (line.startsWith('diff ')) { state.inHunk = false; return 'meta'; }
  if (line.startsWith('@@')) { state.inHunk = true; return 'hunk'; }
  if (!state.inHunk) return 'meta';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  if (line.startsWith('\\')) return 'meta';
  return 'ctx';
}

export function classifyDiff(text, limit = MAX_DIFF_LINES) {
  const lines = String(text ?? '').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const state = { inHunk: false };
  const out = lines.slice(0, limit).map(line => ({ text: line, kind: classifyDiffLine(line, state) }));
  if (lines.length > limit) out.push({ text: `… ${lines.length - limit} more lines not shown`, kind: 'meta' });
  return out;
}

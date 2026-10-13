export const MAX_STEPS = 6;

const MAX_QUOTED = 40;

// Model-supplied text is embedded in problem messages, so cap its length.
function clip(value) {
  return value.length > MAX_QUOTED ? `${value.slice(0, MAX_QUOTED - 3)}...` : value;
}

// Every candidate JSON span, in priority order: fenced bodies that start with
// "{", then the first "{" to the last "}" of the whole reply.
function candidates(text) {
  const out = [];
  for (const m of text.matchAll(/```[a-z]*\s*([\s\S]*?)```/gi)) {
    const body = m[1].trim();
    if (body.startsWith('{')) out.push(body);
  }
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a >= 0 && b > a) out.push(text.slice(a, b + 1));
  return out;
}

export function parsePlan(text, validIds) {
  if (!Array.isArray(validIds)) throw new Error('parsePlan needs a list of valid agent ids');
  if (typeof text !== 'string') throw new Error('The architect did not return a plan (no JSON found).');
  const found = candidates(text);
  if (!found.length) throw new Error('The architect did not return a plan (no JSON found).');
  let doc;
  for (const raw of found) {
    try { doc = JSON.parse(raw); break; } catch { /* try the next candidate */ }
  }
  if (doc === undefined) throw new Error('The architect\'s plan was not valid JSON.');

  const problems = [];
  let summary = '';
  if (typeof doc.summary === 'string') summary = doc.summary.trim();
  else if (doc.summary !== undefined && doc.summary !== null) problems.push('summary is not a string, ignored');

  const steps = [];
  if (doc.steps !== undefined && doc.steps !== null && !Array.isArray(doc.steps)) {
    problems.push('steps is not a list, ignored');
  }
  const list = Array.isArray(doc.steps) ? doc.steps : [];
  for (const [i, s] of list.entries()) {
    const n = i + 1;
    if (s === null || typeof s !== 'object' || Array.isArray(s)) {
      problems.push(`step ${n} is not an object, skipped`);
      continue;
    }
    if (typeof s.agent !== 'string') {
      problems.push(`step ${n} has no valid agent (must be a string), skipped`);
      continue;
    }
    if (!validIds.includes(s.agent)) {
      problems.push(`step ${n}: unknown agent "${clip(s.agent)}" skipped`);
      continue;
    }
    const task = typeof s.task === 'string' ? s.task.trim() : '';
    if (!task) {
      problems.push(`step ${n} for ${clip(s.agent)} has no task, skipped`);
      continue;
    }
    if (steps.length >= MAX_STEPS) {
      problems.push(`more than ${MAX_STEPS} steps; the rest were dropped`);
      break;
    }
    steps.push({ agent: s.agent, task });
  }

  if (!steps.length && !summary) throw new Error('The architect\'s plan had no steps and no answer.');
  return { summary, steps, problems };
}

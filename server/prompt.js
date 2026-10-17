// Per-task system prompt: common rules, tier note, project facts (data), owner notes (guidance), relevant skill hints, role body.
// Nothing here reads the repository; facts and notes arrive already validated (stack.js, notes.js) and are re-framed defensively.
import { renderFacts } from './stack.js';
import { renderNotes } from './notes.js';

// The prompt travels in argv (--append-system-prompt), so this cap is a hard limit, measured in bytes.
export const MAX_SYSTEM_BYTES = 24 * 1024;

const SKILLS_INTRO = 'Optional Claude skills (call with the Skill tool only if they exist; if a call fails or the skill is missing, continue with the checklist below — never stop for a missing skill): ';
const FACTS_TAG = 'project_facts';
const NOTES_TAG = 'owner_notes';

// Make any spelling of a closing tag (`</tag>`, `</ tag >`, `< /TAG\n>`) visibly inert so embedded text cannot end a frame.
const neutralise = (text, tag) => String(text).replace(new RegExp(`<\\s*\\/\\s*${tag}\\s*>`, 'gi'), m => m.replace('/', '\\/'));
const defuse = text => neutralise(neutralise(text, FACTS_TAG), NOTES_TAG);

const isObject = v => v !== null && typeof v === 'object';

// Skill entries are a string or { name, alt?, when? }; returns the hints that apply to these facts, as { name, alt }.
export function skillHints(agent, facts) {
  const tags = new Set(Array.isArray(facts?.tags) ? facts.tags : []);
  const out = [];
  for (const entry of agent?.skills ?? []) {
    const e = typeof entry === 'string' ? { name: entry } : entry;
    if (typeof e?.name !== 'string' || !e.name) continue;
    if (Array.isArray(e.when) && !e.when.some(t => tags.has(t))) continue;
    out.push({ name: e.name, alt: Array.isArray(e.alt) ? e.alt.filter(a => typeof a === 'string' && a) : [] });
  }
  return out;
}

function skillsBlock(agent, facts) {
  const hints = skillHints(agent, facts);
  if (!hints.length) return '';
  return SKILLS_INTRO + hints.map(h => (h.alt.length ? `${h.name} (also tried as ${h.alt.join(', ')})` : h.name)).join('; ');
}

function factsBlock(facts) {
  if (!isObject(facts)) return '';
  const rendered = renderFacts(facts).trimEnd();
  return rendered ? `<${FACTS_TAG}>\n${defuse(rendered)}\n</${FACTS_TAG}>` : '';
}

function notesBlock(notes) {
  if (!isObject(notes) || typeof notes.text !== 'string' || !notes.text) return '';
  return renderNotes({ ...notes, text: defuse(notes.text) });
}

export function buildSystem(agent, { facts, notes } = {}) {
  // An agent record without parts (for example a hand-built one) contributes its `system` text as the body.
  const parts = isObject(agent?.parts) ? agent.parts : { intro: '', tierNote: '', body: agent?.system ?? '' };
  const system = [parts.intro, parts.tierNote, factsBlock(facts), notesBlock(notes), skillsBlock(agent, facts), parts.body]
    .filter(Boolean)
    .join('\n\n');
  if (Buffer.byteLength(system) > MAX_SYSTEM_BYTES) {
    throw new Error(`system prompt for "${agent?.id}" is ${Buffer.byteLength(system)} bytes, over the 24 KB limit`);
  }
  return system;
}

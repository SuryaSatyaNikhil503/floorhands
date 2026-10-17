import fs from 'node:fs';
import path from 'node:path';
import { TIERS } from './tiers.js';
import { FACT_TAGS } from './stack.js';
import { buildSystem } from './prompt.js';

const TIER_NOTES = {
  read: 'Tier: READ-ONLY. You can read files, search, run read-only git commands and call skills. You cannot edit files or run other commands. Report findings; never claim to have changed anything.',
  build: 'Tier: BUILD. You work in an isolated git worktree, never the owner\'s working copy. You can read and edit files there and run lint/build scripts. You cannot commit, push or run other commands; floorhands commits your changes for the owner to approve or reject.',
  test: 'Tier: TEST. You work in an isolated git worktree. You can read files and run the project\'s test commands. You cannot edit source files; report failures with the exact command and output.',
};
const PROMPT_FILE = /^[\w.-]+\.md$/;
const SKILL_NAME = /^[A-Za-z0-9][\w.:-]{0,99}$/;

// A skill entry is a name, or { name, alt?: string[], when?: fact tags[] } (a hint shown only when the detected facts have one of the tags).
function skillProblems(skills) {
  if (skills === undefined) return [];
  if (!Array.isArray(skills)) return ['skills must be a list'];
  const problems = [];
  skills.forEach((e, i) => {
    const at = `skill entry ${i}`;
    if (typeof e === 'string') {
      if (!SKILL_NAME.test(e)) problems.push(`${at}: name must be a plain skill name`);
      return;
    }
    if (!e || typeof e !== 'object' || Array.isArray(e)) { problems.push(`${at} must be a name or an object { name, alt?, when? }`); return; }
    if (typeof e.name !== 'string' || !SKILL_NAME.test(e.name)) problems.push(`${at}: name must be a plain skill name`);
    if (e.alt !== undefined && !(Array.isArray(e.alt) && e.alt.every(a => typeof a === 'string' && SKILL_NAME.test(a)))) problems.push(`${at}: alt must be a list of skill names`);
    if (e.when !== undefined) {
      if (!Array.isArray(e.when) || e.when.length === 0) problems.push(`${at}: when must be a non-empty list of fact tags (leave it out to always show the hint)`);
      else {
        const unknown = e.when.filter(t => !FACT_TAGS.includes(t));
        if (unknown.length) problems.push(`${at}: when has unknown fact tags ${unknown.map(t => JSON.stringify(t)).join(', ')}`);
      }
    }
  });
  return problems;
}

export function validateRoster(doc) {
  if (!doc || !Array.isArray(doc.pods) || !Array.isArray(doc.agents)) return ['roster.json needs "pods" and "agents" lists'];
  const problems = [];
  const podIds = new Set(doc.pods.map(p => p.id));
  const ids = new Set();
  const leads = {};
  let routers = 0;
  for (const a of doc.agents) {
    if (!a.id || !a.name || !a.role || !a.pod || !a.prompt) problems.push(`agent ${a.id ?? '(no id)'} needs id, name, role, pod and prompt`);
    if (ids.has(a.id)) problems.push(`duplicate agent id "${a.id}"`);
    ids.add(a.id);
    if (!podIds.has(a.pod)) problems.push(`agent "${a.id}" is in unknown pod "${a.pod}"`);
    if (!Object.hasOwn(TIERS, a.tier)) problems.push(`agent "${a.id}" has unknown tier "${a.tier}"`);
    if (a.prompt && !PROMPT_FILE.test(a.prompt)) problems.push(`agent "${a.id}": prompt file name "${a.prompt}" must be a plain .md file name`);
    for (const p of skillProblems(a.skills)) problems.push(`agent "${a.id}": ${p}`);
    if (a.lead) leads[a.pod] = (leads[a.pod] ?? 0) + 1;
    if (a.router) routers++;
  }
  for (const p of doc.pods) if ((leads[p.id] ?? 0) !== 1) problems.push(`pod "${p.id}" needs exactly one lead`);
  if (routers !== 1) problems.push('exactly one agent must have "router": true');
  return problems;
}

export const composeParts = (common, agent, body) => ({
  intro: common.replaceAll('{{name}}', agent.name).replaceAll('{{role}}', agent.role),
  tierNote: TIER_NOTES[agent.tier],
  body,
});

// Backward compatible: the system prompt as composed with no project facts and no owner notes.
export const composeSystem = (common, agent, body) => buildSystem({ ...agent, parts: composeParts(common, agent, body) }, {});

export function loadRoster(agentsDir) {
  const doc = JSON.parse(fs.readFileSync(path.join(agentsDir, 'roster.json'), 'utf8'));
  const problems = validateRoster(doc);
  if (problems.length) throw new Error('roster.json: ' + problems.join('; '));
  const common = fs.readFileSync(path.join(agentsDir, 'prompts', '_common.md'), 'utf8').trim();
  const agents = doc.agents.map(a => {
    const body = fs.readFileSync(path.join(agentsDir, 'prompts', a.prompt), 'utf8').trim();
    const full = { ...a, skills: a.skills ?? [] };
    const parts = composeParts(common, full, body);
    return { ...full, parts, system: buildSystem({ ...full, parts }, {}) };
  });
  return {
    pods: doc.pods,
    agents,
    byId: Object.fromEntries(agents.map(a => [a.id, a])),
    router: agents.find(a => a.router),
  };
}

export const publicAgent = a => ({
  id: a.id, name: a.name, role: a.role, pod: a.pod, lead: !!a.lead, router: !!a.router, tier: a.tier, skills: (a.skills ?? []).map(e => (typeof e === 'string' ? e : e.name)),
});

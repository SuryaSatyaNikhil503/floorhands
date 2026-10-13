import fs from 'node:fs';
import path from 'node:path';
import { TIERS } from './tiers.js';

const TIER_NOTES = {
  read: 'Tier: READ-ONLY. You can read files, search, run read-only git commands and call skills. You cannot edit files or run other commands. Report findings; never claim to have changed anything.',
  build: 'Tier: BUILD. You work in an isolated git worktree, never the owner\'s working copy. You can read and edit files there and run lint/build scripts. You cannot commit, push or run other commands; floorhands commits your changes for the owner to approve or reject.',
  test: 'Tier: TEST. You work in an isolated git worktree. You can read files and run the project\'s test commands. You cannot edit source files; report failures with the exact command and output.',
};
const PROMPT_FILE = /^[\w.-]+\.md$/;

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
    if (a.lead) leads[a.pod] = (leads[a.pod] ?? 0) + 1;
    if (a.router) routers++;
  }
  for (const p of doc.pods) if ((leads[p.id] ?? 0) !== 1) problems.push(`pod "${p.id}" needs exactly one lead`);
  if (routers !== 1) problems.push('exactly one agent must have "router": true');
  return problems;
}

export function composeSystem(common, agent, body) {
  const skills = agent.skills?.length
    ? `Claude skills to call with the Skill tool when they apply: ${agent.skills.join(', ')}. If one is not available, say so and continue with the checklist below.`
    : '';
  const intro = common.replaceAll('{{name}}', agent.name).replaceAll('{{role}}', agent.role);
  return [intro, TIER_NOTES[agent.tier], skills, body].filter(Boolean).join('\n\n');
}

export function loadRoster(agentsDir) {
  const doc = JSON.parse(fs.readFileSync(path.join(agentsDir, 'roster.json'), 'utf8'));
  const problems = validateRoster(doc);
  if (problems.length) throw new Error('roster.json: ' + problems.join('; '));
  const common = fs.readFileSync(path.join(agentsDir, 'prompts', '_common.md'), 'utf8').trim();
  const agents = doc.agents.map(a => {
    const body = fs.readFileSync(path.join(agentsDir, 'prompts', a.prompt), 'utf8').trim();
    const full = { ...a, skills: a.skills ?? [] };
    return { ...full, system: composeSystem(common, full, body) };
  });
  return {
    pods: doc.pods,
    agents,
    byId: Object.fromEntries(agents.map(a => [a.id, a])),
    router: agents.find(a => a.router),
  };
}

export const publicAgent = a => ({
  id: a.id, name: a.name, role: a.role, pod: a.pod, lead: !!a.lead, router: !!a.router, tier: a.tier, skills: a.skills ?? [],
});

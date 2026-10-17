// The v0.1.0 system-prompt composition, reproduced from `git show main:server/roster.js`, for the `old` variant of the prompt evaluation.
// The files next to this one (agents/roster.json and agents/prompts/*.md) are unmodified copies of what v0.1.0 shipped.
// test/eval-lib.test.js proves the output is byte-identical to the v0.1.0 checkout's own loadRoster.
import fs from 'node:fs';
import path from 'node:path';

const TIER_NOTES = {
  read: 'Tier: READ-ONLY. You can read files, search, run read-only git commands and call skills. You cannot edit files or run other commands. Report findings; never claim to have changed anything.',
  build: 'Tier: BUILD. You work in an isolated git worktree, never the owner\'s working copy. You can read and edit files there and run lint/build scripts. You cannot commit, push or run other commands; floorhands commits your changes for the owner to approve or reject.',
  test: 'Tier: TEST. You work in an isolated git worktree. You can read files and run the project\'s test commands. You cannot edit source files; report failures with the exact command and output.',
};

export function composeLegacySystem(common, agent, body) {
  const skills = agent.skills?.length
    ? `Claude skills to call with the Skill tool when they apply: ${agent.skills.join(', ')}. If one is not available, say so and continue with the checklist below.`
    : '';
  const intro = common.replaceAll('{{name}}', agent.name).replaceAll('{{role}}', agent.role);
  return [intro, TIER_NOTES[agent.tier], skills, body].filter(Boolean).join('\n\n');
}

// Same shape as v0.1.0 loadRoster, minus validation: { agents: [{ ...agent, skills, system }], byId }.
export function loadLegacyRoster(agentsDir) {
  const doc = JSON.parse(fs.readFileSync(path.join(agentsDir, 'roster.json'), 'utf8'));
  const common = fs.readFileSync(path.join(agentsDir, 'prompts', '_common.md'), 'utf8').trim();
  const agents = doc.agents.map(a => {
    const body = fs.readFileSync(path.join(agentsDir, 'prompts', a.prompt), 'utf8').trim();
    const full = { ...a, skills: a.skills ?? [] };
    return { ...full, system: composeLegacySystem(common, full, body) };
  });
  return { agents, byId: Object.fromEntries(agents.map(a => [a.id, a])) };
}

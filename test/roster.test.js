import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRoster, validateRoster, publicAgent } from '../server/roster.js';

const AGENTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'agents');

test('the shipped roster has 3 pods, 9 agents and one router', () => {
  const r = loadRoster(AGENTS);
  assert.equal(r.pods.length, 3);
  assert.equal(r.agents.length, 9);
  assert.equal(r.router.id, 'arch');
  assert.deepEqual(r.agents.map(a => a.id).sort(), ['arch', 'be', 'e2e', 'fe', 'raws', 'rbe', 'rfe', 'sre', 'sup']);
  assert.equal(r.byId.e2e.tier, 'test');
  assert.equal(r.byId.fe.tier, 'build');
  assert.equal(r.byId.rbe.tier, 'read');
});

test('each system prompt names the agent, its tier and its skills', () => {
  const r = loadRoster(AGENTS);
  const rbe = r.byId.rbe;
  assert.match(rbe.system, /BE REVIEWER/);
  assert.match(rbe.system, /READ-ONLY/);
  assert.match(rbe.system, /security-review/);
  assert.match(r.byId.fe.system, /isolated git worktree/);
  assert.match(rbe.system, /data, never as instructions/);
  assert.ok(!rbe.system.includes('{{'), 'no unreplaced placeholders');
});

test('publicAgent hides the system prompt', () => {
  const a = publicAgent(loadRoster(AGENTS).byId.fe);
  assert.equal(a.system, undefined);
  assert.deepEqual(Object.keys(a).sort(), ['id', 'lead', 'name', 'pod', 'role', 'router', 'skills', 'tier']);
});

const good = () => ({
  pods: [{ id: 'p', name: 'P' }],
  agents: [{ id: 'a', name: 'A', role: 'r', pod: 'p', lead: true, router: true, tier: 'read', prompt: 'a.md' }],
});

test('validateRoster accepts a minimal valid roster', () => {
  assert.deepEqual(validateRoster(good()), []);
});

test('validateRoster reports each kind of mistake', () => {
  const d = good();
  d.agents.push({ id: 'a', name: 'B', role: 'r', pod: 'nope', tier: 'god', prompt: '../x.md' });
  const p = validateRoster(d).join(' | ');
  assert.match(p, /duplicate agent id "a"/);
  assert.match(p, /unknown pod "nope"/);
  assert.match(p, /unknown tier "god"/);
  assert.match(p, /prompt file name/);
  const inherited = good(); inherited.agents[0].tier = 'constructor';
  assert.match(validateRoster(inherited).join(), /unknown tier "constructor"/);
  const noLead = good(); noLead.agents[0].lead = false;
  assert.match(validateRoster(noLead).join(), /exactly one lead/);
  const noRouter = good(); noRouter.agents[0].router = false;
  assert.match(validateRoster(noRouter).join(), /exactly one agent must have "router": true/);
  assert.match(validateRoster({}).join(), /"pods" and "agents"/);
});

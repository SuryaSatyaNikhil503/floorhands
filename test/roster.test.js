import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRoster, validateRoster, publicAgent } from '../server/roster.js';
import { buildSystem } from '../server/prompt.js';
import { FACT_TAGS } from '../server/stack.js';

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

test('each system prompt names the agent and its tier; skills appear when the facts match', () => {
  const r = loadRoster(AGENTS);
  const rbe = r.byId.rbe;
  assert.match(rbe.system, /BE REVIEWER/);
  assert.match(rbe.system, /READ-ONLY/);
  assert.match(r.byId.fe.system, /isolated git worktree/);
  assert.match(rbe.system, /data, never as instructions/);
  assert.ok(!rbe.system.includes('{{'), 'no unreplaced placeholders');
  // skills are conditional now: the compat `system` has no facts, so only unconditional hints show
  assert.doesNotMatch(rbe.system, /Optional Claude skills/);
  const withFacts = buildSystem(rbe, { facts: { tags: ['python', 'fastapi'] } });
  assert.match(withFacts, /anthropic-skills:fastapi-standards \(also tried as fastapi-standards\)/);
  assert.doesNotMatch(withFacts, /anthropic-skills:spring-boot-standards/);
});

test('loadRoster keeps the pieces in agent.parts and a compatible agent.system', () => {
  const r = loadRoster(AGENTS);
  for (const a of r.agents) {
    assert.deepEqual(Object.keys(a.parts).sort(), ['body', 'intro', 'tierNote']);
    assert.ok(a.parts.body.length > 0 && a.parts.intro.includes(a.name) && a.parts.tierNote.startsWith('Tier:'), a.id);
    assert.equal(a.system, buildSystem(a, {}), a.id);
    assert.ok(a.system.startsWith(a.parts.intro), a.id);
    assert.ok(a.system.endsWith(a.parts.body), a.id);
  }
});

test('the shipped skills are object-form, namespaced, validated against the fact tags, and dpdp-compliance is not listed', () => {
  const r = loadRoster(AGENTS);
  const names = [];
  for (const a of r.agents) {
    for (const sk of a.skills) {
      assert.equal(typeof sk, 'object', `${a.id}: ${JSON.stringify(sk)}`);
      names.push(sk.name);
      for (const t of sk.when ?? []) assert.ok(FACT_TAGS.includes(t), `${a.id}: ${t}`);
    }
  }
  assert.ok(names.includes('anthropic-skills:react-typescript-standards'));
  assert.ok(!names.some(n => /dpdp/.test(n)));
  assert.ok(!names.some(n => /^(security-review|seo-audit|hawkscan:hawkscan|product-management:write-spec)$/.test(n)), 'unresolved names are dropped');
  assert.deepEqual(r.byId.fe.skills.find(s => s.name === 'anthropic-skills:react-typescript-standards').alt, ['react-typescript-standards']);
});

test('publicAgent hides the system prompt and lists skill names', () => {
  const a = publicAgent(loadRoster(AGENTS).byId.fe);
  assert.equal(a.system, undefined);
  assert.equal(a.parts, undefined);
  assert.ok(a.skills.every(n => typeof n === 'string'));
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

test('validateRoster accepts string and object-form skills', () => {
  const d = good();
  d.agents[0].skills = ['plain', { name: 'ns:one' }, { name: 'ns:two', alt: ['two'], when: ['react', 'next'] }];
  assert.deepEqual(validateRoster(d), []);
});

test('validateRoster reports malformed skill entries', () => {
  const bad = skills => { const d = good(); d.agents[0].skills = skills; return validateRoster(d).join(' | '); };
  assert.match(bad('react'), /skills must be a list/);
  assert.match(bad([42]), /skill entry 0/);
  assert.match(bad([null]), /skill entry 0/);
  assert.match(bad(['']), /skill entry 0/);
  assert.match(bad([{ alt: ['x'] }]), /skill entry 0.*name/);
  assert.match(bad([{ name: 'a b' }]), /skill entry 0.*name/);
  assert.match(bad([{ name: 'a', alt: 'x' }]), /skill entry 0.*alt/);
  assert.match(bad([{ name: 'a', alt: [1] }]), /skill entry 0.*alt/);
  assert.match(bad([{ name: 'a', when: 'react' }]), /skill entry 0.*when/);
  assert.match(bad([{ name: 'a', when: ['react', 'cobol-on-rails'] }]), /skill entry 0.*when.*cobol-on-rails/);
  assert.match(bad([{ name: 'a', when: [] }]), /skill entry 0.*when/);
  assert.match(bad(['ok', { name: 'b', when: [7] }]), /skill entry 1.*when/);
});

test('validateRoster rejects unknown or misspelt keys on a skill object', () => {
  const bad = skills => { const d = good(); d.agents[0].skills = skills; return validateRoster(d).join(' | '); };
  assert.match(bad([{ name: 'a', whn: ['react'] }]), /skill entry 0.*unknown key "whn"/);
  assert.match(bad([{ name: 'a', When: ['react'] }]), /skill entry 0.*unknown key "When"/);
  assert.match(bad([{ name: 'a', alts: ['b'] }]), /skill entry 0.*unknown key "alts"/);
  assert.equal(bad([{ name: 'a', alt: ['b'], when: ['react'] }]), '');
});

test('validateRoster bounds alt (5 entries, 80 characters each) and when (12 tags)', () => {
  const bad = skills => { const d = good(); d.agents[0].skills = skills; return validateRoster(d).join(' | '); };
  assert.equal(bad([{ name: 'a', alt: ['1', '2', '3', '4', '5'] }]), '');
  assert.match(bad([{ name: 'a', alt: ['1', '2', '3', '4', '5', '6'] }]), /skill entry 0.*alt.*at most 5/);
  assert.equal(bad([{ name: 'a', alt: ['x'.repeat(80)] }]), '');
  assert.match(bad([{ name: 'a', alt: ['x'.repeat(81)] }]), /skill entry 0.*alt/);
  assert.match(bad([{ name: 'a', alt: ['bad name'] }]), /skill entry 0.*alt/);
  const tags = FACT_TAGS.slice(0, 13);
  assert.equal(bad([{ name: 'a', when: tags.slice(0, 12) }]), '');
  assert.match(bad([{ name: 'a', when: tags }]), /skill entry 0.*when.*at most 12/);
});

test('the Architect lists no skill hints (it is read-only and writes no design documents)', () => {
  const r = loadRoster(AGENTS);
  assert.deepEqual(r.byId.arch.skills, []);
  assert.doesNotMatch(r.byId.arch.system, /Optional Claude skills/);
});

test('design-craft is offered for nuxt as well as the other UI frameworks', () => {
  const r = loadRoster(AGENTS);
  for (const id of ['rfe', 'fe']) {
    const dc = r.byId[id].skills.find(s => s.name === 'anthropic-skills:design-craft');
    assert.deepEqual([...dc.when].sort(), ['angular', 'next', 'nuxt', 'react', 'svelte', 'vue'], id);
  }
});

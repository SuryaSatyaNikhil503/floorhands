// Prompt lint: ties every shipped agent prompt to the permission model in server/tiers.js (see docs/design/prompts-v2-design.md, section 6).
// The helpers are unit-tested against synthetic prompts that DO violate each rule. The required-sections case of a role is `todo` while
// its prompt is still the v0.1.0 prose (none of its required headings exist) and a real test from its rewrite on (see todoReason).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRoster } from '../server/roster.js';
import { buildSystem, MAX_SYSTEM_BYTES } from '../server/prompt.js';
import { TIERS, denyRules } from '../server/tiers.js';
import { FACT_TAGS, _testing } from '../server/stack.js';
import { parsePlan, MAX_STEPS } from '../server/plan.js';

const AGENTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'agents');
const MAX_BODY_BYTES = 9 * 1024;
const NOTES_BYTES = 4 * 1024;

// Required headings. THE one place to extend: Tasks 5-6 add each role's headings here, keyed by agent id.
// `_common` is agents/prompts/_common.md, the shared rules every agent receives first (it holds the shared `## Method` and `## Report`);
// every other key is an agent id and lists that role body's own headings. An agent without an entry needs UNLISTED_ROLE_SECTIONS, so a
// rewritten body cannot skip the table. The sections case turns from `todo` into a real test as soon as a body has any required heading
// (see `todoReason`), so a half-finished rewrite fails instead of hiding behind the flag.
const UNLISTED_ROLE_SECTIONS = ['## Method', '## Report'];
export const REQUIRED_SECTIONS = {
  _common: ['## Who you are and the ground rules', '## Method', '## Severity', '## Finding format', '## Report',
    '## Working with other agents', '## When something is missing'],
  arch: ['## Your job', '## Routing rules', '## Plan quality', '## Plan format', '## Answering directly', '## Architecture advice'],
};
const sectionsFor = id => (Object.hasOwn(REQUIRED_SECTIONS, id) ? REQUIRED_SECTIONS[id] : UNLISTED_ROLE_SECTIONS);

// ---- lint helpers ---------------------------------------------------------------------------------------------------------------

const bytes = s => Buffer.byteLength(s);
const FENCE = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm;
const withoutFences = text => text.replace(FENCE, '');

// Personal or project-specific data must never ship in a prompt.
const FORBIDDEN_MENTIONS = [
  [/\/Users\//i, 'a home-directory path (/Users/...)'],
  [/\babhudaya\b/i, 'a specific project name'],
  [/\bthink[\s-]*tank\b/i, 'a specific project name'],
  [/\bsurya\b|\bnikhil\b|\bgadhavajula\b|\bsatyanikhil\b/i, 'a personal name'],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/, 'an email address'],
];
export function lintMentions(text) {
  return FORBIDDEN_MENTIONS.filter(([re]) => re.test(text)).map(([, what]) => `mentions ${what}`);
}

// Commands: inline code spans whose first word is a command-line program. A span that is only the bare program name is a mention of
// the tool (for example when saying it is unavailable); a span with arguments is an instruction to run it.
const COMMAND_WORDS = new Set([
  'npm', 'npx', 'pnpm', 'yarn', 'bun', 'node', 'git', 'curl', 'wget', 'cat', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'ag',
  'sed', 'awk', 'sort', 'uniq', 'cut', 'tr', 'diff', 'find', 'ls', 'echo', 'tee', 'xargs', 'env', 'aws', 'terraform', 'cdk', 'docker', 'kubectl',
  'pip', 'pip3', 'python', 'python3', 'rm', 'cp', 'mv', 'mkdir', 'touch', 'chmod', 'sudo', 'ssh', 'scp', 'sh', 'bash', 'zsh', 'make', 'mvn', 'gradle', 'pytest',
]);
const SHELL_READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'sed', 'awk', 'sort', 'uniq', 'cut', 'tr', 'diff', 'find', 'ls']);

export function inlineCommands(text) {
  const out = [];
  for (const m of withoutFences(text).matchAll(/`([^`\n]+)`/g)) {
    const span = m[1].trim().replace(/^\$\s+/, '');
    const words = span.split(/\s+/);
    if (words.length > 1 && COMMAND_WORDS.has(words[0])) out.push(span);
  }
  return out;
}

// Mirrors how server/tiers.js writes its rules: `Bash(<prefix>:*)` matches the command or the prefix followed by a space; a rule
// without `:*` (the mid-position git flag denies) is a glob where `*` matches anything.
function parseBashRule(rule) {
  const m = /^Bash\((.*)\)$/.exec(rule);
  if (!m) return null;
  const inner = m[1];
  if (inner.endsWith(':*')) return { prefix: inner.slice(0, -2) };
  return { glob: new RegExp(`^${inner.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`) };
}
const ruleMatches = (rule, cmd) => (rule.prefix !== undefined ? cmd === rule.prefix || cmd.startsWith(`${rule.prefix} `) : rule.glob.test(cmd));
const bashRules = list => list.map(parseBashRule).filter(Boolean);

export function commandVerdict(tier, command) {
  const allow = bashRules(TIERS[tier].allow);
  const deny = bashRules(denyRules());
  // The CLI checks each part of a compound command; `<placeholder>` text is not a redirect.
  const cleaned = command.replace(/<[A-Za-z_][\w -]*>/g, 'X');
  if (/[<>]/.test(cleaned)) return { ok: false, why: 'uses a shell redirect, which is not allowed' };
  for (const part of cleaned.split(/\s*(?:&&|\|\||;|\|)\s*/).filter(Boolean)) {
    const denied = deny.find(r => ruleMatches(r, part));
    if (denied) return { ok: false, why: `is denied for every tier${SHELL_READERS.has(part.split(' ')[0]) ? '; name the Read, Grep or Glob tool instead' : ''}` };
    if (!allow.some(r => ruleMatches(r, part))) return { ok: false, why: `is not allowed for the ${tier} tier${SHELL_READERS.has(part.split(' ')[0]) ? '; name the Read, Grep or Glob tool instead' : ''}` };
  }
  return { ok: true };
}
export function lintCommands(text, tier) {
  return inlineCommands(text).flatMap(c => {
    const v = commandVerdict(tier, c);
    return v.ok ? [] : [`command \`${c}\` ${v.why}`];
  });
}

// Prose rules. A sentence that also carries a negation or limitation ("You cannot edit files") is describing a limit, not giving an order.
const sentences = text => withoutFences(text).replace(/`[^`\n]*`/g, ' ').split(/(?<=[.!?:;])\s+|\n+/).map(s => s.trim()).filter(Boolean);
const NEGATION = /\b(?:cannot|can't|can not|never|must not|mustn't|do not|don't|does not|doesn't|not allowed|no |not |without|read-only|denied|unable|only reports?|instead of)\b/i;
const EDIT_VERBS = /\b(?:edit|modify|patch|rewrite|refactor|change the code|fix the code|apply (?:a |the )?(?:fix|patch|change)s?|write (?:a |the |new )?(?:file|code|test|fix|patch)s?|create (?:a |the |new )?(?:file|branch|test)s?|delete (?:a |the )?files?)\b/i;
const COMMIT_VERBS = /\b(?:commit|push|git add|open a pull request|merge)\b/i;
const NETWORK_CLAIMS = /\b(?:browse the web|search the web|web search|search online|look(?:ing)? (?:it )?up online|fetch (?:the |a )?(?:url|page|site|website)|visit (?:the |a )?(?:url|site|website|page)|open (?:the |a )?(?:url|website)|download|make (?:an? )?http request|call (?:the |an )?external api|google)\b/i;

const orders = (text, re) => sentences(text).filter(s => re.test(s) && !NEGATION.test(s));

export function lintTierClaims(text, tier) {
  const problems = [];
  if (tier === 'read' || tier === 'test') {
    for (const s of orders(text, EDIT_VERBS)) problems.push(`${tier}-tier prompt tells the agent to edit files: "${s.slice(0, 80)}"`);
  }
  for (const s of orders(text, COMMIT_VERBS)) problems.push(`${tier}-tier prompt tells the agent to commit or push: "${s.slice(0, 80)}"`);
  for (const s of orders(text, NETWORK_CLAIMS)) problems.push(`prompt claims web or network access: "${s.slice(0, 80)}"`);
  return problems;
}

// A heading counts only where a reader sees it: not inside a code fence or an HTML comment (closed ones, and unclosed ones, which run
// to the end of the text).
const UNCLOSED_FENCE = /^(?:`{3,}|~{3,})[\s\S]*/m;
const COMMENT = /<!--[\s\S]*?(?:-->|$(?![\s\S]))/g;
const visibleText = text => withoutFences(text).replace(UNCLOSED_FENCE, '').replace(COMMENT, '');

export function lintSections(body, required) {
  const visible = visibleText(body);
  return required.filter(h => !new RegExp(`^${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(visible)).map(h => `missing required section "${h}"`);
}

export function lintSize(body) {
  return bytes(body) > MAX_BODY_BYTES ? [`role body is ${bytes(body)} bytes (limit ${MAX_BODY_BYTES})`] : [];
}

// Self-arming todo: a prompt that has none of its required headings is still the v0.1.0 prose awaiting its rewrite (a TODO). The moment
// any required heading exists, the rewrite has started and the case is a real test that fails until every required heading is there.
export function todoReason(agent, required = sectionsFor(agent.id)) {
  const present = required.length - lintSections(agent.parts.body, required).length;
  return present === 0 ? 'enabled by the prompt rewrite (Tasks 4-6)' : false;
}

export function lintAgent(agent, { required = sectionsFor(agent.id) } = {}) {
  const system = buildSystem(agent, {});
  return [
    ...lintSections(agent.parts.body, required),
    ...lintSize(agent.parts.body),
    ...lintMentions(system),
    ...lintCommands(system, agent.tier),
    ...lintTierClaims(system, agent.tier),
  ];
}

// ---- helper unit tests: each rule catches a prompt that violates it --------------------------------------------------------------

test('commandVerdict mirrors the tier allow and deny prefix rules', () => {
  assert.deepEqual(commandVerdict('read', 'git diff HEAD~1'), { ok: true });
  assert.deepEqual(commandVerdict('read', 'git log --oneline -5'), { ok: true });
  assert.deepEqual(commandVerdict('build', 'npm run lint'), { ok: true });
  assert.deepEqual(commandVerdict('test', 'npm test'), { ok: true });
  assert.deepEqual(commandVerdict('test', 'npm run e2e'), { ok: true });
  assert.equal(commandVerdict('read', 'npm test').ok, false, 'read tier cannot run npm');
  assert.equal(commandVerdict('build', 'npm test').ok, false, 'build tier has no test commands');
  assert.equal(commandVerdict('test', 'npm run lint').ok, false);
  assert.equal(commandVerdict('test', 'npx playwright test').ok, false);
  assert.equal(commandVerdict('read', 'git push origin main').ok, false);
  assert.equal(commandVerdict('build', 'git commit -m x').ok, false);
  assert.equal(commandVerdict('read', 'git diff --output=x').ok, false, 'mid-position flag deny');
  assert.equal(commandVerdict('read', 'git log -1 --output=x').ok, false);
  assert.equal(commandVerdict('read', 'git difftool').ok, false, 'a prefix must end at a word boundary');
  assert.equal(commandVerdict('read', 'git status && git push').ok, false, 'every part of a compound command is checked');
  assert.equal(commandVerdict('read', 'git log | cat').ok, false);
  assert.equal(commandVerdict('read', 'git diff main..HEAD > out.txt').ok, false, 'redirects are refused');
  assert.deepEqual(commandVerdict('read', 'git diff <base>..HEAD'), { ok: true }, 'a placeholder is not a redirect');
});

test('lint flags a read-tier prompt that tells the agent to run npx, cat .env, git push or npm test', () => {
  const bad = 'Run `npx eslint .` first, then `cat .env` to see config, and finish with `git push origin main`. Also try `npm test`.';
  const problems = lintCommands(bad, 'read');
  assert.equal(problems.length, 4, problems.join('\n'));
  assert.match(problems[0], /npx eslint \./);
  assert.match(problems[1], /cat \.env.*Read, Grep or Glob/);
  assert.match(problems[2], /git push/);
  assert.match(problems[3], /npm test.*read tier/);
});

test('lint flags a test-tier prompt that runs npx and a build-tier prompt that runs the tests', () => {
  assert.equal(lintCommands('Use `npx playwright test` for the e2e run.', 'test').length, 1);
  assert.equal(lintCommands('Verify with `npm run lint` and `npm run build`; run `npm test` too.', 'build').length, 1);
  assert.deepEqual(lintCommands('Verify with `npm run lint` and `npm run build`.', 'build'), []);
});

test('inlineCommands reads inline code only, ignores fenced blocks and bare tool mentions', () => {
  const text = 'Use `git diff main..HEAD` and `Read`. The `cat` command is denied. `package.json` is a file.\n```\nnpx something\n```\n`$ git status`';
  assert.deepEqual(inlineCommands(text), ['git diff main..HEAD', 'git status']);
});

test('lint flags personal data and project names, case-insensitively', () => {
  for (const [text, what] of [
    ['See /Users/x/project for context.', /home-directory/],
    ['Written for Abhudaya.', /project name/],
    ['The ABHUDAYA site.', /project name/],
    ['A think tank page.', /project name/],
    ['Ask Surya about it.', /personal name/],
    ['Owner is Nikhil.', /personal name/],
    ['Mail someone@example.com for help.', /email/],
  ]) {
    const p = lintMentions(text);
    assert.ok(p.some(x => what.test(x)), `${text} -> ${p}`);
  }
  assert.deepEqual(lintMentions('Review the project at hand. Contact the owner.'), []);
});

test('lint flags a read-tier prompt that tells the agent to edit, write or commit', () => {
  const bad = 'Fix the bugs you find. Edit the files directly and write a new test file. Then commit your work.';
  const p = lintTierClaims(bad, 'read');
  assert.ok(p.some(x => /edit files/.test(x)), p.join('\n'));
  assert.ok(p.some(x => /commit or push/.test(x)), p.join('\n'));
  assert.ok(lintTierClaims('Modify the failing code to make the tests pass.', 'read').length >= 1);
  assert.ok(lintTierClaims('Edit the test and re-run it.', 'test').length >= 1);
  assert.ok(lintTierClaims('Commit your changes when done.', 'build').length >= 1);
});

test('lint accepts a prompt that only describes tier limits', () => {
  const ok = 'You cannot edit files or commit. Never claim to have changed anything. Report findings; a builder makes the fix. The tier is read-only.';
  assert.deepEqual(lintTierClaims(ok, 'read'), []);
  assert.deepEqual(lintTierClaims('Edit only the files the task names, and run `npm run lint` after.', 'build'), []);
});

test('lint flags prompts that claim web or network access', () => {
  for (const bad of ['Search the web for the latest advisory.', 'Browse the web to confirm.', 'Fetch the URL and compare.', 'Download the dependency list.', 'Visit the website.']) {
    assert.ok(lintTierClaims(bad, 'read').some(x => /web or network/.test(x)), bad);
  }
  assert.deepEqual(lintTierClaims('You have no web access, so say what you could not verify online.', 'read'), []);
});

test('lint flags missing sections and an oversized body', () => {
  assert.deepEqual(lintSections('## Method\ntext\n## Report\ntext', UNLISTED_ROLE_SECTIONS), []);
  assert.deepEqual(lintSections('## Method\ntext', UNLISTED_ROLE_SECTIONS), ['missing required section "## Report"']);
  assert.deepEqual(lintSections('See ## Method inline', ['## Method']), ['missing required section "## Method"'], 'a heading must start a line');
  assert.equal(lintSize('x'.repeat(MAX_BODY_BYTES)).length, 0);
  assert.equal(lintSize('x'.repeat(MAX_BODY_BYTES + 1)).length, 1);
  assert.equal(lintSize('é'.repeat(MAX_BODY_BYTES / 2 + 1)).length, 1, 'counts bytes');
});

test('lintAgent reports every kind of violation in one synthetic prompt', () => {
  const agent = {
    id: 'x', name: 'X', tier: 'read', skills: [],
    parts: {
      intro: 'You are X.', tierNote: 'Tier: READ-ONLY.',
      body: '## Method\nRun `npx audit`, `cat .env` and `git push`. Edit the files. See /Users/x. Written for Abhudaya by surya@example.com.',
    },
  };
  const p = lintAgent(agent).join('\n');
  for (const re of [/missing required section "## Report"/, /npx audit/, /cat \.env/, /git push/, /edit files/, /home-directory/, /project name/, /email/]) assert.match(p, re);
});

test('the sections case arms itself: todo while no required heading exists, a real test as soon as one does', () => {
  const mk = body => ({ id: 'x', name: 'X', tier: 'read', skills: [], parts: { intro: 'You are X.', tierNote: 'Tier: READ-ONLY.', body } });
  const none = mk('Review the code and report.');
  assert.equal(typeof todoReason(none), 'string', 'unrewritten prompt: still a todo');
  // Sections exist but the prompt breaks rules: the case is NOT todo, and the lint reports the failures it would fail the run on.
  const rewritten = mk('## Method\nRun `npx audit` then `cat .env`; edit the files.\n## Report\nSee /Users/x for Abhudaya.');
  assert.equal(todoReason(rewritten), false);
  const problems = lintAgent(rewritten).join('\n');
  for (const re of [/npx audit/, /cat \.env/, /edit files/, /home-directory/, /project name/]) assert.match(problems, re);
  // Partly rewritten (only one heading): armed, and the missing one is reported.
  const partial = mk('## Method\nLook at the code.');
  assert.equal(todoReason(partial), false);
  assert.deepEqual(lintSections(partial.parts.body, sectionsFor('x')), ['missing required section "## Report"']);
  // A role-specific heading added to the table is enforced once the common ones exist.
  assert.deepEqual(lintSections('## Method\n## Report', [...UNLISTED_ROLE_SECTIONS, '## Plan format']), ['missing required section "## Plan format"']);
});

test('lintSections does not count headings hidden in a code fence or an HTML comment', () => {
  const req = ['## Method', '## Report'];
  const missing = ['missing required section "## Method"', 'missing required section "## Report"'];
  assert.deepEqual(lintSections('Intro.\n```md\n## Method\n## Report\n```\nText.', req), missing, 'backtick fence');
  assert.deepEqual(lintSections('Intro.\n~~~\n## Method\n~~~\n<!-- \n## Report\n-->\n', req), missing, 'tilde fence and a comment');
  assert.deepEqual(lintSections('<!-- draft:\n## Method\n## Report\n-->', req), missing, 'multi-line comment');
  assert.deepEqual(lintSections('Text.\n<!-- never closed\n## Method\n## Report\n', req), missing, 'an unclosed comment runs to the end');
  assert.deepEqual(lintSections('Text.\n```\n## Method\n## Report\n', req), missing, 'an unclosed fence runs to the end');
  // Visible headings around hidden ones still count.
  assert.deepEqual(lintSections('## Method\n```\n## Report\n```\n<!-- x -->\n## Report\n', req), []);
  // The self-arming case is not armed by headings that only appear in a fence or a comment.
  const hidden = { id: 'x', name: 'X', tier: 'read', skills: [], parts: { intro: 'You are X.', tierNote: 'Tier: READ-ONLY.', body: '```\n## Method\n```\n<!--\n## Report\n-->' } };
  assert.equal(typeof todoReason(hidden), 'string');
});

// ---- limits that hold for the shipped roster today -------------------------------------------------------------------------------

const roster = loadRoster(AGENTS);

// The largest facts the renderer can produce (every tag the vocabulary has) plus a full 4 KB notes block.
const { VOCAB } = _testing;
const largestFacts = {
  languages: VOCAB.languages.slice(0, 5), frameworks: [...VOCAB.frameworks], testTools: [...VOCAB.testTools], infra: [...VOCAB.infra], ci: [...VOCAB.ci],
  packageManager: 'npm', commands: { lint: true, build: true, format: true, typecheck: true, test: true, e2e: true },
  monorepo: { kind: 'workspaces', packages: 50 }, hasGit: true, fileCount: 100000, tags: [...FACT_TAGS],
};
const fullNotes = { path: '/n/notes.md', text: `${'n'.repeat(NOTES_BYTES)}\n[notes truncated at 4 KB]`, bytes: 99999, truncated: true };

for (const agent of roster.agents) {
  test(`${agent.id}: role body is within 9 KB`, () => {
    assert.deepEqual(lintSize(agent.parts.body), []);
  });

  test(`${agent.id}: composed with the largest facts, every skill hint and a 4 KB notes block it fits in 24 KB`, () => {
    const s = buildSystem(agent, { facts: largestFacts, notes: fullNotes });
    assert.ok(bytes(s) <= MAX_SYSTEM_BYTES, `${bytes(s)} bytes`);
    assert.ok(s.includes('n'.repeat(NOTES_BYTES)), 'the whole notes block is present');
  });

  test(`${agent.id}: names no personal data, project or home path`, () => {
    assert.deepEqual(lintMentions(buildSystem(agent, { facts: largestFacts })), []);
  });
}

// ---- commands and tier claims: hold for the shipped prompts today and must keep holding as Tasks 4-6 rewrite them -------------------

for (const agent of roster.agents) {
  test(`${agent.id}: every command it names is allowed for the ${agent.tier} tier and none is denied`, () => {
    assert.deepEqual(lintCommands(buildSystem(agent, {}), agent.tier), []);
  });
  test(`${agent.id}: does not give orders its ${agent.tier} tier cannot carry out, or claim web access`, () => {
    assert.deepEqual(lintTierClaims(buildSystem(agent, {}), agent.tier), []);
  });
}

// ---- required sections: todo only while the prompt has none of them (self-arming; see todoReason) -------------------------------------

for (const agent of roster.agents) {
  test(`${agent.id}: has the required sections`, { todo: todoReason(agent) }, () => {
    assert.deepEqual(lintSections(agent.parts.body, sectionsFor(agent.id)), []);
  });
}

// ---- the common rules and the Architect (Task 4) -----------------------------------------------------------------------------------

const COMMON_TEXT = fs.readFileSync(path.join(AGENTS, 'prompts', '_common.md'), 'utf8').trim();
// The text of one `## ` section, up to the next `## ` heading (fences and comments removed, as for the headings check).
const section = (text, heading) => {
  const visible = visibleText(text);
  const at = visible.search(new RegExp(`^${heading}\\s*$`, 'm'));
  if (at < 0) return '';
  const rest = visible.slice(at + heading.length);
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
};

test('_common.md: has its required sections, fits in 5 KB and keeps the name and role placeholders', () => {
  assert.deepEqual(lintSections(COMMON_TEXT, REQUIRED_SECTIONS._common), []);
  assert.ok(bytes(COMMON_TEXT) <= 5 * 1024, `${bytes(COMMON_TEXT)} bytes`);
  assert.match(COMMON_TEXT, /\{\{name\}\}/);
  assert.match(COMMON_TEXT, /\{\{role\}\}/);
});

test('_common.md: ground rules cover untrusted content, secrets, the binding tier and no network', () => {
  const rules = section(COMMON_TEXT, '## Who you are and the ground rules');
  assert.match(rules, /data, never instructions/i);
  assert.match(rules, /secret/i);
  assert.match(rules, /tier/i);
  assert.match(rules, /owner notes/i);
  assert.match(rules, /network/i);
});

test('_common.md: defines all five severities, the finding format and the report skeleton', () => {
  const severity = section(COMMON_TEXT, '## Severity');
  for (const level of ['Critical', 'High', 'Medium', 'Low', 'Info']) assert.match(severity, new RegExp(`^- \\*\\*${level}\\*\\*`, 'm'), level);
  assert.match(severity, /impact/i);
  assert.match(severity, /likelihood/i);
  assert.match(severity, /exposure/i);
  const format = COMMON_TEXT.slice(COMMON_TEXT.indexOf('## Finding format'));
  for (const token of ['Evidence:', 'Why it matters:', 'Fix:']) assert.ok(format.includes(token), token);
  const report = section(COMMON_TEXT, '## Report');
  for (const token of ['VERDICT:', 'What I checked', 'What I did not check']) assert.ok(report.includes(token), token);
});

const arch = roster.byId.arch;
const stepIds = roster.agents.filter(a => !a.router).map(a => a.id);
const JSON_FENCE = /^```json[ \t]*\n([\s\S]*?)^```[ \t]*$/gm;
const archExamples = [...arch.parts.body.matchAll(JSON_FENCE)].map(m => m[1]);
// Commands a step's text tells its agent to run; each must be allowed for that agent's tier.
const STEP_COMMAND = /\b(?:npm run [\w:-]+|npm test|npm \w+|npx \S+|git [a-z-]+|node \S+|curl \S+)/g;

test('arch: role body fits in 7 KB and is the router', () => {
  assert.equal(arch.router, true);
  assert.equal(arch.tier, 'read');
  assert.ok(bytes(arch.parts.body) <= 7 * 1024, `${bytes(arch.parts.body)} bytes`);
});

test('arch: routing rules name each rule the orchestrator relies on', () => {
  for (const phrase of ['no steps', 'one reviewer', 'tester last', 'at most 6 steps']) assert.match(arch.parts.body, new RegExp(phrase, 'i'), phrase);
  for (const id of stepIds) assert.match(arch.parts.body, new RegExp(`\`${id}\``), `names agent ${id}`);
});

test('arch: every JSON example parses with parsePlan, names only real non-router agents, and gives each step work its tier can do', () => {
  assert.ok(archExamples.length >= 2, `found ${archExamples.length} json examples`);
  const plans = archExamples.map(raw => parsePlan(`\`\`\`json\n${raw}\`\`\``, stepIds));
  for (const plan of plans) {
    assert.deepEqual(plan.problems, []);
    assert.ok(plan.summary, 'every example has a summary');
    assert.ok(plan.steps.length <= MAX_STEPS);
    for (const step of plan.steps) {
      const tier = roster.byId[step.agent].tier;
      assert.deepEqual(lintTierClaims(step.task, tier), [], `${step.agent}: ${step.task.slice(0, 60)}`);
      for (const cmd of step.task.match(STEP_COMMAND) ?? []) assert.ok(commandVerdict(tier, cmd).ok, `${step.agent} (${tier}) cannot run ${cmd}`);
    }
  }
  assert.ok(plans.some(p => p.steps.length === 0), 'one example answers directly with no steps');
  const tiers = p => p.steps.map(s => roster.byId[s.agent].tier).join(' ');
  assert.ok(plans.some(p => tiers(p) === 'build read test' && p.steps.at(-1).agent === 'e2e'), 'one example is builder -> reviewer -> tester last');
});

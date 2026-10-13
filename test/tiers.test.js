import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeArgs, denyRules, TIERS, BASH_SANDBOX_SETTINGS } from '../server/tiers.js';

// values following a variadic flag, up to the next --flag
function valuesOf(args, flag) {
  const i = args.indexOf(flag);
  if (i < 0) return null;
  const out = [];
  for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) out.push(args[j]);
  return out;
}
const args = (tier, extra = {}) => buildClaudeArgs({ agent: { tier }, system: 'SYS', ...extra });

const WRITE_PROTECTED = ['**/.env*', '~/.ssh/**', '~/.aws/**', '~/.zshrc', '~/.bashrc', '~/.profile', '~/.zprofile',
  '~/.claude/**', '**/.git/**', '.git', '**/.git', '**/node_modules/**', '**/.claude/**', '**/.mcp.json'];

test('every tier runs headless, streaming, in dontAsk mode', () => {
  for (const tier of Object.keys(TIERS)) {
    const a = args(tier);
    assert.equal(a[0], '-p');
    assert.deepEqual(valuesOf(a, '--output-format'), ['stream-json']);
    assert.deepEqual(valuesOf(a, '--permission-mode'), ['dontAsk']);
    assert.ok(a.includes('--no-session-persistence'));
    assert.equal(a[a.indexOf('--append-system-prompt') + 1], 'SYS');
  }
});

test('every tier loads ONLY the owner user settings, so an untrusted target repo cannot inject hooks/settings', () => {
  // spike: untrusted-hooks — without this, a target-repo .claude/settings.json hook fires outside the sandbox as the owner.
  for (const tier of Object.keys(TIERS)) {
    const a = args(tier);
    assert.deepEqual(valuesOf(a, '--setting-sources'), ['user'], tier);
  }
});

test('every tier exposes Bash in --tools', () => {
  for (const tier of Object.keys(TIERS)) {
    assert.ok(valuesOf(args(tier), '--tools').includes('Bash'), `${tier} is missing Bash in --tools`);
  }
});

test('read tier cannot edit or write and only runs read-only git', () => {
  const a = args('read');
  const tools = valuesOf(a, '--tools');
  assert.ok(tools.includes('Read') && tools.includes('Skill'));
  assert.ok(!tools.includes('Edit') && !tools.includes('Write'));
  const allow = valuesOf(a, '--allowedTools');
  assert.ok(allow.includes('Bash(git diff:*)'));
  assert.ok(!allow.some(r => r.includes('npm')));
  assert.ok(!allow.includes('Edit') && !allow.includes('Write'));
});

test('build tier can edit and write inside the working directory and run lint/build scripts', () => {
  const a = args('build');
  assert.ok(valuesOf(a, '--tools').includes('Edit') && valuesOf(a, '--tools').includes('Write'));
  const allow = valuesOf(a, '--allowedTools');
  assert.ok(allow.includes('Edit(./**)'));
  assert.ok(allow.includes('Bash(npm run lint:*)'));
  assert.ok(!allow.includes('Bash(npm test:*)'));
});

test('test tier runs test commands but cannot edit or write', () => {
  const a = args('test');
  const tools = valuesOf(a, '--tools');
  const allow = valuesOf(a, '--allowedTools');
  assert.ok(!tools.includes('Edit') && !tools.includes('Write'));
  assert.ok(!allow.includes('Edit') && !allow.includes('Write'));
  assert.ok(allow.includes('Bash(npm test:*)'));
  assert.ok(allow.includes('Bash(npm run e2e:*)'));
  assert.ok(!allow.includes('Bash(npx playwright test:*)'));
});

test('every tier denies pushes, deploys, cloud CLI and secret files', () => {
  const rules = denyRules();
  for (const r of ['Bash(git push:*)', 'Bash(terraform apply:*)', 'Bash(cdk deploy:*)', 'Bash(aws:*)', 'Bash(sudo:*)',
    'Read(**/.env*)', 'Read(~/.aws/**)', 'Read(~/.ssh/**)']) {
    assert.ok(rules.includes(r), `missing deny rule ${r}`);
  }
  for (const tier of Object.keys(TIERS)) {
    const deny = valuesOf(args(tier), '--disallowedTools');
    assert.deepEqual(deny, rules);
  }
});

test('secret reads use the broad .env* pattern and no longer the narrow ones', () => {
  const rules = denyRules();
  assert.ok(rules.includes('Read(**/.env*)'));
  assert.ok(!rules.includes('Read(**/.env)'));
  assert.ok(!rules.includes('Read(**/.env.*)'));
});

test('denyRules blocks Edit and Write on secrets, shell rc files, claude config and git internals', () => {
  const rules = denyRules();
  for (const p of WRITE_PROTECTED) {
    assert.ok(rules.includes(`Edit(${p})`), `missing Edit(${p})`);
    assert.ok(rules.includes(`Write(${p})`), `missing Write(${p})`);
  }
  for (const r of ['Edit(**/.git/**)', 'Write(**/.git/**)', 'Edit(~/.ssh/**)', 'Write(~/.ssh/**)']) {
    assert.ok(rules.includes(r), `missing ${r}`);
  }
});

test('denyRules does not blanket-deny home, since worktrees live under ~/.floorhands', () => {
  const rules = denyRules();
  assert.ok(!rules.includes('Edit(~/**)') && !rules.includes('Write(~/**)'));
});

test('denyRules blocks the widened git, network, shell and exec prefixes', () => {
  const rules = denyRules();
  const prefixes = ['git -C', 'git -c', 'git --', 'git diff --no-index', 'git pull', 'git fetch', 'git restore',
    'git apply', 'git am', 'git cherry-pick', 'git revert', 'git rm', 'git mv', 'git update-ref', 'git submodule',
    'git lfs', 'git gc', 'curl', 'wget', 'cat', 'head', 'tail', 'less', 'mv', 'cp', 'tee', 'chmod', 'chown', 'ln',
    'dd', 'npm publish', 'npm install', 'npm ci', 'npx', 'node', 'sh', 'bash', 'zsh', 'python', 'python3', 'perl',
    'ruby', 'eval', 'xargs', 'env', 'nc', 'ncat', 'telnet', 'open'];
  for (const p of prefixes) {
    assert.ok(rules.includes(`Bash(${p}:*)`), `missing Bash(${p}:*)`);
  }
});

test('no allow rule in any tier is also a deny rule', () => {
  const deny = new Set(denyRules());
  for (const [name, tier] of Object.entries(TIERS)) {
    for (const r of tier.allow) {
      assert.ok(!deny.has(r), `${name} allows a denied rule: ${r}`);
    }
  }
});

test('an unknown tier throws, including inherited object keys', () => {
  for (const t of ['god', 'constructor', '__proto__', 'toString']) {
    assert.throws(() => args(t), { message: `unknown tier "${t}"` });
  }
});

test('system must be a non-empty string', () => {
  for (const s of ['', '   ', undefined, null, 42, {}]) {
    assert.throws(() => buildClaudeArgs({ agent: { tier: 'read' }, system: s }), /system prompt must be a non-empty string/);
  }
});

test('--model is passed through only when given', () => {
  assert.ok(!args('read').includes('--model'));
  assert.ok(!args('read', { model: undefined }).includes('--model'));
  assert.deepEqual(valuesOf(args('read', { model: 'sonnet' }), '--model'), ['sonnet']);
});

test('TIERS is deeply frozen', () => {
  assert.ok(Object.isFrozen(TIERS));
  for (const tier of Object.values(TIERS)) {
    assert.ok(Object.isFrozen(tier));
    assert.ok(Object.isFrozen(tier.tools));
    assert.ok(Object.isFrozen(tier.allow));
  }
  assert.throws(() => TIERS.read.allow.push('Bash(rm:*)'), TypeError);
  assert.throws(() => { TIERS.read.allow = []; }, TypeError);
});

test('the .git pointer file itself, node_modules, project .claude and .mcp.json are write-protected', () => {
  const rules = denyRules();
  for (const p of ['.git', '**/.git', '**/node_modules/**', '**/.claude/**', '**/.mcp.json']) {
    for (const verb of ['Edit', 'Write']) {
      assert.equal(rules.filter(r => r === `${verb}(${p})`).length, 1, `${verb}(${p}) must appear exactly once`);
    }
  }
});

const WILDCARD_DENIES = ['Bash(git * --output*)', 'Bash(git * --no-index*)', 'Bash(git * --ext-diff*)', 'Bash(git * --textconv*)'];

test('mid-position git flag denies are present exactly once, in every tier', () => {
  const rules = denyRules();
  for (const r of WILDCARD_DENIES) {
    assert.equal(rules.filter(x => x === r).length, 1, `${r} must appear exactly once in denyRules()`);
    for (const tier of Object.keys(TIERS)) {
      assert.equal(valuesOf(args(tier), '--disallowedTools').filter(x => x === r).length, 1, `${r} missing for ${tier}`);
    }
  }
});

test('no allow rule can match the flags the wildcard denies exist for', () => {
  for (const [name, tier] of Object.entries(TIERS)) {
    for (const r of tier.allow) {
      for (const flag of ['--output', '--no-index', '--ext-diff', '--textconv']) {
        assert.ok(!r.includes(flag), `${name} allow rule ${r} mentions ${flag}`);
      }
    }
  }
});

test('agents never inherit the owner MCP servers: --strict-mcp-config for every tier, no --mcp-config', () => {
  for (const tier of Object.keys(TIERS)) {
    const a = args(tier);
    assert.equal(a.filter(x => x === '--strict-mcp-config').length, 1, tier);
    assert.ok(!a.includes('--mcp-config'), tier);
  }
});

test('no tier allows Edit or Write without a path: the real CLI then writes outside the working directory', () => {
  for (const [name, tier] of Object.entries(TIERS)) {
    for (const r of tier.allow) {
      assert.ok(r !== 'Edit' && r !== 'Write' && !r.startsWith('Write('), `${name} allows ${r}`);
      if (r.startsWith('Edit(')) assert.equal(r, 'Edit(./**)', `${name} Edit allow must be scoped to the working directory`);
    }
  }
});

test('grep-like commands are denied for every tier (they read .env without naming it)', () => {
  const rules = denyRules();
  for (const p of ['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'git grep']) {
    assert.ok(rules.includes(`Bash(${p}:*)`), `missing Bash(${p}:*)`);
  }
  for (const tier of Object.values(TIERS)) assert.ok(tier.tools.includes('Grep'), 'the Grep tool replaces Bash grep');
});

test('build and test tiers run Bash in the sandbox; the read tier does not pass --settings', () => {
  for (const tier of ['build', 'test']) {
    const a = args(tier);
    assert.equal(a.filter(x => x === '--settings').length, 1, tier);
    assert.deepEqual(JSON.parse(valuesOf(a, '--settings')[0]), BASH_SANDBOX_SETTINGS);
  }
  assert.ok(!args('read').includes('--settings'));
});

test('the sandbox settings fail closed', () => {
  const s = BASH_SANDBOX_SETTINGS.sandbox;
  assert.equal(s.enabled, true);
  assert.equal(s.autoAllowBashIfSandboxed, false, 'auto-allow would let any sandboxed command bypass the tier allow list');
  assert.equal(s.allowUnsandboxedCommands, false);
  assert.equal(s.failIfUnavailable, true);
  assert.deepEqual(s.network.allowedDomains, []);
  assert.equal(s.network.strictAllowlist, true);
  assert.ok(!('excludedCommands' in s), 'excludedCommands must never be set (it runs commands outside the sandbox)');
  assert.ok(Object.isFrozen(BASH_SANDBOX_SETTINGS) && Object.isFrozen(s.network));
});

test('the sandbox blocks reads of home credential paths (it does not by default)', () => {
  // spike: cred-sandbox-denied — a sandboxed `npm run` script can read ~/.npmrc etc. unless denyRead lists them.
  const deny = BASH_SANDBOX_SETTINGS.sandbox.filesystem.denyRead;
  for (const p of ['~/.aws', '~/.ssh', '~/.config/gh', '~/.npmrc', '~/.netrc', '~/.git-credentials',
    '~/.docker/config.json', '~/.kube', '~/.gnupg', '~/.azure', '~/.pypirc', '~/.gem/credentials', '~/.password-store',
    '~/.claude', '~/Library/Keychains']) {
    assert.ok(deny.includes(p), `sandbox denyRead missing ${p}`);
  }
  assert.ok(Object.isFrozen(BASH_SANDBOX_SETTINGS.sandbox.filesystem));
});

test('sandbox denyRead entries are home-anchored or absolute, never unprefixed relative globs', () => {
  // spike: sandbox-read-env (info) — `**/.env*` resolved relative to the settings source, not the worktree, and blocked nothing.
  for (const p of BASH_SANDBOX_SETTINGS.sandbox.filesystem.denyRead) {
    assert.ok(p.startsWith('~/') || p.startsWith('/'), `${p} is not anchored`);
    assert.ok(!p.startsWith('/**'), `${p} would expand across the whole filesystem on Linux`);
  }
});

test('read deny rules cover home-directory credential stores (read tier has no sandbox)', () => {
  // spike: cred-read-tier — a read agent could otherwise Read ~/.npmrc, ~/.config/gh, etc. directly.
  const rules = denyRules();
  for (const p of ['~/.config/gh/**', '~/.config/gcloud/**', '~/.npmrc', '~/.netrc', '~/.docker/config.json', '~/.kube/**',
    '~/.git-credentials', '~/.gnupg/**', '~/.azure/**', '~/.pypirc', '~/.gem/credentials', '~/.cargo/credentials*',
    '~/.password-store/**', '~/.claude/**', '~/Library/Keychains/**']) {
    assert.ok(rules.includes(`Read(${p})`), `missing Read deny for ${p}`);
  }
});

test('every read-only shell reader is denied in every tier (DENIED_SHELL_READERS), including git blob plumbing', () => {
  // spike: shell-readers, git-committed-secret — the Read/Grep tools cover reading files and honour the deny rules; these do not.
  const rules = denyRules();
  for (const p of ['cat', 'head', 'tail', 'less', 'more', 'nl', 'od', 'xxd', 'hexdump', 'base64', 'strings', 'sort', 'uniq',
    'cut', 'paste', 'fold', 'rev', 'tac', 'tr', 'column', 'awk', 'gawk', 'sed', 'diff', 'tee', 'grep', 'egrep', 'fgrep',
    'rg', 'ag', 'ack', 'git grep', 'git cat-file']) {
    assert.ok(rules.includes(`Bash(${p}:*)`), `missing Bash(${p}:*)`);
    for (const tier of Object.keys(TIERS)) {
      assert.ok(valuesOf(args(tier), '--disallowedTools').includes(`Bash(${p}:*)`), `${p} not denied for ${tier}`);
    }
  }
});

test('no rule pretends to block committed-blob reads: the ineffective git show *:* deny is gone, plain git show stays allowed', () => {
  // spike: git-committed-secret-denied — `Bash(git show *:*)` did not match `git show HEAD:.env`; committed secrets are a known limit.
  assert.ok(!denyRules().includes('Bash(git show *:*)'));
  assert.ok(denyRules().includes('Bash(git cat-file:*)'));
  assert.ok(valuesOf(args('read'), '--allowedTools').includes('Bash(git show:*)'));
});

test('--settings never lands inside a variadic list', () => {
  for (const tier of ['build', 'test']) {
    const a = args(tier, { model: 'sonnet' });
    const i = a.indexOf('--settings');
    assert.ok(i > a.indexOf('--append-system-prompt') + 1);
    assert.ok(!valuesOf(a, '--disallowedTools').includes('--settings'));
  }
});

// Tier → claude CLI arguments. This file is the whole safety model: if a permission changes, it changes here.
// The prompt is NOT in argv (it goes to stdin), so task text can never be parsed as a flag.
//
// Verified against the real CLI (claude 2.1.296, 2026-10-13) by scripts/spike-claude.mjs; see docs/spike-findings.md.
// Known limits (prefix rules cannot close these):
// - `npm run <script>` and `npm test` execute whatever project scripts package.json defines. For build and test tiers they run inside
//   Claude Code's Bash sandbox (BASH_SANDBOX_SETTINGS): no network, no writes outside the working directory.
// - `git diff`, `git log` and `git show` may run repo-configured diff.external / textconv programs.
// - Read deny rules cover the file tools and the file commands the CLI recognises; a command that reads files without naming them
//   (`grep -r`) is not covered, which is why grep-like commands are denied outright. The sandbox does not block reads inside the repo.

const FILE_READ = ['Read', 'Glob', 'Grep', 'Skill'];
const READ_TOOLS = [...FILE_READ, 'Bash'];

const GIT_READ = ['git diff', 'git log', 'git show', 'git status', 'git blame', 'git ls-files', 'git rev-parse'];
const BUILD_CMDS = ['npm run lint', 'npm run build', 'npm run format', 'npm run typecheck'];
const TEST_CMDS = ['npm test', 'npm run test', 'npm run e2e'];

// Read-only shell commands that can print a file's contents (or that search files without naming them). The Read/Grep/Glob tools
// already cover reading files and honour the Read deny rules, so none of these are needed. Under `dontAsk` the CLI already denies any
// Bash command without an allow rule (spike: shell-readers — every one below was denied on the read and test tiers), but a broad
// `allow: ["Bash"]` in the OWNER's own settings would re-enable them, and the grep family is auto-allowed even under `dontAsk`
// (spike round 1: `grep -rn ZEBRA .` leaked .env). Deny beats allow, so this one list closes both holes structurally.
const DENIED_SHELL_READERS = [
  'cat', 'head', 'tail', 'less', 'more', 'nl', 'od', 'xxd', 'hexdump', 'base64', 'base32', 'strings',
  'sort', 'uniq', 'cut', 'paste', 'join', 'comm', 'fold', 'fmt', 'expand', 'unexpand', 'rev', 'tac', 'tr',
  'column', 'pr', 'split', 'csplit', 'look', 'ul', 'awk', 'gawk', 'sed', 'diff', 'sdiff', 'cmp', 'tee',
  // Recursive/searching readers that do not name the file they read (so Read deny rules never apply). The Grep tool replaces them.
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'git grep',
  // Prints a blob by path, bypassing the Read deny on .env/*.pem (spike: git-committed-secret-denied: denied).
  // Known limit: a secret the repository has COMMITTED stays readable through the allowed git reads (`git show HEAD:.env` printed
  // it; `git show <commit>`, `git log -p` and `git diff` print committed contents too), so no name-based rule can close it.
  'git cat-file',
];

// Denied for every tier. Deny beats allow, so a permissive rule in the owner's own Claude settings cannot widen these.
const NEVER = [
  'git push', 'git remote', 'git config', 'git reset', 'git clean', 'git checkout', 'git switch', 'git rebase',
  'git merge', 'git commit', 'git add', 'git stash', 'git worktree', 'git branch', 'git tag',
  'git diff --output', 'git log --output', 'git show --output', // these flags write files
  'git -C', 'git -c', 'git --', 'git diff --no-index', 'git pull', 'git fetch', 'git restore', 'git apply', 'git am',
  'git cherry-pick', 'git revert', 'git rm', 'git mv', 'git update-ref', 'git submodule', 'git lfs', 'git gc',
  'rm', 'sudo', 'ssh', 'scp', 'aws', 'kubectl', 'docker',
  'curl', 'wget', 'nc', 'ncat', 'telnet', 'open',
  'mv', 'cp', 'chmod', 'chown', 'ln', 'dd',
  'terraform apply', 'terraform destroy', 'cdk deploy', 'cdk destroy',
  'npm publish', 'npm install', 'npm ci', 'npx',
  'node', 'sh', 'bash', 'zsh', 'python', 'python3', 'perl', 'ruby', 'eval', 'xargs', 'env',
  ...DENIED_SHELL_READERS,
];
// Flags that write files or read outside the repo, denied wherever they appear in a git command line. The prefix rules above only
// catch them as the first argument. These use a mid-position wildcard; if the real CLI ignores that form they do nothing (and cost nothing).
// (A `git show *:*` rule was tried for `git show HEAD:.env` and did not match: spike git-committed-secret-denied printed the secret.)
const GIT_FLAG_DENIES = ['git * --output*', 'git * --no-index*', 'git * --ext-diff*', 'git * --textconv*'];
// Secret files the Read/Edit tools must never touch. The Bash sandbox has its own read-deny list (SANDBOX_READ_DENY) for build/test.
const SECRET_READS = ['**/.env*', '**/*.pem',
  // Home-directory credential stores that are not otherwise denied. A read agent (no sandbox) could Read these directly; add them so
  // the Read tool refuses (spike: cred-read-tier-denied, run with the same rules re-expressed for a throwaway fake home).
  '~/.aws/**', '~/.ssh/**', '~/.config/gh/**', '~/.config/gcloud/**', '~/.npmrc', '~/.netrc', '~/.docker/config.json',
  '~/.kube/**', '~/.git-credentials', '~/.gnupg/**', '~/.azure/**', '~/.pypirc', '~/.gem/credentials', '~/.cargo/credentials*',
  '~/.password-store/**', '~/.claude/**', '~/Library/Keychains/**'];
const WRITE_PROTECTED = ['**/.env*', '~/.ssh/**', '~/.aws/**', '~/.zshrc', '~/.bashrc', '~/.profile', '~/.zprofile',
  '~/.claude/**', '**/.git/**',
  '.git', '**/.git', // the worktree's .git is a pointer FILE; rewriting it would aim git at the owner's repository
  '**/node_modules/**', '**/.claude/**', '**/.mcp.json']; // deliberately not '~/**': worktrees live under ~/.floorhands

const bash = prefix => `Bash(${prefix}:*)`;

function deepFreeze(obj) {
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') deepFreeze(v);
  }
  return Object.freeze(obj);
}

// Edits and writes are allowed only under the working directory (the worktree). A bare `Edit`/`Write` allow let the real CLI write an
// absolute path outside it (spike: build-write-outside). The CLI checks Write against Edit path rules, so one scoped Edit rule covers both.
const EDIT_IN_WORKDIR = 'Edit(./**)';

// Claude Code's own Bash sandbox (OS-enforced), passed per run with --settings for the tiers that execute project scripts.
// Sandboxed commands still go through the permission rules (no auto-allow), can never be retried unsandboxed, a run refuses to start
// when the sandbox is unavailable, and no network host is reachable. Verified: network blocked (fetch and curl), writes outside the
// working directory blocked, git and npm run still work.
// The sandbox does NOT block reads by default (docs: "Reads — most of the machine, including credential files such as ~/.ssh").
// A sandboxed `npm run` script could therefore read ~/.npmrc, ~/.aws/credentials, etc. These denyRead entries close that (spike:
// cred-sandbox-denied: the script's read of a denied credential file failed with EPERM). Sandbox paths: `~/x` = home, `/x` = absolute.
// Deliberately NOT here: `**/.env*` / `**/*.pem`. An unprefixed sandbox path resolves relative to the settings source, not the
// worktree, so such an entry did nothing (spike: sandbox-read-env (info) — the script still read .env), and a root-anchored
// `/**/.env*` would make Linux expand it across the whole filesystem. Known limit: sandboxed scripts can read the worktree's own
// .env, which in a fresh worktree exists only if the repository committed it.
const SANDBOX_READ_DENY = [
  '~/.aws', '~/.ssh', '~/.config/gh', '~/.config/gcloud', '~/.npmrc', '~/.netrc', '~/.docker/config.json',
  '~/.kube', '~/.git-credentials', '~/.gnupg', '~/.azure', '~/.pypirc', '~/.gem/credentials', '~/.password-store',
  '~/.claude', '~/Library/Keychains'];

export const BASH_SANDBOX_SETTINGS = deepFreeze({
  sandbox: {
    enabled: true,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: false,
    failIfUnavailable: true,
    network: { allowedDomains: [], strictAllowlist: true },
    filesystem: { denyRead: [...SANDBOX_READ_DENY] },
  },
});

export const TIERS = deepFreeze({
  read: { tools: READ_TOOLS, allow: [...FILE_READ, ...GIT_READ.map(bash)], sandbox: false },
  build: { tools: [...READ_TOOLS, 'Edit', 'Write'], allow: [...FILE_READ, EDIT_IN_WORKDIR, ...GIT_READ.map(bash), ...BUILD_CMDS.map(bash)], sandbox: true },
  test: { tools: READ_TOOLS, allow: [...FILE_READ, ...GIT_READ.map(bash), ...TEST_CMDS.map(bash)], sandbox: true },
});

export function denyRules() {
  return [
    ...NEVER.map(bash),
    ...GIT_FLAG_DENIES.map(p => `Bash(${p})`),
    ...SECRET_READS.map(p => `Read(${p})`),
    // The CLI consults Edit(path) rules for BOTH the Edit and Write tools; it never consults a Write(path) rule (verified round 1:
    // build-write-env/-node-modules/-git-file are all stopped by the Edit(...) deny). The Write(...) entries below are therefore inert.
    // They are kept only as documentation of intent and cost nothing; the real protection is the Edit(...) deny on the same path.
    ...WRITE_PROTECTED.flatMap(p => [`Edit(${p})`, `Write(${p})`]),
  ];
}

export function buildClaudeArgs({ agent, system, model }) {
  if (!agent || !Object.hasOwn(TIERS, agent.tier)) throw new Error(`unknown tier "${agent?.tier}"`);
  if (typeof system !== 'string' || system.trim() === '') {
    throw new Error('system prompt must be a non-empty string');
  }
  const tier = TIERS[agent.tier];
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
    '--permission-mode', 'dontAsk',
    // Load ONLY the owner's user-level settings. The TARGET repo is untrusted: its .claude/settings.json and .claude/settings.local.json
    // must not reach the agent. Without this, project `hooks` RUN (spike: untrusted-hooks: a SessionStart/PreToolUse hook in the target
    // repo wrote a marker outside the sandbox, as the owner) even though workspace-trust already ignores project `permissions.allow`.
    // `user` still loads the owner's enabledPlugins + synced skills, so the Skill tool keeps working (spike: untrusted-skills-resolve).
    '--setting-sources', 'user',
    '--strict-mcp-config', // no --mcp-config is ever passed, so agents get no MCP servers (not the owner's Gmail, Drive, ...)
    '--tools', ...tier.tools,
    '--allowedTools', ...tier.allow,
    '--disallowedTools', ...denyRules(),
    '--append-system-prompt', system,
  ];
  if (tier.sandbox) args.push('--settings', JSON.stringify(BASH_SANDBOX_SETTINGS));
  if (model) args.push('--model', model);
  return args;
}

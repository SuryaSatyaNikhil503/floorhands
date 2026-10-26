import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);

export async function git(cwd, args) {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 20 * 1024 * 1024 });
  return stdout;
}

// Every git call made INSIDE a floorhands worktree (whose config and .git link the agent can influence) runs with these,
// so no owner-configured or agent-planted program (fsmonitor, hooks, ssh) can run in the server process.
// approve() goes further and runs the merge with no hooks at all (see there).
export const SAFE_GIT = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.sshCommand=/bin/false'];

async function gitOk(cwd, args) {
  try { await git(cwd, args); return true; } catch { return false; }
}

export async function isGitRepo(root) {
  try { await git(root, ['rev-parse', '--verify', 'HEAD']); return true; } catch { return false; }
}

// Where floorhands keeps its own files outside any repository, and the per-project folder name derived from the root.
export const floorhandsHome = () => process.env.FLOORHANDS_HOME || path.join(os.homedir(), '.floorhands');
export const projectKey = root => crypto.createHash('sha1').update(root).digest('hex').slice(0, 10);

export function worktreeBase(root) {
  return path.join(floorhandsHome(), 'worktrees', projectKey(root));
}

export async function createWorktree(root, taskId, { base = worktreeBase(root) } = {}) {
  // The id becomes a branch name and a directory name, so it must be a plain slug.
  if (typeof taskId !== 'string' || !/^t-[a-z0-9-]+$/.test(taskId)) throw new Error('invalid task id');
  if (!(await isGitRepo(root))) {
    throw new Error('Build and test steps need this folder to be a git repository with at least one commit. Run "git init" and "git commit --allow-empty -m init" here (or start floorhands from inside a repository).');
  }
  const branch = `floorhands/${taskId}`;
  const dir = path.join(path.resolve(base), taskId);
  fs.mkdirSync(base, { recursive: true });
  const baseSha = (await git(root, [...SAFE_GIT, 'rev-parse', 'HEAD'])).trim();
  // SAFE_GIT: `worktree add` checks files out, which runs post-checkout hooks and fsmonitor from the repository's config (known limit 15).
  await git(root, [...SAFE_GIT, 'worktree', 'add', '-b', branch, '--', dir, 'HEAD']);
  const nm = path.join(root, 'node_modules');
  if (fs.existsSync(nm) && !fs.existsSync(path.join(dir, 'node_modules'))) fs.symlinkSync(nm, path.join(dir, 'node_modules'), 'dir');
  return { dir, branch, base: baseSha };
}

const TAMPERED = 'The floorhands worktree was tampered with (its git link no longer points at its own branch); nothing was committed.';

const realpath = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

// The worktree's .git is a pointer FILE an agent could rewrite to aim git at the owner's repository (or at a crafted git dir).
// Before staging anything, check that this directory still belongs to exactly its own floorhands branch.
async function assertWorktreeIntact(wt, root) {
  const taskId = String(wt?.branch ?? '').slice('floorhands/'.length);
  try {
    const head = (await git(wt.dir, [...SAFE_GIT, 'symbolic-ref', '-q', 'HEAD'])).trim();
    if (head !== `refs/heads/${wt.branch}`) throw new Error('head');
    const gitDir = realpath(path.resolve(wt.dir, (await git(wt.dir, [...SAFE_GIT, 'rev-parse', '--git-dir'])).trim()));
    if (path.basename(gitDir) !== taskId || path.basename(path.dirname(gitDir)) !== 'worktrees') throw new Error('gitdir');
    if (root) {
      const common = realpath(path.resolve(root, (await git(root, ['rev-parse', '--git-common-dir'])).trim()));
      if (path.dirname(path.dirname(gitDir)) !== common) throw new Error('outside');
    }
  } catch {
    throw new Error(TAMPERED);
  }
}

export async function commitAll(wt, message, { root } = {}) {
  await assertWorktreeIntact(wt, root);
  // Plain `add -A` skips ignored paths. An explicit pathspec naming an ignored path (e.g. the node_modules link when .gitignore says
  // `node_modules` without a trailing slash) would make git exit 1, so the link is unstaged afterwards instead of excluded up front.
  await git(wt.dir, [...SAFE_GIT, 'add', '-A']);
  await git(wt.dir, [...SAFE_GIT, 'reset', '-q', '--', 'node_modules']);
  try { await git(wt.dir, [...SAFE_GIT, 'diff', '--cached', '--quiet']); return false; } catch { /* exit 1: staged changes exist */ }
  await git(wt.dir, [...SAFE_GIT, '-c', 'user.name=floorhands', '-c', 'user.email=floorhands@localhost', '-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', message]);
  return true;
}

// Merge commits use the owner's own git identity; fall back to a floorhands identity unless both name and email are configured.
async function identityArgs(cwd) {
  try { await git(cwd, ['config', 'user.name']); await git(cwd, ['config', 'user.email']); return []; } catch { return ['-c', 'user.name=floorhands', '-c', 'user.email=floorhands@localhost']; }
}

// The base sha comes from a task file that can be hand-edited; it must be a full sha (40 hex, or 64 for a sha256 repository) so it can never be parsed as a git option.
function assertBase(wt) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(String(wt?.base ?? ''))) throw new Error('invalid worktree record');
}

// The server's own diffs never run a diff.external or textconv program from the repository's config: they show the plain change.
const PLAIN_DIFF = ['--no-ext-diff', '--no-textconv'];
export async function diff(root, wt) {
  assertBase(wt);
  return git(root, [...SAFE_GIT, 'diff', ...PLAIN_DIFF, `${wt.base}...${wt.branch}`, '--']);
}
export async function diffStat(root, wt) {
  assertBase(wt);
  return git(root, [...SAFE_GIT, 'diff', ...PLAIN_DIFF, '--stat', `${wt.base}...${wt.branch}`, '--']);
}
export async function changedFiles(root, wt) {
  assertBase(wt);
  const out = await git(root, [...SAFE_GIT, 'diff', '--name-only', '-z', `${wt.base}...${wt.branch}`, '--']);
  return out.split('\0').filter(Boolean);
}

// Changes the owner should look at twice before approving: anything that decides what runs on their machine later (package scripts,
// git hooks, CI, build config) rather than what the code does. Pure: a list of paths in, a list of { flag, path } out.
const RISKY = [
  ['package-manifest', /(^|\/)package\.json$/],
  ['lockfile', /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/],
  ['git-hooks', /(^|\/)(\.husky|\.githooks|\.git-hooks)\//],
  ['git-attributes', /(^|\/)\.gitattributes$/],
  ['ci', /^\.github\/(workflows|actions)\/|(^|\/)(\.gitlab-ci\.yml|\.circleci\/|Jenkinsfile$|azure-pipelines\.yml$)/],
  ['package-config', /(^|\/)(\.npmrc|\.yarnrc(\.yml)?|\.pnpmfile\.cjs)$/],
  ['build-config', /(^|\/)([\w.-]+\.config\.(c|m)?(j|t)s|Makefile|Dockerfile|docker-compose\.ya?ml|\.babelrc|tsconfig[\w.-]*\.json)$/],
  ['agent-config', /(^|\/)(\.claude\/|\.mcp\.json$|CLAUDE\.md$|AGENTS\.md$)/],
];
export function riskFlags(files) {
  const out = [];
  for (const f of Array.isArray(files) ? files : []) {
    for (const [flag, re] of RISKY) if (re.test(f)) { out.push({ flag, path: String(f).slice(0, 300) }); break; }
  }
  return out.slice(0, 50);
}

// Files that define HOW tests run (not what they test): package manager config and test-runner config. A builder changing one of
// these would decide what `npm test` executes, so the tester's step is skipped. Test files themselves still run, in the sandbox.
const TEST_DEFINITION = /(^|\/)(\.npmrc|\.yarnrc(\.yml)?|\.pnpmfile\.cjs|\.mocharc(\.[\w]+)?|(jest|vitest|vite|mocha|ava|playwright|cypress|karma|babel)\.config\.[\w.]+|\.babelrc(\.[\w]+)?)$/;
// Ignored files never reach the commit, so changedFiles cannot see a builder that git-ignored an .npmrc and then wrote it.
export async function ignoredFiles(wt) {
  const out = await git(wt.dir, [...SAFE_GIT, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', '.']);
  return out.split('\0').filter(f => f && !f.startsWith('node_modules'));
}
export const changesTestDefinition = files => (Array.isArray(files) ? files : []).filter(f => TEST_DEFINITION.test(String(f)));

// Whether the "scripts" of the root package.json differ between the task's base commit and the worktree. A builder can rewrite what
// `npm test` runs, so a test step after such a change would execute agent-written code: the orchestrator refuses that step.
export async function scriptsChanged(wt) {
  assertBase(wt);
  const scripts = text => {
    // Scripts plus the test-runner settings that can live inside package.json.
    try { const j = JSON.parse(text); return JSON.stringify(['scripts', 'jest', 'mocha', 'ava', 'nyc', 'c8', 'vitest', 'babel'].map(k => j?.[k] ?? null)); } catch { return 'unparseable'; }
  };
  let before;
  try { before = scripts(await git(wt.dir, [...SAFE_GIT, 'show', `${wt.base}:package.json`])); } catch { before = 'absent'; }
  let after;
  try { after = scripts(fs.readFileSync(path.join(wt.dir, 'package.json'), 'utf8')); } catch { after = 'absent'; }
  return before !== after;
}

// A wt record is read back from a task file that can be hand-edited, so it is only trusted
// when it points inside the floorhands worktree folder and names a floorhands branch.
function assertOwned(wt, base) {
  assertBase(wt);
  const dir = path.resolve(String(wt?.dir ?? ''));
  const branch = String(wt?.branch ?? '');
  const inside = dir.startsWith(path.resolve(base) + path.sep);
  // The directory must be the one createWorktree made for exactly this branch.
  if (!inside || !/^floorhands\/t-[a-z0-9-]+$/.test(branch) || dir !== path.join(path.resolve(base), branch.slice('floorhands/'.length))) {
    throw new Error('refusing to touch a worktree outside the floorhands folder');
  }
}

async function cleanup(root, wt) {
  try { // never let a recursive delete follow the node_modules link into the real project
    const nm = path.join(wt.dir, 'node_modules');
    if (fs.lstatSync(nm).isSymbolicLink()) fs.unlinkSync(nm);
  } catch { /* no link */ }
  try { await git(root, ['worktree', 'remove', '--force', '--', wt.dir]); } catch { /* already gone */ }
  try { await git(root, ['branch', '-D', '--', wt.branch]); } catch { /* already gone */ }
}

export async function approve(root, wt, message, { base = worktreeBase(root) } = {}) {
  assertOwned(wt, base);
  if (await gitOk(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) {
    throw new Error(`Your repository is in the middle of a merge. Finish or abort it, then approve again. The floorhands branch ${wt.branch} is kept.`);
  }
  if (!(await gitOk(root, ['symbolic-ref', '-q', 'HEAD']))) {
    throw new Error(`Your repository is on a detached HEAD. Check out a branch, then approve again. The floorhands branch ${wt.branch} is kept.`);
  }
  // The merge never runs hooks. They run after the merged files are in the working tree, and ordinary hooks load repository files
  // an agent may have changed (commitlint.config.js, lefthook.yml, .pre-commit-config.yaml, package.json scripts through npm install),
  // which would run agent-written code outside every sandbox. Run your hooks yourself after reviewing the merge if you need them.
  const hookArgs = ['-c', 'core.hooksPath=/dev/null'];
  try {
    await git(root, [...hookArgs, ...(await identityArgs(root)), 'merge', '--no-ff', '--no-verify', '-m', message, '--', wt.branch]);
  } catch {
    // Only abort a merge our own attempt left behind; the owner's was ruled out above.
    if (await gitOk(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) {
      try { await git(root, ['merge', '--abort']); } catch { /* best effort */ }
    }
    throw new Error(`The merge did not apply cleanly (conflicts, or uncommitted changes in your working copy). Nothing was changed; the floorhands branch is kept as ${wt.branch}.`);
  }
  let mergeSha = null;
  try { mergeSha = (await git(root, [...SAFE_GIT, 'rev-parse', 'HEAD'])).trim(); } catch { /* recorded as unknown */ }
  await cleanup(root, wt);
  return { mergeSha, hooksSkipped: true };
}


export async function reject(root, wt, { base = worktreeBase(root) } = {}) {
  assertOwned(wt, base);
  await cleanup(root, wt);
}

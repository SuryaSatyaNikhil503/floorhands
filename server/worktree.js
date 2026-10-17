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
// Not used for the merge in approve(): that runs in the owner's repo, where the owner's hooks should run.
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
  const baseSha = (await git(root, ['rev-parse', 'HEAD'])).trim();
  await git(root, ['worktree', 'add', '-b', branch, '--', dir, 'HEAD']);
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

export async function diff(root, wt) {
  assertBase(wt);
  return git(root, ['diff', `${wt.base}...${wt.branch}`, '--']);
}
export async function diffStat(root, wt) {
  assertBase(wt);
  return git(root, ['diff', '--stat', `${wt.base}...${wt.branch}`, '--']);
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
  try {
    await git(root, [...(await identityArgs(root)), 'merge', '--no-ff', '-m', message, '--', wt.branch]);
  } catch {
    // Only abort a merge our own attempt left behind; the owner's was ruled out above.
    if (await gitOk(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) {
      try { await git(root, ['merge', '--abort']); } catch { /* best effort */ }
    }
    throw new Error(`The merge did not apply cleanly (conflicts, or uncommitted changes in your working copy). Nothing was changed; the floorhands branch is kept as ${wt.branch}.`);
  }
  await cleanup(root, wt);
}

export async function reject(root, wt, { base = worktreeBase(root) } = {}) {
  assertOwned(wt, base);
  await cleanup(root, wt);
}

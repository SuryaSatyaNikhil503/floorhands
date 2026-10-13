import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { git, isGitRepo, createWorktree, commitAll, diff, diffStat, approve, reject } from '../server/worktree.js';

const sh = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' });
const made = [];
const tmp = (prefix) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); made.push(d); return d; };
after(() => {
  for (const d of made) {
    try { fs.unlinkSync(path.join(d, 'node_modules')); } catch { /* not a link */ }
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function makeRepo() {
  const root = tmp('floorhands-wt-');
  sh(root, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  sh(root, 'add', '-A');
  sh(root, 'commit', '-q', '-m', 'init');
  const base = tmp('floorhands-wtbase-');
  return { root, base };
}

test('isGitRepo is false for a plain folder and for a repo with no commits', async () => {
  const plain = tmp('floorhands-plain-');
  assert.equal(await isGitRepo(plain), false);
  const empty = tmp('floorhands-empty-');
  sh(empty, 'init', '-q', '-b', 'main');
  assert.equal(await isGitRepo(empty), false);
  assert.equal(await isGitRepo(makeRepo().root), true);
});

test('createWorktree refuses a non-repo with a message that says what to do', async () => {
  const plain = tmp('floorhands-plain-');
  await assert.rejects(createWorktree(plain, 't-1', { base: plain }), err => {
    assert.match(err.message, /git repository/);
    assert.match(err.message, /git init/);
    assert.match(err.message, /git commit --allow-empty -m init/);
    assert.doesNotMatch(err.message, /Front-End or Back-End/);
    return true;
  });
});

test('createWorktree refuses task ids that are not safe branch and directory names', async () => {
  const { root, base } = makeRepo();
  for (const bad of ['../x', 'a b', '', 't-A', 'x-1', 't-a/b', 't-1\n']) {
    await assert.rejects(createWorktree(root, bad, { base }), /invalid task id/, JSON.stringify(bad));
  }
  assert.deepEqual(fs.readdirSync(base), []);
  assert.equal(sh(root, 'branch', '--list', 'floorhands/*').trim(), '');
});

test('createWorktree makes an isolated branch with the project files', async () => {
  const { root, base } = makeRepo();
  const wt = await createWorktree(root, 't-abc', { base });
  assert.equal(wt.branch, 'floorhands/t-abc');
  assert.equal(fs.readFileSync(path.join(wt.dir, 'a.txt'), 'utf8'), 'one\n');
  assert.equal(wt.base, sh(root, 'rev-parse', 'HEAD').trim());
  assert.match(sh(root, 'branch', '--list', 'floorhands/t-abc'), /floorhands\/t-abc/);
});

test('commitAll reports whether anything changed, and never commits node_modules', async () => {
  const { root, base } = makeRepo();
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg.js'), 'x');
  const wt = await createWorktree(root, 't-1', { base });
  assert.ok(fs.lstatSync(path.join(wt.dir, 'node_modules')).isSymbolicLink());
  assert.equal(await commitAll(wt, 'nothing'), false);
  fs.writeFileSync(path.join(wt.dir, 'b.txt'), 'two\n');
  assert.equal(await commitAll(wt, 'add b'), true);
  const files = sh(wt.dir, 'ls-tree', '-r', '--name-only', 'HEAD');
  assert.match(files, /b\.txt/);
  assert.doesNotMatch(files, /node_modules/);
});

test('diff and diffStat show the branch changes against its base', async () => {
  const { root, base } = makeRepo();
  const wt = await createWorktree(root, 't-1', { base });
  fs.writeFileSync(path.join(wt.dir, 'a.txt'), 'one\ntwo\n');
  await commitAll(wt, 'edit');
  assert.match(await diff(root, wt), /\+two/);
  assert.match(await diffStat(root, wt), /a\.txt/);
});

test('approve merges the branch into the current branch and cleans up', async () => {
  const { root, base } = makeRepo();
  const wt = await createWorktree(root, 't-1', { base });
  fs.writeFileSync(path.join(wt.dir, 'b.txt'), 'two\n');
  await commitAll(wt, 'add b');
  await approve(root, wt, 'Merge floorhands work', { base });
  assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'two\n');
  assert.equal(fs.existsSync(wt.dir), false);
  assert.equal(sh(root, 'branch', '--list', 'floorhands/t-1').trim(), '');
});

test('approve refuses when it would overwrite uncommitted work, and keeps everything', async () => {
  const { root, base } = makeRepo();
  const wt = await createWorktree(root, 't-1', { base });
  fs.writeFileSync(path.join(wt.dir, 'a.txt'), 'floorhands edit\n');
  await commitAll(wt, 'edit a');
  fs.writeFileSync(path.join(root, 'a.txt'), 'my uncommitted edit\n');
  await assert.rejects(approve(root, wt, 'Merge', { base }), /did not apply cleanly/);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'my uncommitted edit\n');
  assert.ok(fs.existsSync(wt.dir));
  assert.match(sh(root, 'branch', '--list', 'floorhands/t-1'), /floorhands\/t-1/);
});

test('reject removes the worktree and branch and leaves the project alone', async () => {
  const { root, base } = makeRepo();
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg.js'), 'x');
  const wt = await createWorktree(root, 't-1', { base });
  fs.writeFileSync(path.join(wt.dir, 'b.txt'), 'two\n');
  await commitAll(wt, 'add b');
  await reject(root, wt, { base });
  assert.equal(fs.existsSync(wt.dir), false);
  assert.equal(fs.existsSync(path.join(root, 'b.txt')), false);
  assert.equal(fs.readFileSync(path.join(root, 'node_modules', 'pkg.js'), 'utf8'), 'x', 'real node_modules untouched');
  assert.equal(sh(root, 'branch', '--list', 'floorhands/t-1').trim(), '');
});

test('approve and reject refuse a forged worktree record and touch nothing', async () => {
  const { root, base } = makeRepo();
  const wt = await createWorktree(root, 't-1', { base });
  fs.writeFileSync(path.join(wt.dir, 'b.txt'), 'two\n');
  await commitAll(wt, 'add b');
  const outside = tmp('floorhands-outside-');
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  const sibling = base + '-evil'; // shares the base as a string prefix
  fs.mkdirSync(sibling); made.push(sibling);
  const forged = [
    { ...wt, dir: '/etc' },
    { ...wt, dir: outside },
    { ...wt, dir: sibling },
    { ...wt, dir: base },
    { ...wt, dir: path.join(base, '..', 'elsewhere') },
    { ...wt, branch: 'main' },
    { ...wt, branch: 'floorhands/../main' },
  ];
  const head = sh(root, 'rev-parse', 'HEAD');
  for (const bad of forged) {
    await assert.rejects(approve(root, bad, 'Merge', { base }), /outside the floorhands folder/, JSON.stringify(bad));
    await assert.rejects(reject(root, bad, { base }), /outside the floorhands folder/, JSON.stringify(bad));
  }
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
  assert.ok(fs.existsSync(sibling));
  assert.ok(fs.existsSync(wt.dir));
  assert.equal(sh(root, 'rev-parse', 'HEAD'), head, 'nothing was merged');
  assert.equal(fs.existsSync(path.join(root, 'b.txt')), false);
  assert.match(sh(root, 'branch', '--list', 'floorhands/t-1'), /floorhands\/t-1/);
  assert.match(sh(root, 'branch', '--list', 'main'), /main/);
});

const hasRef = (cwd, ref) => { try { sh(cwd, 'rev-parse', '-q', '--verify', ref); return true; } catch { return false; } };

test('approve never aborts a merge the owner started, and keeps everything', async () => {
  const { root, base } = makeRepo();
  const wt = await createWorktree(root, 't-1', { base });
  fs.writeFileSync(path.join(wt.dir, 'b.txt'), 'two\n');
  await commitAll(wt, 'add b');
  sh(root, 'checkout', '-q', '-b', 'other');
  fs.writeFileSync(path.join(root, 'a.txt'), 'other side\n');
  sh(root, 'commit', '-q', '-am', 'other edit');
  sh(root, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(root, 'a.txt'), 'main side\n');
  sh(root, 'commit', '-q', '-am', 'main edit');
  assert.throws(() => sh(root, 'merge', 'other')); // conflicts: leaves MERGE_HEAD behind
  assert.ok(hasRef(root, 'MERGE_HEAD'));
  const conflicted = fs.readFileSync(path.join(root, 'a.txt'), 'utf8');
  await assert.rejects(approve(root, wt, 'Merge', { base }), /middle of a merge.*floorhands\/t-1 is kept/);
  assert.ok(hasRef(root, 'MERGE_HEAD'), 'owner merge still in progress');
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), conflicted);
  assert.ok(fs.existsSync(wt.dir));
  assert.match(sh(root, 'branch', '--list', 'floorhands/t-1'), /floorhands\/t-1/);
});

test('approve refuses on a detached HEAD and changes nothing', async () => {
  const { root, base } = makeRepo();
  const wt = await createWorktree(root, 't-1', { base });
  fs.writeFileSync(path.join(wt.dir, 'b.txt'), 'two\n');
  await commitAll(wt, 'add b');
  sh(root, 'checkout', '-q', '--detach');
  const head = sh(root, 'rev-parse', 'HEAD');
  await assert.rejects(approve(root, wt, 'Merge', { base }), /detached HEAD.*floorhands\/t-1 is kept/);
  assert.equal(sh(root, 'rev-parse', 'HEAD'), head);
  assert.equal(fs.existsSync(path.join(root, 'b.txt')), false);
  assert.ok(fs.existsSync(wt.dir));
  assert.match(sh(root, 'branch', '--list', 'floorhands/t-1'), /floorhands\/t-1/);
});

test('approve on a committed conflict rejects, leaves the repo clean, and keeps the floorhands work', async () => {
  const { root, base } = makeRepo();
  const wt = await createWorktree(root, 't-1', { base });
  fs.writeFileSync(path.join(wt.dir, 'a.txt'), 'floorhands edit\n');
  await commitAll(wt, 'edit a');
  fs.writeFileSync(path.join(root, 'a.txt'), 'owner edit\n');
  sh(root, 'commit', '-q', '-am', 'owner edit');
  const head = sh(root, 'rev-parse', 'HEAD');
  await assert.rejects(approve(root, wt, 'Merge', { base }), /did not apply cleanly/);
  assert.equal(hasRef(root, 'MERGE_HEAD'), false);
  assert.equal(sh(root, 'rev-parse', 'HEAD'), head);
  assert.equal(sh(root, 'status', '--porcelain').trim(), '');
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'owner edit\n');
  assert.ok(fs.existsSync(wt.dir));
  assert.match(sh(root, 'branch', '--list', 'floorhands/t-1'), /floorhands\/t-1/);
});

test('a worktree record whose dir belongs to a different task than its branch is refused', async () => {
  const { root, base } = makeRepo();
  const one = await createWorktree(root, 't-1', { base });
  const two = await createWorktree(root, 't-2', { base });
  const mixed = { ...one, dir: two.dir };
  await assert.rejects(approve(root, mixed, 'Merge', { base }), /outside the floorhands folder/);
  await assert.rejects(reject(root, mixed, { base }), /outside the floorhands folder/);
  assert.ok(fs.existsSync(one.dir) && fs.existsSync(two.dir));
  assert.match(sh(root, 'branch', '--list', 'floorhands/t-2'), /floorhands\/t-2/);
});

test('createWorktree with a relative base records the absolute directory git created', async () => {
  const { root, base } = makeRepo();
  const wt = await createWorktree(root, 't-1', { base: path.relative(process.cwd(), base) });
  assert.equal(wt.dir, path.join(base, 't-1'));
  assert.ok(fs.existsSync(path.join(wt.dir, 'a.txt')));
});

test('commitAll is not blocked by the owner hooks or signing settings', async () => {
  const { root, base } = makeRepo();
  fs.writeFileSync(path.join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  sh(root, 'config', 'commit.gpgsign', 'true');
  sh(root, 'config', 'gpg.program', '/nonexistent-gpg');
  const wt = await createWorktree(root, 't-1', { base });
  fs.writeFileSync(path.join(wt.dir, 'b.txt'), 'two\n');
  assert.equal(await commitAll(wt, 'add b'), true);
});

const TAMPERED = /tampered with.*nothing was committed/;
const head = (cwd, ref = 'HEAD') => sh(cwd, 'rev-parse', ref).trim();
const indexState = root => sh(root, 'ls-files', '-s') + sh(root, 'status', '--porcelain');

test('commitAll refuses when the worktree .git pointer is aimed at the owner repository', async () => {
  const { root, base } = makeRepo();
  const wt = await createWorktree(root, 't-1', { base });
  const mainHead = head(root, 'main');
  const fhHead = head(root, 'floorhands/t-1');
  const idx = indexState(root);
  fs.writeFileSync(path.join(wt.dir, '.git'), `gitdir: ${path.join(root, '.git')}\n`);
  fs.writeFileSync(path.join(wt.dir, 'evil.txt'), 'x\n');
  await assert.rejects(commitAll(wt, 'x', { root }), TAMPERED);
  assert.equal(head(root, 'main'), mainHead, 'owner main untouched');
  assert.equal(indexState(root), idx, 'owner index untouched');
  assert.equal(head(root, 'floorhands/t-1'), fhHead, 'floorhands branch has no new commit');
});

test('commitAll refuses a pointer to a different worktree git dir', async () => {
  const { root, base } = makeRepo();
  const one = await createWorktree(root, 't-1', { base });
  const two = await createWorktree(root, 't-2', { base });
  const twoHead = head(root, 'floorhands/t-2');
  fs.writeFileSync(path.join(one.dir, '.git'), `gitdir: ${path.join(root, '.git', 'worktrees', 't-2')}\n`);
  fs.writeFileSync(path.join(one.dir, 'evil.txt'), 'x\n');
  await assert.rejects(commitAll(one, 'x', { root }), TAMPERED);
  assert.equal(head(root, 'floorhands/t-2'), twoHead);
  assert.equal(head(root, 'floorhands/t-1'), one.base);
  assert.ok(two.dir);
});

test('commitAll refuses a crafted git dir outside the owner repository when the root is known', async () => {
  const { root, base } = makeRepo();
  const wt = await createWorktree(root, 't-1', { base });
  const evil = path.join(tmp('floorhands-evil-'), 'worktrees', 't-1');
  fs.mkdirSync(path.dirname(evil), { recursive: true });
  fs.cpSync(path.join(root, '.git', 'worktrees', 't-1'), evil, { recursive: true });
  fs.writeFileSync(path.join(evil, 'commondir'), path.join(root, '.git') + '\n');
  fs.writeFileSync(path.join(wt.dir, '.git'), `gitdir: ${evil}\n`);
  fs.writeFileSync(path.join(wt.dir, 'evil.txt'), 'x\n');
  await assert.rejects(commitAll(wt, 'x', { root }), TAMPERED);
  assert.equal(head(root, 'floorhands/t-1'), wt.base);
});

test('commitAll still works normally, with and without the root', async () => {
  const { root, base } = makeRepo();
  const wt = await createWorktree(root, 't-1', { base });
  fs.writeFileSync(path.join(wt.dir, 'b.txt'), 'two\n');
  assert.equal(await commitAll(wt, 'add b', { root }), true);
  assert.equal(await commitAll(wt, 'nothing', { root }), false);
  fs.writeFileSync(path.join(wt.dir, 'c.txt'), 'three\n');
  assert.equal(await commitAll(wt, 'add c'), true);
  assert.match(sh(wt.dir, 'ls-tree', '-r', '--name-only', 'HEAD'), /c\.txt/);
  assert.equal(head(root, 'main'), wt.base);
});

test('commitAll runs none of the hooks or fsmonitor programs the owner repository configures', async () => {
  const { root, base } = makeRepo();
  const marker = tmp('floorhands-marker-');
  const hooks = tmp('floorhands-hooks-');
  for (const h of ['pre-commit', 'commit-msg', 'post-commit', 'reference-transaction', 'post-index-change', 'prepare-commit-msg']) {
    fs.writeFileSync(path.join(hooks, h), `#!/bin/sh\ntouch "${marker}/${h}"\nexit 0\n`, { mode: 0o755 });
  }
  const fsmon = path.join(hooks, 'fsmon');
  fs.writeFileSync(fsmon, `#!/bin/sh\ntouch "${marker}/fsmonitor"\nexit 0\n`, { mode: 0o755 });
  const wt = await createWorktree(root, 't-1', { base }); // runs in the owner's repo, so configure the hooks only afterwards
  sh(root, 'config', 'core.hooksPath', hooks);
  sh(root, 'config', 'core.fsmonitor', fsmon);
  fs.writeFileSync(path.join(wt.dir, 'b.txt'), 'two\n');
  assert.equal(await commitAll(wt, 'add b', { root }), true);
  assert.deepEqual(fs.readdirSync(marker), [], 'no owner-configured program ran');
});

test('diff, diffStat, approve and reject refuse a base that is not a full sha', async () => {
  const { root, base } = makeRepo();
  const wt = await createWorktree(root, 't-1', { base });
  const out = path.join(tmp('floorhands-out-'), 'pwned');
  for (const bad of ['--output=' + out, 'HEAD', wt.base.slice(0, 12), wt.base.toUpperCase(), '', undefined, wt.base + '\n']) {
    const forged = { ...wt, base: bad };
    await assert.rejects(diff(root, forged), /invalid worktree record/, JSON.stringify(bad));
    await assert.rejects(diffStat(root, forged), /invalid worktree record/, JSON.stringify(bad));
    await assert.rejects(approve(root, forged, 'm', { base }), /invalid worktree record/, JSON.stringify(bad));
    await assert.rejects(reject(root, forged, { base }), /invalid worktree record/, JSON.stringify(bad));
  }
  assert.equal(fs.existsSync(out), false);
  assert.ok(fs.existsSync(wt.dir));
});

for (const ignore of [null, 'node_modules', '/node_modules', 'node_modules/', '**/node_modules']) {
  test(`commitAll works with a real node_modules link when .gitignore is ${JSON.stringify(ignore)}`, async () => {
    const { root, base } = makeRepo();
    if (ignore !== null) {
      fs.writeFileSync(path.join(root, '.gitignore'), ignore + '\n');
      sh(root, 'add', '-A');
      sh(root, 'commit', '-q', '-m', 'ignore');
    }
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, 'node_modules', 'pkg.js'), 'x');
    const wt = await createWorktree(root, 't-1', { base });
    assert.ok(fs.lstatSync(path.join(wt.dir, 'node_modules')).isSymbolicLink());
    assert.equal(await commitAll(wt, 'nothing', { root }), false, 'nothing changed: no empty commit');
    const before = sh(wt.dir, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(wt.dir, 'a.txt'), 'changed\n');
    fs.writeFileSync(path.join(wt.dir, 'b.txt'), 'two\n');
    assert.equal(await commitAll(wt, 'real work', { root }), true);
    const files = sh(wt.dir, 'ls-tree', '-r', '--name-only', 'HEAD');
    assert.match(files, /^a\.txt$/m);
    assert.match(files, /^b\.txt$/m);
    assert.doesNotMatch(files, /node_modules/);
    assert.equal(sh(wt.dir, 'show', 'HEAD:a.txt'), 'changed\n');
    assert.notEqual(sh(wt.dir, 'rev-parse', 'HEAD'), before);
    assert.equal(fs.readFileSync(path.join(root, 'node_modules', 'pkg.js'), 'utf8'), 'x');
    assert.equal(await commitAll(wt, 'again', { root }), false, 'second run with nothing new is also a no-op');
    assert.equal(sh(wt.dir, 'diff', '--cached', '--name-only').trim(), '', 'the link is not left staged');
  });
}

test('assertBase accepts 40- and 64-hex shas and rejects every other length and non-hex', async () => {
  const { root, base } = makeRepo();
  const wt = await createWorktree(root, 't-1', { base });
  for (const ok of ['a'.repeat(40), 'f'.repeat(64), '0123456789abcdef'.repeat(4)]) {
    await assert.rejects(diffStat(root, { ...wt, base: ok }), err => !/invalid worktree record/.test(err.message), ok.length + ' hex gets past the format check');
  }
  for (const bad of ['a'.repeat(39), 'a'.repeat(41), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(40), 'g'.repeat(64), 'A'.repeat(64)]) {
    await assert.rejects(diffStat(root, { ...wt, base: bad }), /invalid worktree record/, bad.length + bad[0]);
  }
});

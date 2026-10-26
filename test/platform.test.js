import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkPlatform, onPath, isWsl1, platformCheckOff, WINDOWS, WSL1, APPARMOR } from '../server/platform.js';

const all = () => true;

test('macOS needs nothing more', () => {
  assert.deepEqual(checkPlatform({ platform: 'darwin', has: () => false }), { problems: [], warnings: [] });
});

test('native Windows is refused, pointing to WSL2 (Claude Code\'s sandbox does not run there)', () => {
  const r = checkPlatform({ platform: 'win32' });
  assert.deepEqual(r.problems, [WINDOWS]);
  assert.match(WINDOWS, /WSL2/);
  assert.match(WINDOWS, /wsl --install/);
});

test('WSL1 is refused; WSL2 and plain Linux pass when bubblewrap and socat are installed', () => {
  assert.deepEqual(checkPlatform({ platform: 'linux', release: '4.4.0-19041-Microsoft', has: all }).problems, [WSL1]);
  // WSL2 kernels, including the one GitHub's Windows runner reported, and older ones without the WSL2 suffix.
  for (const r of ['6.18.54.1-microsoft-standard-WSL2', '6.6.36.3-microsoft-standard-WSL2', '5.4.72-microsoft-standard', '4.19.128-microsoft-standard', '6.8.0-1015-azure']) {
    assert.deepEqual(checkPlatform({ platform: 'linux', release: r, has: all }).problems, [], r);
  }
  assert.equal(isWsl1('4.4.0-22000-Microsoft'), true);
  assert.equal(isWsl1('5.15.0-builder-microsoft-test'), false, 'only the WSL1 kernel form, not any mention of microsoft');
});

test('Linux without bubblewrap or socat is refused with the install command', () => {
  const r = checkPlatform({ platform: 'linux', release: '6.8.0', has: name => name === 'socat' });
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /needs bubblewrap, which is not installed/);
  assert.match(r.problems[0], /sudo apt-get install bubblewrap socat/);
  assert.match(checkPlatform({ platform: 'linux', release: '6.8.0', has: () => false }).problems[0], /bubblewrap and socat, which are not installed/);
});

test('Ubuntu 24.04\'s user-namespace restriction warns only while bubblewrap really cannot start', () => {
  assert.deepEqual(checkPlatform({ platform: 'linux', release: '6.8.0', apparmorUserns: '1', has: all, sandboxWorks: () => false }), { problems: [], warnings: [APPARMOR] });
  assert.deepEqual(checkPlatform({ platform: 'linux', release: '6.8.0', apparmorUserns: '1', has: all, sandboxWorks: () => true }), { problems: [], warnings: [] }, 'fixed machines are not warned forever');
  assert.deepEqual(checkPlatform({ platform: 'linux', release: '6.8.0', apparmorUserns: '0', has: all, sandboxWorks: () => false }).warnings, []);
});

test('other platforms are refused', () => {
  assert.match(checkPlatform({ platform: 'freebsd' }).problems[0], /macOS, Linux and WSL2 only/);
});

test('onPath finds executables without a shell', () => {
  assert.equal(onPath('node'), true);
  assert.equal(onPath('definitely-not-a-real-binary-xyz'), false);
  assert.equal(onPath('node', { PATH: '' }), false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fh-path-'));
  fs.mkdirSync(path.join(dir, 'bwrap'));
  try { assert.equal(onPath('bwrap', { PATH: dir }), false, 'a directory named bwrap is not bwrap'); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('FLOORHANDS_PLATFORM_CHECK=off skips the check (development only)', () => {
  assert.equal(platformCheckOff({ FLOORHANDS_PLATFORM_CHECK: 'off' }), true);
  assert.equal(platformCheckOff({}), false);
});

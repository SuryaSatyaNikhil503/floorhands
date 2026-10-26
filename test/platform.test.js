import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPlatform, onPath, WINDOWS, WSL1, APPARMOR } from '../server/platform.js';

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
  assert.deepEqual(checkPlatform({ platform: 'linux', procVersion: 'Linux version 4.4.0-19041-Microsoft (Microsoft@Microsoft.com)', has: all }).problems, [WSL1]);
  assert.deepEqual(checkPlatform({ platform: 'linux', procVersion: 'Linux version 6.6.36.3-microsoft-standard-WSL2 (root@x)', has: all }).problems, []);
  assert.deepEqual(checkPlatform({ platform: 'linux', procVersion: 'Linux version 6.8.0-1015-azure (buildd@lcy02)', has: all }).problems, []);
});

test('Linux without bubblewrap or socat is refused with the install command', () => {
  const r = checkPlatform({ platform: 'linux', procVersion: 'Linux version 6.8.0', has: name => name === 'socat' });
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /needs bubblewrap, which is not installed/);
  assert.match(r.problems[0], /sudo apt-get install bubblewrap socat/);
  assert.match(checkPlatform({ platform: 'linux', procVersion: '', has: () => false }).problems[0], /bubblewrap and socat, which are not installed/);
});

test('Ubuntu 24.04\'s user-namespace restriction is a warning, not a refusal', () => {
  const r = checkPlatform({ platform: 'linux', procVersion: 'Linux version 6.8.0', apparmorUserns: '1', has: all });
  assert.deepEqual(r, { problems: [], warnings: [APPARMOR] });
});

test('other platforms are refused', () => {
  assert.match(checkPlatform({ platform: 'freebsd' }).problems[0], /macOS, Linux and WSL2 only/);
});

test('onPath finds executables without a shell', () => {
  assert.equal(onPath('node'), true);
  assert.equal(onPath('definitely-not-a-real-binary-xyz'), false);
  assert.equal(onPath('node', { PATH: '' }), false);
});

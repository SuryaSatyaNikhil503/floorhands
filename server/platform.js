// Where floorhands can run. Every agent requires Claude Code's OS sandbox (failIfUnavailable), and Claude Code's docs say: "The
// sandbox runs on macOS, Linux, and WSL2. On native Windows, Claude Code runs commands unsandboxed." With failIfUnavailable set,
// Claude Code exits at startup there. So floorhands checks this itself, before anything starts, and says what to do instead of
// failing every agent run later with a less useful message.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const WINDOWS = 'floorhands needs Claude Code\'s sandbox, which runs on macOS, Linux and WSL2 but not on native Windows. '
  + 'On Windows, run floorhands inside a WSL2 distribution: install WSL2 (wsl --install), then Node 22, git, bubblewrap and socat '
  + 'inside it, and start floorhands from there. See "Platform support" in the README.';
export const WSL1 = 'This is WSL1, where Claude Code\'s sandbox does not run. Upgrade the distribution to WSL2 '
  + '(from PowerShell: wsl --set-version <distribution> 2), then start floorhands again.';
export const missingTools = tools => `Claude Code's sandbox on Linux needs ${tools.join(' and ')}, which ${tools.length > 1 ? 'are' : 'is'} not installed. `
  + 'Install them (Debian or Ubuntu: sudo apt-get install bubblewrap socat; Fedora: sudo dnf install bubblewrap socat), then start floorhands again.';
export const APPARMOR = 'Ubuntu 24.04 and later restrict the user namespaces bubblewrap needs (kernel.apparmor_restrict_unprivileged_userns=1). '
  + 'If agents fail with a sandbox error, add the AppArmor profile for bwrap described in Claude Code\'s sandboxing docs.';

// Is an executable FILE with this name on PATH? No shell is involved. (X_OK alone also accepts a directory.)
export function onPath(name, env = process.env) {
  for (const dir of String(env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try { if (fs.statSync(p).isFile()) { fs.accessSync(p, fs.constants.X_OK); return true; } } catch { /* not here */ }
  }
  return false;
}

// WSL1 kernels are named like "4.4.0-19041-Microsoft"; every WSL2 kernel has "microsoft-standard" (older ones without a "WSL2"
// suffix, such as "5.4.72-microsoft-standard"). Only the kernel release is looked at, never build-host text in /proc/version.
export const isWsl1 = release => /-Microsoft$/.test(String(release ?? '').trim());

// Can bubblewrap actually create its sandbox here? Ubuntu 24.04's AppArmor restriction makes it fail unless a bwrap profile is
// installed, so the sysctl alone cannot tell; trying it can.
export function bwrapWorks() {
  try { return spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-user', '--', '/bin/true'], { stdio: 'ignore', timeout: 10_000 }).status === 0; } catch { return false; }
}

// FLOORHANDS_PLATFORM_CHECK=off skips this check (for developing floorhands itself on a machine without the sandbox, with the fake
// claude). Agents still cannot run without the sandbox: Claude Code itself refuses to start.
export const platformCheckOff = (env = process.env) => env.FLOORHANDS_PLATFORM_CHECK === 'off';

const readText = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };

// { problems, warnings } for this machine. Pure when every input is passed, which the tests do.
export function checkPlatform({
  platform = process.platform,
  release = os.release(),
  apparmorUserns = platform === 'linux' ? readText('/proc/sys/kernel/apparmor_restrict_unprivileged_userns').trim() : '',
  has = name => onPath(name),
  sandboxWorks = bwrapWorks,
} = {}) {
  if (platform === 'darwin') return { problems: [], warnings: [] };
  if (platform === 'win32') return { problems: [WINDOWS], warnings: [] };
  if (platform !== 'linux') return { problems: [`floorhands has not been made to run on ${platform}: Claude Code's sandbox supports macOS, Linux and WSL2 only.`], warnings: [] };
  if (isWsl1(release)) return { problems: [WSL1], warnings: [] };
  const missing = [['bwrap', 'bubblewrap'], ['socat', 'socat']].filter(([bin]) => !has(bin)).map(([, pkg]) => pkg);
  if (missing.length) return { problems: [missingTools(missing)], warnings: [] };
  // Warn only when the restriction is on AND bubblewrap really cannot start, so a fixed machine is not warned forever.
  return { problems: [], warnings: apparmorUserns === '1' && !sandboxWorks() ? [APPARMOR] : [] };
}

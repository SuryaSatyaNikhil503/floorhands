// Where floorhands can run. Every agent requires Claude Code's OS sandbox (failIfUnavailable), and Claude Code's docs say: "The
// sandbox runs on macOS, Linux, and WSL2. On native Windows, Claude Code runs commands unsandboxed." With failIfUnavailable set,
// Claude Code exits at startup there. So floorhands checks this itself, before anything starts, and says what to do instead of
// failing every agent run later with a less useful message.
import fs from 'node:fs';
import path from 'node:path';

export const WINDOWS = 'floorhands needs Claude Code\'s sandbox, which runs on macOS, Linux and WSL2 but not on native Windows. '
  + 'On Windows, run floorhands inside a WSL2 distribution: install WSL2 (wsl --install), then Node 22, git, bubblewrap and socat '
  + 'inside it, and start floorhands from there. See "Platform support" in the README.';
export const WSL1 = 'This is WSL1, where Claude Code\'s sandbox does not run. Upgrade the distribution to WSL2 '
  + '(from PowerShell: wsl --set-version <distribution> 2), then start floorhands again.';
export const missingTools = tools => `Claude Code's sandbox on Linux needs ${tools.join(' and ')}, which ${tools.length > 1 ? 'are' : 'is'} not installed. `
  + 'Install them (Debian or Ubuntu: sudo apt-get install bubblewrap socat; Fedora: sudo dnf install bubblewrap socat), then start floorhands again.';
export const APPARMOR = 'Ubuntu 24.04 and later restrict the user namespaces bubblewrap needs (kernel.apparmor_restrict_unprivileged_userns=1). '
  + 'If agents fail with a sandbox error, add the AppArmor profile for bwrap described in Claude Code\'s sandboxing docs.';

// Is an executable with this name on PATH? No shell is involved.
export function onPath(name, env = process.env) {
  for (const dir of String(env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    try { fs.accessSync(path.join(dir, name), fs.constants.X_OK); return true; } catch { /* not here */ }
  }
  return false;
}

const readText = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };

// { problems, warnings } for this machine. Pure when every input is passed, which the tests do.
export function checkPlatform({
  platform = process.platform,
  procVersion = platform === 'linux' ? readText('/proc/version') : '',
  apparmorUserns = platform === 'linux' ? readText('/proc/sys/kernel/apparmor_restrict_unprivileged_userns').trim() : '',
  has = name => onPath(name),
} = {}) {
  if (platform === 'darwin') return { problems: [], warnings: [] };
  if (platform === 'win32') return { problems: [WINDOWS], warnings: [] };
  if (platform !== 'linux') return { problems: [`floorhands has not been made to run on ${platform}: Claude Code's sandbox supports macOS, Linux and WSL2 only.`], warnings: [] };
  // WSL1 kernels report "...-Microsoft"; WSL2 kernels report "...-microsoft-standard-WSL2".
  if (/microsoft/i.test(procVersion) && !/wsl2/i.test(procVersion)) return { problems: [WSL1], warnings: [] };
  const missing = [['bwrap', 'bubblewrap'], ['socat', 'socat']].filter(([bin]) => !has(bin)).map(([, pkg]) => pkg);
  return { problems: missing.length ? [missingTools(missing)] : [], warnings: apparmorUserns === '1' ? [APPARMOR] : [] };
}

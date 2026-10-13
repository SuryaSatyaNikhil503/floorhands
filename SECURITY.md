# Security policy

floorhands runs AI agents that read files, edit files and run commands on your computer. Its whole value depends on the limits around those agents holding, so security reports are very welcome.

## Reporting a vulnerability

Report privately through GitHub's private vulnerability reporting:

**https://github.com/SuryaSatyaNikhil503/floorhands/security/advisories/new**

Please do **not** open a public issue, pull request or discussion for a vulnerability. There is no security email address; private vulnerability reporting is the only channel.

A useful report has:

- what an agent, a repository or a website can do that it should not;
- the steps to reproduce (a throwaway repository and fake secrets are ideal; never send real credentials);
- your OS, Node version, git version and `claude --version`;
- for permission problems, the relevant transcript lines (the `tool_use` and its `tool_result`). Task transcripts are in `.floorhands/tasks/` inside the project.

## What to expect

This is a small project maintained on a **best-effort** basis. I will try to acknowledge a report within a week and to keep you informed while it is investigated, but there is no guaranteed response or fix time. If you would like credit in the advisory, say how you want to be named.

## Supported versions

Only the latest version on the default branch is supported. Fixes are not backported.

## Scope

In scope: any way that

- an agent, or an **untrusted target repository** (its files, `.claude/` settings, hooks, skills, `.mcp.json`, `CLAUDE.md`, `package.json` scripts, symlinks, git config or attributes), can
  - read secrets: `.env*`, `*.pem`, or the home credential stores floorhands denies (`~/.aws`, `~/.ssh`, `~/.config/gh`, `~/.npmrc`, `~/.netrc`, `~/.claude`, and the rest of the list in `server/tiers.js`);
  - write outside the task's git worktree, or change your working copy without Approve;
  - run code outside Claude Code's Bash sandbox, or run a command its tier does not allow;
  - reach the network from a build or test step;
  - push, deploy, or use your cloud or git credentials;
- another website, browser tab or local process can drive the local server in a way the Host/Origin/Content-Type checks are meant to stop;
- floorhands itself (the server, CLI or plugin hook) leaks task text, transcripts or file contents somewhere other than the project's `.floorhands/` folder.

Out of scope: anything already listed under **Known limits** in the [README](README.md#known-limits). For example: no authentication on the local port beyond the 127.0.0.1 binding and Host/Origin checks (another local user on the same machine can call it); secrets that a repository has committed being readable through allowed git reads; build/test scripts reading the worktree's own `.env*`; repository-configured diff programs; the environment-variable deny-list; behaviour of your own `~/.claude/settings.json`. Reports that show a known limit is **worse** than documented are in scope.

Also out of scope: vulnerabilities in Claude Code itself, Node or git (report those upstream), and social-engineering or physical-access scenarios.

## Threat model in short

floorhands assumes **you** are trusted, your user-level Claude Code settings are trusted, and the **target repository and everything an agent reads are not**. Each agent is a separate `claude -p` process with an explicit tool list and deny rules for its tier (read, build or test), defined in [`server/tiers.js`](server/tiers.js). Build and test work happens in a separate git worktree inside Claude Code's Bash sandbox (no network, no writes outside the worktree), and nothing reaches your branch until you press Approve. The README section ["How it keeps you safe"](README.md#how-it-keeps-you-safe) explains each layer, what was verified against the real CLI, and what was not.

# Changelog

All notable changes to floorhands are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) (before 1.0, any minor version may change behaviour).

## [Unreleased]

## [0.1.0] - 2026-10-13

First release. Early software: it works end to end on macOS, but the agent prompts are first drafts and several parts are unverified (see the README's Known limits).

### Added

- A local server per project (127.0.0.1, port 4600 or the next free one) with a browser UI: an SVG floor plan of the team that updates live, a task box, each step's output and a per-agent activity log, and a diff view with **Approve and merge** and **Reject**.
- Nine agents in three pods, defined as data in `agents/roster.json` with one Markdown prompt each: an Architect that plans and routes, three read-only reviewers (front end, back end, AWS), two builders, an SRE, a support engineer and an end-to-end tester.
- One `claude -p` process per agent turn, using your own Claude Code login; prompts go in on stdin, never in argv.
- Three permission tiers (read, build, test) defined only in `server/tiers.js`: `--permission-mode dontAsk`, explicit tool lists, allow lists for read-only git and `npm run` scripts, and deny rules for pushes, deploys, shells, network tools, shell commands that print files, secret files and home credential stores.
- Build and test steps in a per-task git worktree on a `floorhands/<task>` branch; Approve merges it with `git merge --no-ff`, Reject deletes the worktree and branch. Before committing, the server checks that the worktree's git link still points at its own branch, and runs its git commands with hooks and fsmonitor disabled.
- Claude Code's Bash sandbox for build and test steps (no network, no writes outside the worktree, no unsandboxed retry, refuse to run without a sandbox).
- `--setting-sources user` and `--strict-mcp-config` for every agent, so a target repository's own Claude settings, hooks, skills and MCP servers are ignored.
- Removal of common credential variables from agent processes (a deny-list).
- Local server guards: Host and Origin checks, JSON-only POST bodies with a size limit, a Content-Security-Policy on the UI.
- CLI: `floorhands start | open | status | stop | enable | disable`.
- Claude Code plugin with the `floorhands` skill and an opt-in SessionStart hook (`floorhands enable`).
- Permission probes against the real CLI (`scripts/spike-claude.mjs`) with results in `docs/spike-findings.md`, verified on Claude Code 2.1.296 on macOS. Two bypasses found in round 1 and one in round 2 (hooks in an untrusted repository's settings) were fixed before release.
- A test suite that runs entirely against a fake `claude` (`npm test`), and CI on Linux and macOS with Node 22 and 24.
- Source-available license: PolyForm Noncommercial 1.0.0 with Additional Terms (no commercial use, no redistribution).

[Unreleased]: https://github.com/SuryaSatyaNikhil503/floorhands/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/SuryaSatyaNikhil503/floorhands/releases/tag/v0.1.0

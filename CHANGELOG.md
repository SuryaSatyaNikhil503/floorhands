# Changelog

All notable changes to floorhands are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) (before 1.0, any minor version may change behaviour).

## [Unreleased]

## [0.2.0] - 2026-10-17

Agents now know the project they work on, and every prompt was rewritten. Still early software: the permission model (`server/tiers.js`) is unchanged from 0.1.0.

### Added

- Project facts (`server/stack.js`): at the start of each task floorhands detects the project's languages, frameworks, package manager, which of the `lint`, `build`, `format`, `typecheck`, `test` and `e2e` scripts exist in the root `package.json`, test tools, infrastructure, CI system and monorepo layout, and tells every agent. The result is built only from a fixed list of labels plus numbers; no repository text (names, script commands, paths, versions, dependency names) is ever copied. The facts are stored with the task.
- Owner notes (`server/notes.js`, `floorhands notes`): standing guidance for a project, kept outside the repository at `<FLOORHANDS_HOME or ~/.floorhands>/projects/<project-hash>/notes.md`, capped at 4 KB and shown to every agent. Notes cannot widen an agent's permissions. The page shows a "Project notes" line, and `/api/state` reports the notes file's path and size, never its contents.
- Per-task prompt composition (`server/prompt.js`): common rules, tier note, project facts, owner notes, relevant skill hints, then the role body, within a 24 KB cap. Skill entries in `agents/roster.json` may be `{ name, alt, when }` objects whose hint is shown only when the detected stack matches; no skill is ever required.
- Routing hints for the Architect derived from the facts (no runnable test script: no tester step; no lint, build, format or typecheck script: builders can only edit; AWS-style infrastructure without an application framework: prefer the AWS reviewer).
- A hand-off hint for steps that run in a task worktree: the commit the branch started at and the git commands that show the change under review.
- A prompt lint (`test/prompts.test.js`) that ties every prompt to the permission model: no prompt may tell an agent to run a command its tier denies, and each must have its required sections and stay within its size cap.
- A prompt evaluation on three small sample projects (`scripts/eval-prompts.mjs`, `eval/`; results in `docs/prompt-eval.md`).
- README: a step-by-step install guide for the Claude Code plugin, a first-run walkthrough, how to use notes and the skill day to day, and tips for writing tasks.

### Changed

- All nine agent prompts were rewritten (prompts v2): shared rules with a severity scale and a finding format; a `VERDICT:` first line and *What I checked* / *What I did not check* in every report; routing rules for the Architect; stack-specific checklists for the three reviewers; workflows and verification rules for the builders and the SRE; a ticket template for the support engineer; a strategy and report format for the tester.
- The plan summary in the page keeps its line breaks.
- README: Known limits and Roadmap updated (the prompt rewrite is done; project profiles now start with owner notes).

### Security

- The project scan runs git with every transport, lazy fetching and fsmonitor disabled, ignores `core.worktree` and `gitdir:` redirects, and uses a plain directory walk when `.git` is not a real directory, so a hostile `.git/config` cannot make it run programs. Not every git call is hardened; see Known limits in the README.
- Documented new limits: the system prompt (and so owner notes and project facts) is visible in the process list, and floorhands should only be run on repositories you cloned yourself.

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

[Unreleased]: https://github.com/SuryaSatyaNikhil503/floorhands/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/SuryaSatyaNikhil503/floorhands/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/SuryaSatyaNikhil503/floorhands/releases/tag/v0.1.0

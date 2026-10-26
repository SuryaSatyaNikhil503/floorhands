# Changelog

All notable changes to floorhands are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) (before 1.0, any minor version may change behaviour).

## [Unreleased]

### Added

- Platform support, stated and checked. floorhands runs where Claude Code's sandbox runs: macOS, Linux and WSL2. `floorhands start` refuses on native Windows (pointing to WSL2) and on WSL1, refuses on Linux without `bubblewrap` and `socat` (with the install command), and warns about Ubuntu 24.04's user-namespace restriction (`server/platform.js`).
- CI on Windows (`.github/workflows/platforms.yml`): native Windows must refuse with the WSL2 message, and inside WSL2 Ubuntu 24.04 the test suite and the keyless permission probes must pass.
- README: a Platform support section with WSL2 steps.

### Fixed

- On git before 2.44 (Ubuntu 24.04, the default WSL distribution, ships 2.43) the project scan fell back to a plain folder walk, because git refused the `--no-lazy-fetch` option, so project facts counted git-ignored files. The scan now retries without that one option, keeping the other two protections, each of which blocks every hostile fixture on its own. Found by the new WSL2 CI job.

## [0.3.0] - 2026-10-26

The right model for each step, spending caps that never overshoot, a record of what every run cost, and a stricter safety model. The permission model changed (`server/tiers.js`). All 73 permission probes were run on it with Claude Code 2.1.310, on macOS and Linux, with no API key: 71 PASS and 2 known limits.

### Added

- Model routing (`server/models.js`). Each step has a class (`light`, `standard`, `frontier`) mapped to a model, effort level and spending cap (Haiku, Sonnet, Opus with a Sonnet fallback by default). The Architect proposes a class per step, and floorhands clamps it to the agent's range in `agents/roster.json`: the Architect and reviewers are pinned to `frontier`, builders range from `light` to `frontier` (default `standard`), the tester and support engineer from `light` to `standard` (default `light`).
- Spending caps: `--max-budget-usd` per step, a per-task cap ($15 by default) checked before every step, and a limit on tasks running at once (1 by default). All set in `~/.floorhands/models.json`, validated strictly; `floorhands models` shows them.
- A record of every run: the model that actually ran, the CLI version, tokens (including cache reads and writes), cost, time, turns, permission refusals and a hash of the system prompt, per step and as task totals by model. The raw plan and any plan problems are kept.
- Reject reasons from a closed list, with an optional note. The merge commit is recorded on Approve. The diff of every rejected or failed task is kept as a redacted, owner-only patch (the newest 50).
- Risk flags in the approval view for changes to `package.json`, lockfiles, git hooks, `.gitattributes`, CI, package manager and build config, and agent config.
- The page shows the model, class and cost of each step, the task's usage, the risk flags and a reason picker for Reject.
- `floorhands url` and `floorhands models`.
- The undo-the-fix benchmark harness (`scripts/bench.mjs`, `scripts/bench-lib.mjs`, `eval/bench/`): real fix commits graded by the projects' own tests, a single-agent baseline, five runs per cell, bootstrap confidence intervals over instances, a blind judge from another model family with Cohen's kappa calibration, and approval rate. No corpus is included yet.
- The spending guard (`server/meter.js`): a local metering proxy every agent's model requests go through. Each request is priced at its worst case before it is sent; it goes through, goes through with a lower `max_tokens`, or waits while the page asks the owner to allow more money or stop. Caps can no longer be overshot. The same question is asked before a step when the task has used its cap. `POST /api/tasks/:id/budget`, the task status `needs_budget`, and `budgetDecisions` in the task record. `FLOORHANDS_METER=off` and `FLOORHANDS_METER_LOG=1`.
- Slim agent sessions: owner hooks off, auto memory off, owner skills off unless a roster hint applies, and per-folder details out of the system prompt (`--exclude-dynamic-system-prompt-sections`). Found by capturing the CLI's requests with a fake API: the skill listing (about 7k tokens), plugin SessionStart output (up to 10k) and a working-directory path in the system prompt (no cache sharing across worktrees). A real docs task went from $0.246 to $0.072.
- Permission probes without an API key: `scripts/spike-claude.mjs --fake-model` runs the real CLI against a local fake Anthropic API (`scripts/fake-anthropic.mjs`) and a scripted worst-case model (`scripts/probe-model.mjs`). 67 PASS and 2 KNOWN LIMIT on 2.1.310 (`docs/spike-results-0.3.0.md`). The CLAUDE.md prompt-injection probe passes for the first time.
- A probe workflow (`.github/workflows/probes.yml`) that runs the permission probes on macOS and Linux for every new Claude Code version and on permission-model changes, with no API key or other secret, and fails on any regression against the committed baseline (`scripts/probe-compare.mjs`). Two new probes: a repository `diff.external` program and a repository fsmonitor program under the read tier.

### Changed

- The read tier now runs its Bash in the sandbox too. Reviews need the sandbox (on Linux, `bubblewrap` and `socat`).
- Agents get an allow list of environment variables instead of the owner's environment minus a deny list. `FLOORHANDS_ENV_ALLOW` adds names.
- The system prompt reaches the CLI through `--append-system-prompt-file`, as an owner-only file deleted after the run, never on the command line.
- `floorhands start` says to open the page with `floorhands open`, because the page needs the run's token.

### Fixed after review

An independent review of the pull request disproved two of its claims, with reproductions. Fixed before merge:
- The merge on Approve ran the owner's own hooks, which can load repository files an agent changed (a commitlint config, for example) and so run agent-written code outside the sandbox. Approve now runs no hooks at all.
- Requests waiting on the same budget question could all spend the same headroom (about 3x over in the reproduction). The check and the reservation now happen in one step.
- With Bedrock, Vertex or Foundry, model traffic bypassed the guard and nothing capped it. The CLI's cap is used for them, and a run whose output did not go through the guard is stopped at once.
- A cut stream released its reservation twice and cost nothing; usage past the first 8 MB of a stream was lost; fast mode, images and documents were not in the worst case; dot segments in a path reached unmetered endpoints. All fixed.
- A sandboxed script could read the server's access token in `.floorhands/server.json` by its absolute path. Reads of that folder are denied to tools and scripts. New probes: loopback is unreachable from the sandbox, and the state folder is unreadable.
- A second review of the fixes found that build and test agents, working in a worktree, could still read the token with the Read tool: the deny pattern was relative to the working folder. It is now an absolute path, with a probe that runs from a worktree. Also from that review: a cut stream is charged its whole output allowance (thinking is billed but not streamed); the bypass tripwire ignores the CLI's synthetic errors and an owner's stop; a provider or `ANTHROPIC_BASE_URL` in the owner's Claude settings is honoured (the guard's address goes in `--settings`, which outranks them, verified with the real CLI); only the endpoints the CLI needs pass the guard; a client that left while waiting is not sent; runner settings inside `package.json` and git-ignored test setup files count as test-setup changes, and the check fails closed.
- The tester is also skipped when `.npmrc` or a test-runner config changed; failure messages are redacted; an unanswered budget question is cancelled when its run ends; an allowance that rounds to $0 is refused; a probe that disappears from a run fails the gate.

### Security

- A per-run access token protects every `/api/` route except `/api/health`.
- Agents run git with fsmonitor, hooks, ssh and network transports switched off by environment-level config.
- Approve runs the merge with no hooks when the branch changed files under a hooks folder, so agent-written hooks never run outside the sandbox. Before this, a builder could plant a `post-merge` hook in a `.husky/` folder that ran on Approve.
- The server's `worktree add` and diffs no longer run repository-configured hooks, fsmonitor, external diff or textconv programs.
- A test step is skipped when a builder changed the `package.json` scripts.
- Agent output, the raw plan, events, reject notes and kept patches are redacted before they are stored or passed on. Task files, patches and `server.json` are owner-only.

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

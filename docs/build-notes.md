# Phase 1 build notes

What the build process decided, what is still unverified, and what to do next. Written when phase 1 was finished (2026-10-13); the per-task review ledger it summarizes was scratch and is not kept.

## Verified, and not yet verified

**Verified on claude 2.1.296 (macOS) on 2026-10-13** with `scripts/spike-claude.mjs` (41 real `claude -p` calls, 47 probes; results in `docs/spike-findings.md` and `docs/spike-results.json`): `--permission-mode dontAsk`, `--tools`/`--allowedTools`/`--disallowedTools` (variadic lists, including entries with spaces), `Bash(prefix:*)` rules, the mid-position wildcard denies (`git log -1 --format=… --output=<path>` denied), `git diff --no-index .env /dev/null` denied, `git -C`/`git config`/`git push` denied, `--strict-mcp-config` (no MCP servers; without it agents would get the owner's 7 claude.ai connectors), deny-over-allow, prompts on stdin, the Skill tool under `dontAsk`, Read/Grep/Glob honouring the Read deny rules, `.git` link file / `node_modules` / `.env*` write protection inside a real worktree, and the Bash sandbox for build/test (network and outside writes blocked, git and npm still work).

The spike found and fixed two bypasses: a bare `Edit`/`Write` allow let builders write outside the working directory (now `Edit(./**)`), and Bash `grep -r` read `.env` (grep-like commands are now denied).

**Round 2 (untrusted target repositories, same day; see `docs/spike-findings.md`):** a hook in the target repo's `.claude/settings.json` ran outside the sandbox as the owner; fixed with `--setting-sources user` (owner skills still load). Verified neutralised: project/local hooks, project `permissions.allow`, `sandbox.excludedCommands`, `sandbox.enabled:false`, `.mcp.json`, repo skills with `allowed-tools`; 16 read-only shell forms that could print `.env` (all denied, now also by `DENIED_SHELL_READERS`); `git cat-file`; home credential stores via the Read tool and via sandboxed scripts; Write through a symlink out of the worktree; sandboxed writes through the `node_modules` link.

Not yet verified / accepted limits:

- Committed secrets are readable through the allowed git reads (`git show HEAD:.env` printed one); sandboxed build/test scripts can read the worktree's own `.env*` (present only if committed). Accepted and documented.
- `.gitattributes` can route agent-written files through filter programs the owner configured (git-lfs etc.) at commit and merge time. Accepted: neutralising them would break LFS repos.
- A prompt injection in `CLAUDE.md` that the model actually follows (the probe's model did not attempt it).
- The CLI's `~` expansion for the new credential rules (HOME cannot be overridden without logging the CLI out; probes used the same rules for a fake home's absolute path).
- The sandbox on Linux; other CLI versions.
- Roster skill names: several do not resolve as written (see the skill map in `docs/spike-findings.md`); the prompts phase decides.
- `scripts/smoke.mjs` (a real review task end to end) has never run.
- The `/floorhands:floorhands` skill and SessionStart hook pass `claude plugin validate` but have not run in a live session.
- `scripts/install.sh` and `claude plugin marketplace add` / `install` have not been run (they change PATH and Claude config).

## Fixed before release

Three first-use problems found in the final review were fixed before this release: a project `.gitignore` that lists `node_modules` without a trailing slash broke every build step; the advice about `FLOORHANDS_BIN` for a missing `node` could not work and was corrected; and sha256-format repositories (64-hex object ids) are now accepted.

## Follow-ups (priority order)

1. Keep the floorhands branch and show the error (state `awaiting_approval`) when a task fails after build commits, instead of deleting finished work.
2. Kill the whole process group on agent timeout and on `stop` (a dev server started by `npm run e2e` can outlive the run); on restart, clean up worktrees/branches of interrupted tasks.
3. Timeouts for git commands and real stderr in merge errors (a GPG prompt or hanging hook currently freezes Approve until restart).
4. Environment scrubbing as an allow-list (today a deny-list: `GITLAB_TOKEN`, `OPENAI_API_KEY`, `DATABASE_URL` still reach agents).
5. Per-run random token for the local server (today any local user/process can call it; the spec put authentication out of scope).
6. Smoke script: realpath the direct-run guard, reject `--help`/unknown args (today `--help` would run the real test). The negative probes now live in `scripts/spike-claude.mjs`.
7. Smaller: `isTask` should validate step entries; show `plan.problems` to the user; cap concurrent tasks; `/api/state` re-parses every task file; `stop` message when a hung server does not answer; hawkscan skill vs the test tier; UI focus handling while a decision is pending; automated tests for `ui/app.js`; phone-width SVG text is small.

## Rulings made during the build (what and why)

- Local-port authentication was **not** implemented (out of scope in the spec); recommended as follow-up 5.
- `Edit`/`Write` allow rules were first left unscoped; the spike proved that lets the Write tool create files outside the worktree, so the build tier now allows only `Edit(./**)` (the CLI checks Write against Edit path rules). Further protection is by deny rules (`.git`, `.env*`, `~/.ssh`, `~/.aws`, shell rc files, `~/.claude`, `node_modules`, `.mcp.json`), the worktree, and a commit-time check that the worktree's git link still points at its own branch.
- `curl` and `npx` are not allowed for any tier (spec originally listed `curl localhost`; it can send data anywhere).
- Settings isolation: round 2 applied `--setting-sources user` after a probe showed target-repo hooks running. User settings stay loaded on purpose (plugin skills come from the owner's `enabledPlugins`); the owner's own settings are trusted.
- The Bash sandbox (`BASH_SANDBOX_SETTINGS` in `server/tiers.js`) is on for the build and test tiers only, with auto-allow off so the tier allow lists still apply; the read tier runs no project scripts.
- `ui/model.js` was added (pure, DOM-free logic so the UI's behaviour is testable).
- `test/cli.test.js` was changed in the final fix wave to poll for the losing server to exit (a latent race in the concurrent-start test).
- Task 12's visual check (browser pane, fake claude) was done by hand: floor, task flow, approve, reject, failure state, phone layout.

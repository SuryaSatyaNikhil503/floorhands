# Contributing to floorhands

Thanks for wanting to help. floorhands is **source-available, not open source** (see [LICENSE](LICENSE)), and it runs AI agents on people's machines, so contributions follow a few firm rules. Please read this page before you start.

## Propose first

- **Anything non-trivial starts with an issue.** Describe the problem and the change you have in mind, and wait for a reply before you write code. This saves you from building something that cannot be merged (for example because it widens an agent's permissions).
- Typos, broken links and small doc fixes can go straight to a pull request.
- Security problems never go in a public issue. Use private vulnerability reporting; see [SECURITY.md](SECURITY.md).
- To ask for permission the license does not give (for example commercial use), open an issue titled **"Permission request"**.

## Forking

The license does not allow publishing your own copy of floorhands, publicly or privately. The one exception: you may **fork the official repository on GitHub solely to prepare a contribution**, and keep that fork only until the contribution is merged or withdrawn (LICENSE, Additional Terms §1(a)). Please delete the fork afterwards.

## Development setup

You need Node 22 or newer and git. There are no dependencies to install.

```bash
git clone https://github.com/SuryaSatyaNikhil503/floorhands.git
cd floorhands
npm test
```

`npm test` runs the whole suite with `node --test`. It uses `scripts/fake-claude.mjs`, a stand-in for the `claude` CLI, so it needs no network, no Claude login and spends no quota. CI runs the same command on Linux and macOS with Node 22 and 24.

To try the UI without spending quota, point the server at the fake CLI from inside any git repository:

```bash
FLOORHANDS_CLAUDE_BIN=/path/to/floorhands/scripts/fake-claude.mjs /path/to/floorhands/bin/floorhands start
```

### Scripts that use the real `claude` CLI

These spend real requests on **your own** Claude login. Run them only on your own account, never in CI, and never against a repository you care about (they create their own throwaway repositories under the OS temp dir).

| Script | What it does |
|---|---|
| `node scripts/spike-claude.mjs` | Permission probes: runs the real tier flags from `server/tiers.js` and checks that each forbidden action was attempted and refused. About one short `claude -p` turn per probe. `--list` prints the probes without running anything; `--only <probe>` runs a subset. Results and how to read them: [docs/spike-findings.md](docs/spike-findings.md). |
| `node scripts/eval-prompts.mjs` | The prompt evaluation: runs the agent prompts on the sample projects in `eval/` and scores the results (see [docs/prompt-eval.md](docs/prompt-eval.md)). Run `node scripts/eval-prompts.mjs --help` first to see its options and how many real requests a run makes. |
| `node scripts/smoke.mjs` | One real review task end to end. It takes no arguments (it does not parse `--help`; any invocation starts the run). It has not yet been run against the real CLI. |

## Rules for changes

- **Zero runtime dependencies.** `package.json` has no `dependencies`, and a test checks that. Use Node's standard library.
- **The safety model lives in `server/tiers.js` and nowhere else.** Any change to it (tools, allow or deny rules, sandbox settings, CLI flags) needs a matching probe in `scripts/spike-claude.mjs` or a test in `test/tiers.test.js`, and the pull request must say honestly what was verified: which probes ran, on which OS and Claude Code version, and what was not run. "It should work" is not verification. A rule the real CLI ignores is worse than no rule, because it looks like protection.
- **Prompt changes keep the lint green and are measured.** The prompts in `agents/prompts/` and the skill hints in `agents/roster.json` are covered by the prompt lint in `test/prompts.test.js`, which runs in `npm test`: it ties every prompt to the permission model, so a prompt may not tell an agent to run a command its tier denies, and it checks required sections and size caps. A prompt edit that changes what agents do (not a typo or a wording fix) also needs an evaluation summary in the pull request: which sample projects you ran it on, before and after, with the scores from `node scripts/eval-prompts.mjs` (run it with `--help` first). Say honestly what you did not run. A prompt that reads better is not evidence that it works better.
- **Prefer narrowing.** A change that gives any agent more access (a new command, a new path, network) needs a clear reason in the issue first.
- **Keep the known limits true.** If your change fixes or creates a limit, update "Known limits" in the README.
- **No secrets or personal data** in code, tests, fixtures or recorded results. Spike output is redacted for a reason; keep it that way.
- **Tests use the fake CLI.** New behaviour gets tests under `test/`; nothing in `npm test` may call the real `claude`.
- **Plugin changes are validated.** If you touch `claude-plugin/` or `.claude-plugin/`, run `claude plugin validate claude-plugin` and `claude plugin validate .` and say so in the pull request. Do not test with `claude plugin install` against your everyday Claude Code configuration; use a throwaway one.
- **Project facts stay closed.** Anything `server/stack.js` reports is built from its fixed list of labels and numbers; repository text (names, script commands, paths) must never reach an agent through the facts, because the repository is untrusted.

## Code style

Match the code around you: ES modules, `node:` imports, small functions, no build step, no framework, two-space indentation, single quotes, semicolons. Comments explain *why* (especially for anything safety-related), not what. User-facing messages are plain sentences that say what to do next.

## Commits and pull requests

- One logical change per commit, with a short imperative subject (`fix(worktree): …`, `docs: …`, `test: …`). Commit messages are plain: no co-author trailer is required, and none is added by this project's tooling.
- Before you open a pull request:
  - [ ] `npm test` passes.
  - [ ] New behaviour has tests.
  - [ ] No new runtime dependencies.
  - [ ] `server/tiers.js` changes come with a probe or test and an honest verification note.
  - [ ] Prompt changes that alter behaviour come with an evaluation summary (see Rules for changes).
  - [ ] README / CHANGELOG updated where behaviour changed.
  - [ ] The pull request links the issue where the change was agreed.

## Contributor terms

By submitting a contribution (a pull request, a patch, or code in an issue) you agree to LICENSE, Additional Terms §4, which reads:

> If you submit a contribution (a pull request, a patch, or code in an issue), you confirm that you have the right to submit it, and you grant the licensor a perpetual, worldwide, non-exclusive, royalty-free, irrevocable license to use, modify, sublicense and relicense it in any way, including commercially and under different license terms.

If you cannot agree to that (for example because your employer owns your work), please do not submit code; an issue describing the problem is still welcome.

## Be respectful

Be kind and assume good faith. Critique code, not people. Harassment or personal attacks in issues, pull requests or reviews are not tolerated and will be removed. There is no separate code of conduct; this paragraph is it.

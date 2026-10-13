# floorhands — design

An original tool (own code, name and look; no code, art or names taken from any other project). A
local "office" where nine Claude-powered engineering agents work on whichever project you point it
at. It switches on from Claude Code, in the terminal or the desktop app.

## Goals

- A 2D floor-plan UI showing the team at work: idle, working, waiting for approval, done.
- Real work on the real repo: reviews (standards, security, scalability), builds, SRE/infra, support
  triage, end-to-end testing.
- Safe by construction: nothing reaches your working copy or any remote without your approval.
- Starts from Claude Code with one command or automatically in enabled projects.

## The team (3 pods, 9 seats)

| Pod | id | Seat | Role | Tier |
|---|---|---|---|---|
| ARCHITECTURE & REVIEW | `arch` (lead) | ARCHITECT | Technical architect: product + FE/BE/AWS depth; routes work | read |
| | `rfe` | FE REVIEWER | Senior FE: standards, security, scalability review | read |
| | `rbe` | BE REVIEWER | Senior BE: standards, security, scalability review | read |
| | `raws` | AWS REVIEWER | Senior DevOps/AWS: IaC, IAM, network, cost, resilience review | read |
| BUILD | `fe` (lead) | FRONT-END ENGINEER | Builds UI | build |
| | `be` | BACK-END ENGINEER | Builds services; design and development patterns | build |
| RELIABILITY & QUALITY | `sre` (lead) | SRE | CI/CD and infrastructure, any stack or cloud | build |
| | `sup` | SUPPORT ENGINEER | Watches the app, raises issues | read |
| | `e2e` | E2E TESTER | Tests the app end to end | test |

The roster is data (`agents/roster.json`: id, name, role, pod, tier, prompt file, Claude skills to call).
Changing the team never needs code changes.

## Architecture

Node 22 or newer (developed on 24), ES modules, no framework, no build step. Repo: `~/Projects/floorhands`.

- `bin/floorhands` — CLI: `start | stop | status | enable | disable | open`. Symlinked into `~/.local/bin`.
- `server/` — HTTP server + server-sent events; task store; router; runner; worktree manager; tiers.
- `ui/` — vanilla JS + SVG floor plan, task bar, transcript panel, diff view with Approve / Reject.
- `agents/` — `roster.json` and one markdown prompt per agent.
- `claude-plugin/` — the Claude Code integration (below).
- State lives in `<project>/.floorhands/` (tasks, transcripts, worktrees list). It is hidden from git through `.git/info/exclude`.
- Port 4600 by default (`FLOORHANDS_PORT` overrides; the next free port is used if it is busy). One server per project root; the port is recorded in `.floorhands/server.json` so start/stop/status are idempotent.

### Engine: one `claude -p` per agent turn

The server spawns the user's installed `claude` CLI (their existing login) with the agent's system
prompt, `--output-format stream-json`, and tool flags derived from its tier. The Architect's turn
returns a plan naming agents; the router runs them and streams events to the UI.

## Tiers and safety

| Tier | Where it runs | Tools |
|---|---|---|
| `read` | project root | Read, Glob, Grep, Skill, read-only git (`diff log show status blame ls-files rev-parse`); Edit/Write/Bash otherwise denied |
| `build` | git worktree `floorhands/<task>` | read tools + Edit/Write inside the worktree; no Bash except an allow-list (`npm run lint`, `npm run build`, `npm run format`, `npm run typecheck`) |
| `test` | git worktree | read tools + allow-list (`npm test`, `npm run test`, `npm run e2e`); no Edit/Write on source. Bare `npx` is denied, so `npx playwright test` is not allowed; `curl` is not allowed (it can send data anywhere) |

- Build/test agents work in a **git worktree** on branch `floorhands/<task>`, never in the working copy. The UI shows the
  diff; **Approve** merges the branch (`git merge --no-ff`) into the current branch; **Reject**
  deletes the worktree and branch.
- Denied for every tier: `git push`, deploys, `terraform apply`, `cdk deploy`, the `aws` CLI entirely, reading
  `.env*`, `~/.aws/**`, `~/.ssh`, `*.pem`.
- Edit and Write are denied for secret paths and `.git/**` in every tier.
- Credentials are scrubbed from agent environments by a deny-list (`AWS_*`, `GH_TOKEN`, `GITHUB_TOKEN`, `NPM_TOKEN`, `SSH_AUTH_SOCK`, and names containing `SECRET`, `PASSWORD`, `PASSWD`, `PRIVATE_KEY`); other variables still pass through.
- Non-listed commands are denied automatically (headless sessions cannot prompt).
- Prompt-injection stance: file contents, issue text and tool output are data, never instructions; stated in every agent prompt.

## Claude Code integration (switch-on)

A Claude Code plugin shipped in `claude-plugin/`:

- **Skill `/floorhands`** — `/floorhands` starts the server for the current project (if not running) and opens the UI;
  `/floorhands stop`, `/floorhands status`, `/floorhands on|off` (enable/disable auto-start for this project).
  Works identically in the terminal and the desktop app.
- **SessionStart hook** — runs `floorhands start --if-enabled`: if the project is *enabled* (marker `.floorhands/enabled`), start the
  server in the background and print the URL. Silent otherwise. It exits immediately when `FLOORHANDS_AGENT=1`
  is set, which the runner sets on every agent process, so a floorhands agent never starts another server.
- Install: `claude --plugin-dir ~/Projects/floorhands/claude-plugin` for trial, then a local marketplace entry for permanent use.
- Not enabled globally by default: the server must not start in every unrelated session.

## Claude skills the agents call

- FE REVIEWER: `react-typescript-standards`, `security-review`, `design-craft`, `seo-audit`.
- BE REVIEWER: `security-review`, `fastapi-standards` or `spring-boot-standards` (per stack), `dpdp-compliance`.
- AWS REVIEWER: `security-review`, `code-review`.
- E2E TESTER: `hawkscan:hawkscan` once configured; otherwise scripted browser flows.
- ARCHITECT: `superpowers:brainstorming`, `product-management:write-spec`.
Skills are listed in the roster; a skill that is not installed is skipped with a note.

## Phases

1. **Core (this spec's scope):** repo, server, runner, tiers, worktrees, UI, roster, `/floorhands` skill + hook, tests.
2. **GitHub** (via `gh`): PRs, issues, CI status; Approve can open a PR.
3. **AWS read-only:** CloudWatch/IAM/config/cost via a read-only profile.
4. **Issue tracker** (Linear or Jira, chosen then): Support Engineer raises and tracks issues.

## Testing

- `node:test` unit tests: router/plan parsing, tier → CLI flag mapping, command allow-list, worktree
  manager (against a temp git repo), start/stop idempotency.
- Smoke script against a throwaway repo: a review task reads files and calls a skill; a reviewer's write is
  denied; a build task produces a diff in a worktree; Approve merges, Reject cleans up.
- UI checked in the browser pane at desktop and phone width.

## Risks / unknowns (to be verified on a logged-in machine; see README Known limits #8)

- Headless `claude -p` honouring `--allowedTools` patterns for Bash and the `Skill` tool.
- Whether plugin skills load inside `claude -p` sessions; if not, the roster inlines the checklist instead.
- A single `claude -p` per turn has start-up latency; acceptable, revisit if it hurts.

## Out of scope for phase 1

Connectors, pushing/deploying, multi-user access, 3D scene.

- Projects whose root holds several git repos: start floorhands from inside one repo.
- Authentication on the local port (recommended follow-up: per-run token). The server is bound to 127.0.0.1 with Host/Origin checks only.

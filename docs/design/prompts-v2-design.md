# Prompts v2 — design

Status: approved by the owner on 2026-10-13 (stack facts detected by the server; owner notes stored outside the repo; validated by a real evaluation on seeded sample projects).

## Problem

The v0.1.0 agent prompts are ~100-word generic checklists. They do not tell an agent how to review (method, severity rubric, evidence rules), what to produce (a consistent, scannable report), how to find the changes under review, or how to use the project's stack. They name Claude skills that often do not resolve, and one told the tester to run a command its tier denies (`npx`). Each agent also has to rediscover the project's stack on every turn.

## Goals

1. Every agent has a real method, a severity rubric, and a required report format; reviewers cite `file:line` evidence and say what they did **not** check.
2. Agents are told the project's stack and which verification commands exist, deterministically, without spending a turn to find out.
3. The owner can give standing guidance per project (for example regional data-protection rules, SEO, conventions) without baking it into the tool and without a hostile repository being able to plant instructions.
4. Prompts never depend on a Claude skill being installed; skills are an optional bonus, named only when relevant to the detected stack.
5. The improvement is **measured**, not assumed.

## Non-goals

No change to the permission model (`server/tiers.js` is not touched). No new agent roles, no connectors, no auth token, no UI redesign beyond one status line for notes.

## Design

### 1. Stack facts (`server/stack.js`)
`detectStack(root)` reads a bounded set of files (never executes anything, never follows symlinks out of the repo, file size caps) and returns facts in a **closed vocabulary**: languages (from `git ls-files` extension counts), frameworks (allow-listed names such as `react`, `vite`, `next`, `express`, `nestjs`, `spring-boot`, `fastapi`, `django`, `flask`), package manager (from lockfiles), which of the commands floorhands can run exist (`lint`, `build`, `format`, `typecheck`, `test`, `e2e` as booleans derived from `package.json` script **names**), test tooling (`jest`, `vitest`, `playwright`, `cypress`, `pytest`, `junit`), infrastructure (`terraform`, `cdk`, `cloudformation`, `serverless`, `docker`, `kubernetes`, `github-actions`), monorepo layout (workspaces / pnpm / turbo / nx and package directories, capped), and standards tags used to pick skills. Script **commands** and any free text from the repository are never copied into facts, because the repository is untrusted input; only validated tokens are. `renderFacts(facts)` produces a short block (<= 2.5 KB) that is shown to agents framed as data.

### 2. Owner notes (`server/notes.js`)
`~/.floorhands/projects/<project-hash>/notes.md` (same hash as the worktree folder; `FLOORHANDS_HOME` overrides the base). Capped at 4 KB, control characters removed, closing tags neutralised. Shown to every agent as the **owner's standing guidance**, clearly separated from facts, with the rule that notes can never widen an agent's permissions or override its tier. `floorhands notes` prints the path and current contents (creating nothing); the owner edits the file with their own editor. `/api/state` reports `{ path, bytes }` and the UI shows one line ("Project notes: N bytes — edit <path>") so the feature is discoverable.

### 3. Prompt assembly (`server/roster.js`, `server/prompt.js`)
The system prompt is composed **per task**, in this order: common rules → tier note → project facts (data) → owner notes (guidance) → relevant skill hints → role body. Roster `skills` entries may be strings (as today) or objects `{ "name": ..., "alt": [...], "when": [fact tags] }`; a hint is rendered only when its `when` tags intersect the detected facts (no `when` = always). Skill names are hints with fallback checklists in the role body, never requirements. Total system prompt <= 24 KB (asserted in tests). The Architect's plan prompt also receives the facts so routing reflects reality (no tester step if there is no test script; infrastructure-only repo → AWS reviewer).

### 4. Handoffs (`server/orchestrator.js`)
For steps that run in a task worktree, the step prompt states the branch's starting commit and how to see the change under review (`git diff <base>..HEAD`, `git log`, `git status`). Prior output stays framed as data (unchanged). The prompt tells agents to verify earlier agents' claims against the code before repeating them.

### 5. The prompts (`agents/prompts/*.md`)
Common rules: evidence over assertion; severity rubric (Critical / High / Medium / Low with concrete definitions); finding format; "what I checked / did not check"; verdict vocabulary; how to treat prior output and unavailable tools or skills; efficiency (where to start reading, how to search with the Grep/Glob tools since shell readers are denied); safety rules (secrets, no destructive actions, tier limits). Role bodies: Architect (routing rules, plan quality, plan JSON example), reviewers (stack-specific checklists with search recipes), builders (workflow, scope discipline, verification, summary template), SRE, support (ticket template), tester (strategy, commands, report format). Each prompt states only commands its tier can run.

### 6. Prompt lint (`test/prompts.test.js`)
Every prompt: has the required sections; stays under its size cap; names no personal data or specific project; and every command it tells the agent to run (inline code that starts with `npm`, `git`, `npx`, …) is allowed for the agent's tier according to `server/tiers.js`, and none is denied. This would have caught the `npx playwright test` mismatch.

### 7. Evaluation (`scripts/eval-prompts.mjs`, `eval/`)
Small sample repositories with **planted** problems (the lite run used the first three) (expected findings kept outside the fixture trees): an Express API (SQL injection, IDOR, hard-coded secret, no rate limit, error leakage), a React app (`dangerouslySetInnerHTML`, token in `localStorage`, accessibility gaps, effect leak), an AWS/Terraform + GitHub Actions repo (wildcard IAM, public bucket, open SSH, public RDS, static keys in CI, `pull_request_target` checkout), a FastAPI service (SQL concatenation, missing authorization dependency). The harness runs the v0.1.0 prompts and the new prompts through the real runner path on the same fixtures and scores recall of planted issues, citation quality (`file:line` present), format compliance, hallucination checks (claimed `file:line` that does not exist), plus turns and cost. Hard cap on real calls. Results are committed as `docs/prompt-eval.md`.

## Risks

- A hostile repository tries to inject through facts → closed vocabulary only; tests with hostile `package.json`/`pom.xml`/names.
- A hostile repository tries to inject through notes → notes live outside the repository.
- Longer prompts cost more tokens per turn → size caps, and the evaluation reports cost per turn.
- Prompts get better on fixtures but worse in general → fixtures cover three stacks in the lite run (the FastAPI one is designed but not built); results reported honestly, including losses.

# Prompt evaluation: v0.1.0 prompts against the rewritten prompts

This is the "lite" evaluation from `docs/design/prompts-v2-design.md` §7: three small sample projects with planted problems, three
reviewer roles, two variants, two runs each. It answers one question: do the rewritten prompts find at least as many planted problems as the
v0.1.0 prompts? It does not say the prompts are good in general. Read the caveats before quoting any number.

Raw results (every report, every score, redacted): `docs/prompt-eval.json`. Everything here can be recomputed from that file with
`node scripts/eval-prompts.mjs --render docs/prompt-eval.json` (tables) or `--rescore docs/prompt-eval.json` (re-score the stored reports;
no calls).

## Headline

- Real calls: 12 (cap 14), no errors, no rate limits. One round; the rule for a second round (a revision when `new` has lower mean recall
  than `old`) was not triggered, so no prompt was changed.
- Recall of planted problems, strict rule, mean of two runs: `rbe` old 92% / new 100%; `rfe` old 100% / new 100%; `raws` old 100% / new 100%.
- This is a ceiling effect, not a win: both variants found almost every planted problem. The planted problems are textbook ones in tiny
  projects. The result says the rewrite did not lose recall; it cannot say the rewrite finds more.
- Where the variants differ is the shape of the report: 6 of 6 new reports follow the required format (0 of 6 old reports do, as the old
  prompts never asked for it), new rates planted problems closer to their planted rating (fewer over-rated findings), and lists fewer
  unplanted findings.
- Cost: the new system prompt is about 6-7 times larger (13 KB against 2 KB) but total input tokens per run were not higher (about 77-78 k
  against 66-109 k, cached input included), output tokens were 8-27% higher, wall time about the same except `raws` (+8 s).
- One real defect surfaced: the new prompts tell the agent to "read `.env.example`", but the read tier denies `**/.env*`, which matches it.
  See "Findings about the product".

## Method

**Variants.** Both go through the real path: a system prompt composed for the role, then `runAgent` (`server/runner.js`) with the agent's
read-tier flags (`buildClaudeArgs`), the scrubbed environment and `FLOORHANDS_AGENT=1`, with the real, logged-in `claude` CLI
(2.1.296) and its default model.

- `old` is the v0.1.0 prompt set: `eval/baseline/agents/` holds unmodified copies of v0.1.0's `agents/roster.json` and
  `agents/prompts/*.md` (from `main`), and `eval/baseline/legacy-compose.mjs` reproduces v0.1.0's `composeSystem` (intro, tier note, the old
  `Claude skills to call with the Skill tool when they apply: ...` line, body). A unit test extracts `main` with `git archive`, imports that
  checkout's own `loadRoster` and asserts every agent's `system` is byte-identical to the harness's legacy composition, and that the
  baseline files equal the ones on `main`. `old` gets no project-facts block and no owner notes (v0.1.0 had neither).
- `new` is the working tree at the time of the run: `loadRoster` parts composed by `buildSystem` with the facts from `detectStack` on the
  throwaway repository, and no owner notes.

**User prompt**, identical for both: the orchestrator's step frame without the worktree/base lines,

```text
<step>
{task}
</step>

Owner's original request:
<task>
{task}
</task>
```

**Cells.** Each fixture is copied into a fresh temp directory (`mkdtemp` under the OS temp dir, real path), `git init`, committed, and the
agent runs there. Order is run 1 of every role and variant, then run 2, so a cap or rate limit would leave the comparison balanced. The
harness refuses real calls without `--yes-spend-quota`, stops at `--max-calls` (default 14) and after a rate-limit error.

| Role | Fixture | Task given |
|---|---|---|
| `rbe` | `express-api` | Review the back-end for security and reliability problems. |
| `rfe` | `react-app` | Review the front end for security, correctness, accessibility and performance problems. |
| `raws` | `aws-infra` | Review the infrastructure and the deploy workflow. |

## Fixtures (planted problems: 24)

Plain files under `eval/fixtures/<name>/`, at most 12 files each, nothing labelled (a test checks that none of `vulnerab`, `planted`,
`insecure`, `FIXME`, `TODO`, `bug` appears, and that there are no e-mail addresses, home paths or secret-shaped strings). The expected
findings live outside the trees, in `eval/expected/<name>.json`: id, planted rating, file, line range, and case-insensitive regexes a
correct finding would match.

| Fixture | Files | Planted | Planted problems (rating) |
|---|---|---|---|
| `express-api` (Express + pg; `lint`, `test` scripts, working test) | 12 | 6 | SQL injection by concatenation in search (Critical); IDOR on `GET /orders/:id` (High); hard-coded JWT secret with fallback (High); no rate limit on `/login` (Medium); stack trace in the error handler response (Medium); `Math.random()` reset tokens (High) |
| `react-app` (React + Vite + TS; `lint`, `build`, `test`) | 12 | 9 | `dangerouslySetInnerHTML` of API HTML (High); token in `localStorage` (High); `target="_blank"` without `rel` (Low); inputs without labels (Medium); `img` without `alt` (Medium); `useEffect` missing a dependency (Medium); interval never cleared (Medium); whole-lodash import (Low); API key in a `VITE_` variable used client-side (High) |
| `aws-infra` (Terraform + GitHub Actions) | 9 | 9 | `Action "*"` / `Resource "*"` on the app role (Critical); public-read S3 ACL, no encryption (High); SSH from `0.0.0.0/0` (High); public RDS with no backups (High); unpinned provider and module (Low); static `AWS_ACCESS_KEY_ID` secrets (High); `pull_request_target` checking out the PR head (Critical); PR title interpolated in `run:` (High); actions pinned to `@main` (Medium) |

The planted ratings are the author's judgement. The spec asked for "Critical/High" on the XSS item; it is planted as High, and a reviewer
saying Critical counts as sane.

## Scoring

Pure functions in `scripts/eval-lib.mjs`, unit-tested with canned reports in `test/eval-lib.test.js`.

- **Finding blocks.** A block starts at a line beginning with a rubric label in brackets or bold (`[High] ...`, `**[High]** ...`,
  `### [High] ...`) or a label followed by a separator (`High - ...`); or, for the v0.1.0 report shape, under a severity-only heading
  (`## Critical`, `**High**`) each numbered item or bullet is a block with that heading's severity. A block ends at the next block or heading.
- **FOUND** (strict, the rule asked for): a block matches any `anyOf` regex of the planted issue AND cites the expected file (full path, or
  a shorter path suffix that is unique in the fixture; `alsoFiles` lists a few accepted alternatives) or the 150 characters before or after
  the block do. **Content only** is the same without the file condition, reported next to the strict number. 1 of the 95 strict hits
  was credited through the surrounding text rather than the block itself.
- **Recall** = found / planted; **Critical/High recall** over the planted items rated Critical or High.
- **Citation validity**: of the `path:line` (or `path:a-b`) citations in the whole report, the share where the file exists in the fixture
  (absolute paths and unique bare names are resolved) and the line is within the file. **Hallucinated** = the others.
- **Severity sanity**: of the found planted Critical/High items, the share rated Critical or High. The rating attributed to an item is that
  of the block most about it (names the file, matches most of the issue's patterns, then matches the fewest planted issues).
  **Over-rated / under-rated**: the share of found items rated above / below the planted rating (informational: the plants are judgement
  calls).
- **Extra findings**: blocks matching no planted issue, Info excluded. Reported, not errors: they can be real (see the spot-checks).
- **Format compliance** (a requirement of the new prompts only): first non-empty line is `VERDICT:` followed by approve,
  approve-with-changes or block; severity labels are from the rubric; a `What I did not check` section exists. The v0.1.0 prompts asked for
  a verdict and for saying what was not checked, but not for a `VERDICT:` first line or a section with that name, so old is reported next to
  new, not held to it.
- **Cost**: the runner exposes tool calls and `usage` but not `total_cost_usd`, and nothing in `server/` was changed to add it, so cost is
  tool calls, input and output tokens, system prompt size and wall time. Input tokens are `input + cache creation + cache read` summed over
  the turns of a run.

## Results (one round, n = 2 per cell; mean, with min-max in brackets)

Recall and report quality

| Role | Variant | Recall (strict) | Recall (content only) | Critical/High recall | Severity sanity | Over-rated | Under-rated | Extra findings | Format compliant |
|---|---|---|---|---|---|---|---|---|---|
| `rbe` | old | 92% (83-100%) | 100% | 100% | 100% | 82% (80-83%) | 0% | 11 (11-11) | 0 of 2 |
| `rbe` | new | 100% | 100% | 100% | 100% | 8% (0-17%) | 0% | 3.5 (3-4) | 2 of 2 |
| `rfe` | old | 100% | 100% | 100% | 100% | 67% (56-78%) | 0% | 6 (6-6) | 0 of 2 |
| `rfe` | new | 100% | 100% | 100% | 83% (67-100%) | 39% (22-56%) | 17% (11-22%) | 2 (2-2) | 2 of 2 |
| `raws` | old | 100% | 100% | 100% | 100% | 50% (44-56%) | 0% | 11 (9-13) | 0 of 2 |
| `raws` | new | 100% | 100% | 100% | 86% | 39% (33-44%) | 22% | 1.5 (0-3) | 2 of 2 |

Citations: old 78 citations, new 70, across all runs. Hallucinated (missing file or line past the end of the file): 0 in both variants, so
citation validity is 100% everywhere. The old reports do have a not-checked section in 5 of 6 runs (headed "Not checked") and rubric labels
in 6 of 6; the `VERDICT:` first line is the part the old prompts never asked for (0 of 6, new 6 of 6).

Cost

| Role | Variant | Tool calls | Output tokens | Input tokens (incl. cache) | System prompt (bytes) | Wall time (s) |
|---|---|---|---|---|---|---|
| `rbe` | old | 12 | 3080 (3031-3128) | 89114 | 2139 | 30 (29-30) |
| `rbe` | new | 10.5 (10-11) | 3337 (3146-3527) | 78227 | 13277 | 30 (29-31) |
| `rfe` | old | 12 (11-13) | 2923 (2741-3104) | 109151 (87680-130622) | 1992 | 29 (27-32) |
| `rfe` | new | 10 | 3451 (3429-3473) | 77111 | 13618 | 30 |
| `raws` | old | 11 | 3087 (2917-3257) | 66170 | 1995 | 28 (26-30) |
| `raws` | new | 10 | 3921 (3811-4031) | 78366 | 13418 | 36 (35-37) |

### Per-issue matrix

Each cell lists run 1, run 2: the rating the reviewer gave when the issue was found (C Critical, H High, M Medium, L Low) or `-` when it
was missed. Every issue was found in every run except one: `rbe` old, run 2, `login-no-rate-limit`.

| Role | Planted issue | Planted | old | new |
|---|---|---|---|---|
| `rbe` | sql-injection-search | Critical | C, C | C, C |
| `rbe` | idor-order-by-id | High | C, C | H, H |
| `rbe` | hardcoded-jwt-secret | High | C, C | C, H |
| `rbe` | login-no-rate-limit | Medium | H, - | M, M |
| `rbe` | stack-trace-leak | Medium | H, H | M, M |
| `rbe` | math-random-reset-token | High | C, C | H, H |
| `rfe` | html-injection-xss | High | C, C | C, C |
| `rfe` | token-in-localstorage | High | H, C | C, H |
| `rfe` | blank-without-rel | Low | H, H | M, M |
| `rfe` | inputs-without-labels | Medium | H, M | M, M |
| `rfe` | img-without-alt | Medium | M, M | L, L |
| `rfe` | effect-missing-dependency | Medium | H, H | H, M |
| `rfe` | interval-never-cleared | Medium | H, H | H, M |
| `rfe` | whole-lodash-import | Low | M, L | L, L |
| `rfe` | api-key-in-vite-env | High | C, H | M, H |
| `raws` | iam-wildcard | Critical | C, C | H, H |
| `raws` | s3-public-unencrypted | High | C, C | C, C |
| `raws` | ssh-open-to-world | High | C, C | H, H |
| `raws` | rds-public-no-backups | High | H, C | C, H |
| `raws` | unpinned-versions | Low | H, H | M, M |
| `raws` | static-aws-keys | High | H, H | H, C |
| `raws` | pull-request-target-head | Critical | C, C | C, C |
| `raws` | title-injection-in-run | High | H, H | M, M |
| `raws` | actions-pinned-to-branch | Medium | H, H | H, M |

### What the numbers say

- Recall: new >= old on every role, so no revision round was run. The only miss in 24 cells is in an old run, and in that run the report
  does say "No rate limiting on /login, /password-reset ..." but names no file near it, so the strict rule scores it a miss and the
  content-only rule a hit. The honest reading is: 6 of 6 new runs found every planted problem, and 5 of 6 old runs did on the strict rule (6 of 6 on content only).
- Severity: old rates nearly everything at or above the planted rating (82% / 67% / 50% of found items over-rated). New is closer to the
  planted rating, and is the only variant that ever rates a planted High below High (rfe: the API key in a `VITE_` variable, once rated
  Medium because it may be a browser-restricted key; raws: the PR-title injection, twice rated Medium). Whether those lower ratings are
  more correct or less is a judgement the harness cannot make; the new report says why (the key may be browser-scoped).
- Extras: old reports list 6-13 findings the plants do not cover, new 0-4. The new prompts cap the report at 12 findings and ask for
  evidence per finding, so the shorter tail is expected. Extras are not graded as noise (see spot-checks).
- Format: 6 of 6 new reports start with `VERDICT:`, use the rubric labels and have `What I did not check`; 0 of 6 old reports start with
  `VERDICT:` (they open with "Verdict: Do not ship", in bold).

## Spot-checks of raw reports

Read in full: old `rbe` runs 1 and 2, old `rfe` run 1, new `rfe` run 1, new `raws` run 2.

- Old reports are accurate and detailed: numbered findings under `## Critical` / `## High` ... headings with `file:line` citations that
  check out (every cited line exists). They also contain real extras: no order-items table and no transaction around order creation,
  unbounded lists, no CSP, a `lint` script that is only `node --check`, an ESLint 9 flag that no longer exists.
- New reports are in the required shape. In the new `rfe` run 1 the XSS and the `localStorage` token are one Critical finding that
  names both lines; the effect finding covers the stale `id` and the uncleared interval and includes a corrected hook. The finding about the
  API key says it may be browser-restricted and asks the owner, which is why it is rated Medium. In the new `raws` run 2 the findings are
  specific (`pull_request_target` plus head checkout gives a PR author the AWS keys, the S3 ACL may fail on new buckets) and the extras
  are real (no remote state, no approval gate on `terraform apply -auto-approve`).
- Scoring accuracy: combined blocks exist (for example one new `raws` finding covers static keys and the fork-PR path, another covers
  script injection and unpinned actions). A combined block is credited for every planted issue it mentions, which is generous; both
  variants get the same generosity, and the severity attributed to an issue prefers the block most about it. In one spot-check a keyword
  in a passing mention ("the XSS above" in a Low finding about CSP) would have attributed a Low rating to the XSS item; the
  attribution rule was changed to prefer the block matching most of the issue's patterns (see the history below).

### Scorer history (disclosed because it changed numbers)

The first scoring pass showed old `rbe` run 1, `rfe` runs 1 and 2 and `raws` runs 1 and 2 at 0 of N found. That was a scorer bug, not a
result: the v0.1.0 prompts produce findings as numbered items under `## Critical` headings, and the first block splitter only understood
`[High] ...` lines. All 12 stored reports were then re-scored with a splitter that understands both shapes (`--rescore`, no new calls),
and two smaller scorer changes followed from reading reports: attribute the rating to the block most about the issue, and drop one over-broad
pattern (any `${{ github.event` in a block was crediting the PR-title injection to the `pull_request_target` finding). The first-pass numbers
are kept in the JSON as `firstPass` for each run. The re-score moved one old cell down (`rbe` run 2: 6 to 5 strict hits) as well as raising
five old cells from 0. No claude call was repeated or added. The scorer is deterministic and the harness cannot see which variant it is
scoring, but it was corrected after seeing results; treat the numbers as "scored with a scorer fixed on these reports".

## Caveats

- **n = 2 per cell, 3 fixtures, 24 planted problems.** Differences of one cell are noise. Nothing here supports a claim about statistical
  significance.
- **Ceiling effect.** Both variants find (nearly) everything, so recall cannot rank them. Fixtures with subtler problems (a
  missing check on one of many routes, an authorization bug that needs a second file, a wildcard hidden in a data source) would be needed
  to discriminate.
- **Same model family writes the reports and the grader.** The fixtures, the expected findings and the regexes were written by the same
  model family that writes the reports (no second model, no human grader), so a systematic blind spot would be shared. Regexes can miss a paraphrase (the content-only column is the check for the file
  rule, not for paraphrase) and can credit a keyword in a passing mention.
- **Planted ratings are one person's judgement.** "Over-rated" and "under-rated" are relative to them, and the model's stricter or looser
  rating may be right.
- **Automated scoring is not read-through.** Five of 12 reports were read in full; the other seven were checked only through the scorer and
  the extras and rating listings.
- **Default model and settings of the installed CLI.** A different model, or the same model on another day, can behave differently.
- **Cost is partial**: no `total_cost_usd` from the runner. Token numbers include cached input, whose price differs from fresh input.
- **Order and caching.** Runs alternated old and new within a role, but the CLI's prompt cache and any user-level setup (plugins, skills the
  `old` prompts name and the `new` prompts only name when facts match) were not controlled. One old `rfe` run called the Skill tool; its
  input tokens are the highest in the table.

## What the fixtures do not cover

No Python or Java back end, no monorepo, no larger repository (a dozen files fit in one agent's reading budget, so the search recipes and
effort rules of the new prompts are barely exercised), no secrets committed to the repository, no prompt-injection text planted in the
code, no review of a change (a diff against a base commit), no owner notes, no review where the correct answer is "approve".

**Not evaluated here:** the builders (`fe`, `be`), the tester (`e2e`), the support engineer (`sup`), the SRE (`sre`) and the Architect
(`arch`). The Architect and a builder were smoke-tested separately; that is a check that they work, not a measurement of quality.

## Findings about the product (not about scoring)

- **`.env.example` is denied to the agents but named in the new prompts.** `agents/prompts/rbe.md` and `rfe.md` (Search recipes) say
  "Read `.env.example`, never `.env*` (denied)", but the read tier denies `Read(**/.env*)` in `server/tiers.js`, and that pattern matches
  `.env.example`. All 4 new `rbe` and `rfe` reports list it as unread (three say access was denied, one says it was not opened); none
  of the old reports mention it. The reports stay honest, but a call was
  wasted and the key-scope question (is `VITE_NEWS_API_KEY` public?) went unanswered. The fix is a prompt edit (stop recommending
  `.env.example`) or a narrower deny rule (an owner decision in `tiers.js`); neither was made here because recall did not drop.
- Total input tokens did not rise with the larger system prompt (cached input and fewer tool calls), but output tokens did, by about
  8-27%.

## Reproduce

```text
node scripts/eval-prompts.mjs --dry-run                     # matrix, call estimate, prompt sizes; no calls
node scripts/eval-prompts.mjs --yes-spend-quota --repeat 2 --max-calls 14 --out docs/prompt-eval
node scripts/eval-prompts.mjs --render docs/prompt-eval.json
```

A second round for one role: `--roles rbe --repeat 2 --max-calls 4 --append --label "round 2"`.

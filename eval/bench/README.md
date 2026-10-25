# The undo-the-fix benchmark

This answers two questions with evidence that does not depend on us or on a model grading its own family's work:

1. Does floorhands find and fix real bugs?
2. Does the nine-agent pipeline beat one plain agent with the same permissions, and is it worth what it costs?

The earlier prompt evaluation (`docs/prompt-eval.md`) used three small projects that a model wrote, with an answer key that the same model family wrote, and both prompt versions found nearly everything. This benchmark replaces that with real bugs and real tests.

## How an instance works

An instance is a real fix commit from an open source project, preferably one linked from a GitHub security advisory (GHSA) or the OSV database.

1. `prepare` clones the project at the fix commit, puts the fixed source files back to their state before the fix, and hides the tests the fix added. The result is saved as a fresh repository with one commit and no history, so `git log` cannot reveal the fix.
2. `run` gives the agents a task. A **review** task names the area to review. A **build** task describes the bug the way an issue would, without the fix.
3. `grade` applies the agent's patch plus the hidden upstream tests and runs the project's own test command. Solved means the whole suite passes, the hidden tests included. Those tests were written by the project's maintainers, so neither we nor a model decide what counts as fixed.
4. For review tasks, a **blind judge** decides which findings are valid and which match the bug. Use a model from a different family to the one that wrote the reports. The judge sees the reports shuffled and without the variant's name. Before trusting its precision numbers, label about 50 findings yourself and run `calibrate`. A Cohen's kappa below 0.6 means the judge is not trustworthy.

## Building the corpus

Put it in `eval/bench/corpus.json`, in the format of [`corpus.example.json`](corpus.example.json). The example is a placeholder, not a real advisory.

- 20 to 50 instances: about two thirds security fixes linked to advisories, the rest ordinary bug fixes with a test.
- JavaScript or TypeScript projects, because floorhands runs `npm` scripts.
- The source change is 50 lines or fewer, and the fix adds or changes a test.
- The added test fails before the fix and passes after it. Check each instance once by hand, or with `grade` on the untouched buggy state (it must fail).
- `npm test` must run offline once dependencies are installed (`prepare --install` installs them with `--ignore-scripts`). Agents can never install packages or reach the network.
- Prefer advisories published after the model's training data ends, and record `published`. Report results before and after that date separately, because a model may remember a famous fix.
- List about 10 ids under `holdout`. Never look at them while changing prompts. `run --holdout` and `report --holdout` use only them.

## Running it

```sh
node scripts/bench.mjs prepare --corpus eval/bench/corpus.json --work ~/bench --install
node scripts/bench.mjs run --corpus eval/bench/corpus.json --work ~/bench --variant floorhands --task build --runs 5 --yes-spend-quota
node scripts/bench.mjs run --corpus eval/bench/corpus.json --work ~/bench --variant single --task build --runs 5 --yes-spend-quota
node scripts/bench.mjs grade --corpus eval/bench/corpus.json --work ~/bench --docker --judge-cmd ./my-judge
node scripts/bench.mjs calibrate --work ~/bench --labels my-labels.json
node scripts/bench.mjs report --work ~/bench
```

- `run` spends quota. Run 1 of every instance goes first, so a run you stop early still compares the variants fairly. The model settings in `~/.floorhands/models.json` apply, and every row records the models that actually ran and the cost.
- `grade --docker` runs the projects' tests in `node:22` with no network. `--trust-local` runs them on your machine. They are third-party code, so prefer Docker.
- The judge is any executable. It reads `{"bug": "...", "findings": ["...", ...]}` on standard input and prints `{"valid": [true, ...], "matchesBug": [false, ...]}`, one entry per finding.
- `report` prints, per task and variant, the mean with a 95% bootstrap interval. The interval resamples instances, not runs, because five runs of one bug are not five independent results. It also prints floorhands minus the single agent, paired by instance, and the judge's calibration.

## What to report

- Solved rate for build tasks and recall for review tasks, each with its interval.
- Precision of review findings, only with a calibrated judge.
- Mean cost per run and cost per solved task, per variant.
- Approval rate: approved tasks out of the tasks that reached a decision. In the benchmark this needs a person to decide on the diffs. In real use it comes from the decisions recorded in `.floorhands/tasks/`.
- Everything that could flatter the result: how instances were chosen, which failed to prepare, and the numbers before and after the training cutoff.

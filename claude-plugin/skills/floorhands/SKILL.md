---
name: floorhands
description: Start, stop or open floorhands, the local office of engineering agents (architect, reviewers, builders, SRE, support, tester) for the current project. Use when the user types /floorhands:floorhands, says "start floorhands", "open the office", or wants the team to review, build or test something.
---

# floorhands

floorhands runs as a small local server per project. Use the `floorhands` command through the Bash tool; report its output to the user as it is printed.

Claude Code lists this skill as `/floorhands:floorhands` (plugin skills are prefixed with the plugin name). The word after it is the argument.

Match the request to one command, run it from the project folder, and show the result:

- `/floorhands:floorhands start`, no argument, or a plain request like "start floorhands": run `floorhands start`. It prints the URL of the office. Tell the user to open it. If they ask you to open it for them, run `floorhands open`.
- `status`: run `floorhands status`.
- `stop`: run `floorhands stop`.
- `on`: run `floorhands enable`. From now on the office starts by itself whenever a Claude Code session opens in this project.
- `off`: run `floorhands disable`.

Run exactly these commands with no extra flags or arguments. The command exits with code 2 and prints its help for an unknown command, an unknown flag or an unexpected argument. `start --if-enabled` exists only for the automatic session hook; do not use it yourself.

If the shell says `floorhands: command not found`, tell the user to run `scripts/install.sh` once from their floorhands checkout (see the README), then try again. Do not try to start the server any other way.

Notes for the user, only when relevant:
- Work the team builds appears in the office as a diff waiting for Approve or Reject. Nothing reaches the working copy before approval.
- Build and test tasks need the folder to be a git repository with at least one commit. If the project folder holds several repositories, start floorhands from inside the one to work on.
- To give the team standing guidance for this project (conventions, regional rules, accessibility level), the user runs `floorhands notes`, which prints where the notes file lives; the README explains how to create it. Do not write that file for them unless they ask.
- Never paste secrets into a task; the team is told not to read .env files, but task text is stored in .floorhands/ in the project.

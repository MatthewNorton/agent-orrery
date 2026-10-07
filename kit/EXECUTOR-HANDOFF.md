# Executor handoff — feeding a kit to ANY external agent

What to give Codex (or any coding agent: another Claude, Gemini CLI, whatever
can read files and run commands in this repo). You never hand over the whole
kit's text — you hand over ONE pointer prompt; the kit is self-contained on
disk and the agent reads the rest itself.

## The prompt (fill in the one blank)

> Work in the repository root (`agent-orrery`).
> First read `kit/README.md` (the "How the app works" section and the frozen-
> files rules), then execute the kit contract at **`<KIT_CONTRACT_PATH>`**,
> following it exactly. Hard rules:
> - Modify ONLY the files the contract explicitly unfreezes. Never touch
>   `package.json`, `assets/`, the mockup PNGs, or any `kit/` grader.
> - No new dependencies, no bundlers, no network calls in app code.
> - Verify with the contract's own grade script AND `node kit/grade.mjs`
>   (regression) until BOTH pass. Do not claim success without running them.
> - Need an asset that doesn't exist? Procedural fallback in code + an entry
>   in `kit/ASSET-REQUESTS.md`. Never generate or download art.
> - Done: write `kit/EXECUTOR-REPORT.md` (what changed per file, grader
>   output, known gaps). Stuck or contract seems wrong: write
>   `kit/BLOCKED.md` with the specific question and STOP — don't improvise.

`<KIT_CONTRACT_PATH>` = the pending kit's contract file after its numbered stub
has been distilled.

## Command shapes

Codex CLI, interactive (recommended first time — you watch it work):
```
cd <repo root>
codex        # then paste the prompt above
```
Codex CLI, headless (flag names vary by version — check `codex --help`):
```
codex exec --full-auto "<the prompt above>"
```
Claude Code equivalent (what kit-runner does):
```
claude --model claude-opus-5-5 --permission-mode acceptEdits -p "<the prompt above>"
```

## Division of labor — what the fed agent does NOT cover

The external agent is the **executor** only. The **runner** duties stay with
you (or a Claude kit-runner session):

1. Baseline before feeding: kit's gate FAILs cleanly, `node kit/grade.mjs`
   PASSes. Wrong baseline → fix that first, feed nothing.
2. After it reports done: rerun both gates yourself, eyeball `.shots/*.png`
   against the repo-root mockups per `kit/RUBRIC.md`, run the app
   (`npm start`) for the live check.
3. On failure: feed back ONLY the failed check IDs + grader output + what's
   wrong in which screenshot. Cap the loop (5 iterations), then stop.
4. On pass: archive the kit's contract + report + logs into `kit/done/<name>/`
   and update the status board (`kit/README.md`) and `kit/todo/README.md`.

## Current state (update when it changes)

Nothing is feedable today. Kits 01–08, 10, 11, 13 and 14 are done (see
`kit/README.md`); `kit/todo/09-ship-assets-gen.md` is a stub and
`kit/todo/12-standalone-installer.md` is parked. To make the next feedable
kit, run `/distill` on a stub to produce its contract and grader, then use
this handoff.

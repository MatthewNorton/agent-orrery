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
claude --model claude-opus-5-5 --effort high --permission-mode acceptEdits -p "<the prompt above>"
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
4. On pass: move the kit's gate into `kit/done/<name>/`, put the executor
   report in the PR description, delete the contract and report, and update the
   status board (`kit/README.md`) and `kit/todo/README.md`.

## Current state (update when it changes)

Feedable: kit 15, `<KIT_CONTRACT_PATH>` =
`kit/todo/15-procedural-worlds/CONTRACT.md` (distilled 2026-11-01; its W0 runs
`npm ci` and the `--killswitch` gate before any app code; Opus 5.5 at high
effort throughout, no fallback model). Kits 01–08, 10,
11, 13 and 14 are done (see `kit/README.md`); `kit/todo/09-ship-assets-gen.md`
and `kit/todo/16-idle-cap-and-glyphs.md` are stubs and
`kit/todo/12-standalone-installer.md` is declined. To make another feedable
kit, run `/distill` on a stub to produce its contract and grader, then use
this handoff.

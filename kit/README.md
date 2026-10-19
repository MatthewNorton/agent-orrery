# Agent Orrery — kit folder

Status board for all kit work on this app. One glance answers: what shipped,
what's live tooling, what runs next, what's parked.

## Layout

```
kit/
  README.md            <- this status board
  SPEC.md              LIVE  renderer contract — update it when the app evolves
  RUBRIC.md            LIVE  visual/functional acceptance reference
  grade.mjs            LIVE  mechanical regression gate — run after ANY renderer change (synthetic profile; --real for yours)
  run-gates.mjs        LIVE  every gate one line each and npm test once (--static: the quick file-check set CI runs); logs in .shots/gates/
  ASSET-REQUESTS.md    LIVE  intake for missing-asset wants (never source ad hoc)
  EXECUTOR-HANDOFF.md  LIVE  copy-paste prompt for handing a kit to ANY agent (Codex etc.)
  done/                one gate per finished kit; contracts and reports are in git history
    attention/         PASS 2026-07-21 — needs-attention detection + UI
    polish-pass/       PASS 2026-07-21 — dense labels, backdrop, pointer flow
    packaging/         PASS 2026-07-21 — Windows Desktop/Start shortcuts
    galaxy-grouping/   PASS 2026-07-21 — workspace galaxies + Graveyard
    multi-provider/    PASS 2026-07-21 — Claude, Codex, generic Signal ships
    history-playback/  PASS 2026-07-21 — indexed replay + LIVE return
    agent-control/      PASS 2026-07-21 — LIVE-only safe terminal action
    project-tasks/      PASS 2026-07-22 — per-project GOALS.md checklists
    project-search/     PASS 2026-07-22 — ranked universe project search
    ship-assets-pack/   PASS 2026-07-26 — manifest-backed CC0 provider hulls
    structural-cleanup/ PASS 2026-09-28 — app.js split into AUR.app modules, path-safety.js
    main-split/         PASS 2026-10-01 — main.js split into bootstrap + modules, no module-level state
  todo/                pending work, in intended order (see todo/README.md)
    09-ship-assets-gen.md stub — ready to distill from the landed manifest
    12-standalone-installer.md declined — developers install with npm run setup
```

## Status

| Kit | State | Gate |
|---|---|---|
| Renderer MVP | **DONE** — PASS all layers, 3 iterations, Opus | `node kit/grade.mjs` (now the permanent regression gate; must stay green) |
| 01 Needs-attention | **DONE** — PASS 2026-07-21; archived in `done/attention/` | `node kit/done/attention/grade-attention.mjs` |
| 02 Renderer polish pass | **DONE** — PASS 2026-07-21; archived in `done/polish-pass/` | `node kit/done/polish-pass/grade-polish.mjs` |
| 03 Windows launch shortcuts | **DONE** — PASS 2026-07-21; archived in `done/packaging/` | `node kit/done/packaging/grade-packaging.mjs` |
| 04 Galaxy grouping | **DONE** — PASS 2026-07-21; archived in `done/galaxy-grouping/` | `node kit/done/galaxy-grouping/grade-galaxies.mjs` |
| 05 Multi-provider agents | **DONE** — PASS 2026-07-21; archived in `done/multi-provider/` | `node kit/done/multi-provider/grade-providers.mjs` |
| 06 History playback | **DONE** — PASS 2026-07-21; archived in `done/history-playback/` | `node kit/done/history-playback/grade-history.mjs` |
| 07 Agent control | **DONE** — PASS 2026-07-21; archived in `done/agent-control/` | `node kit/done/agent-control/grade-control.mjs` |
| 08 Ship assets pack | **DONE** — PASS 2026-07-26; 10 CC0 hulls + manifest integration archived in `done/ship-assets-pack/` | `node kit/done/ship-assets-pack/grade-ships.mjs` |
| 09 Generated ship assets | **STUB** — Kit 08 manifest contract landed; ready to distill | none yet |
| 10 Project tasks | **DONE** — PASS 2026-07-22; archived in `done/project-tasks/` | `node kit/done/project-tasks/grade-tasks.mjs` |
| 11 Project search | **DONE** — PASS 2026-07-22; archived in `done/project-search/` | `node kit/done/project-search/grade-search.mjs` |
| 12 Standalone installer | **DECLINED** 2026-10-13 — the users are developers; `npm run setup` is the install path. Notes kept in `todo/12-standalone-installer.md` | none |
| 13 Structural cleanup | **DONE** — PASS 2026-09-28; `app.js` split into `AUR.app` modules, shared `src/main/path-safety.js`; §2.6 (observable-driven dispose) withdrawn, poll documented; archived in `done/structural-cleanup/` (Phase 5 of `docs/PUBLIC-RELEASE-TASKS.md`) | `node kit/done/structural-cleanup/grade-structure.mjs` (sweep: `node kit/run-gates.mjs`) |
| 14 Main-process split | **DONE** — PASS 2026-10-01; `main.js` (2217 lines) is a 47-line bootstrap over `app-context.js`, `window.js`, `replay-control.js`, `ipc/*`, `harness/*`; zero module-level `let` in `src/main`; `main.js` unfrozen; project-tasks gate widened to the `src/main` layer (owner-authorized); archived in `done/main-split/` | `node kit/done/main-split/grade-main-split.mjs` (sweep: `node kit/run-gates.mjs`) |

## How the app works (context for any executor)

Electron + Babylon.js desktop app. The main process passively tails Claude
Code and Codex JSONL sessions without owning either provider; optional generic
Signal directories contribute metadata-only liveness. Canonical working
directories merge providers into one project. Projects become solar systems,
live sessions starships, subagents drones, and verified file edits grow
planets (top-level project dirs). A read-only indexed source replays Claude and
Codex history while the live Tracker continues in the background. A narrow
LIVE-only action can open Windows Terminal at a trusted project directory
without starting an agent. A separate global IDEAS queue lets the user capture
a to-do, assign it to a live project, and start Codex on the exact tagged
`GOALS.md` item; successful completion moves it to Ready for review. Views:
clustered galaxy universe map → solar system → planet, matching the three
mockup PNGs in the repo root.

Frozen for executors: the **Frozen files** bullet in `CLAUDE.md` is the one authoritative list.

Gates check behaviour and shape, never file hashes: no gate pins a SHA of any file, ever (the
last pins were retired on 2026-10-13, PR #29). A frozen file is protected by review, not by a hash.

## Runner loop (kit-runner, applies to any kit here)

1. Baseline: the kit's own gate must FAIL cleanly; `node kit/grade.mjs` must
   PASS. Anything else → stop, report; don't fix the harness or app yourself.
2. Executor: headless Claude Code session in the repo root on Opus (matt's
   standing preference; never below Sonnet-class), `--permission-mode
   acceptEdits`, prompt = the kit's contract/teacher prompt.
3. Grade: kit gate + `node kit/grade.mjs` regression + visual check of
   `.shots/*.png` against the mockups per `RUBRIC.md` + the kit's live check.
4. On failure: follow-up to the executor with ONLY failed check IDs + grader
   output + precise visual notes. Max 5 iterations total; may escalate the
   executor to Fable (`claude-fable-5`) if iterations stall; `kit/BLOCKED.md`
   or a failed 5th iteration → stop and escalate to the user with artifacts.
5. On pass: move the kit's gate into `done/<kit-name>/`, paste
   `kit/EXECUTOR-REPORT.md` (executor summary + runner verification) into the PR
   description and delete it with the contract, then update this status board,
   `todo/README.md` and the gate table in `run-gates.mjs`.

Asset rule: executors never generate/download art — procedural fallback in
code + an entry in `ASSET-REQUESTS.md`.

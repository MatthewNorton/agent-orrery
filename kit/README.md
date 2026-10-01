# Agent Universe Lite — kit folder

Status board for all kit work on this app. One glance answers: what shipped,
what's live tooling, what runs next, what's parked.

## Layout

```
kit/
  README.md            <- this status board
  SPEC.md              LIVE  renderer contract — update it when the app evolves
  RUBRIC.md            LIVE  visual/functional acceptance reference
  grade.mjs            LIVE  mechanical regression gate — run after ANY renderer change
  ASSET-REQUESTS.md    LIVE  intake for missing-asset wants (never source ad hoc)
  EXECUTOR-HANDOFF.md  LIVE  copy-paste prompt for handing a kit to ANY agent (Codex etc.)
  done/                executed kits, archived with their reports and logs
    renderer-mvp/      PASS 2026-07-18 — the entire src/renderer (see its README)
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
  todo/                pending work, in intended order (see todo/README.md)
    09-ship-assets-gen.md stub — ready to distill from the landed manifest
    12-standalone-installer.md parked — wanted later, not yet
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
| 12 Standalone installer | **PARKED** — wanted later, not yet; see `todo/12-standalone-installer.md` | none yet |
| 13 Structural cleanup | **DONE** — PASS 2026-09-28; `app.js` split into `AUR.app` modules, shared `src/main/path-safety.js`, `kit/repin.mjs`; §2.6 (observable-driven dispose) withdrawn, poll documented; archived in `done/structural-cleanup/` (Phase 5 of `docs/PUBLIC-RELEASE-TASKS.md`) | `node kit/done/structural-cleanup/grade-structure.mjs --full` |
| 14 Main-process split | **READY** — distilled 2026-10-01; split main.js into app-context/window/replay-control/ipc/harness, no module-level state; contract `todo/14-main-split.md` | `node kit/todo/grade-main-split.mjs --full` (fails cleanly until built) |

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

Frozen for executors: `src/main/*` (except where a kit contract explicitly
unfreezes it, e.g. 01-attention and `tracker.js`), `src/preload.js`,
`package.json`, `assets/*`, mockups. Renderer files under `src/renderer/` are
fair game per the active kit's contract.

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
5. On pass: `kit/EXECUTOR-REPORT.md` (executor summary + runner verification),
   then archive the kit's inputs + report + logs into `done/<kit-name>/` and
   update this status board and `todo/README.md`.

Asset rule: executors never generate/download art — procedural fallback in
code + an entry in `ASSET-REQUESTS.md`.

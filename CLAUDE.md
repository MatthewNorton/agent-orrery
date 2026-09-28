# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Electron + Babylon.js desktop app that passively visualizes Claude Code / Codex agent sessions as a persistent universe: projects are solar systems (grouped into galaxies), live sessions are starships, subagents are drones, and verified file edits grow planets. The main process tails provider JSONL transcripts; it never owns or launches the observed agents (two narrow LIVE-only exceptions: opening the host terminal at a project, and starting Codex on a tagged `GOALS.md` item from the IDEAS queue). Windows and macOS are first-class; Linux runs the viewer but has no terminal control. See `docs/MACOS-LAUNCH.md` for the platform matrix.

## Commands

- `npm start` — run the app
- `npm test` — all tests (Node's built-in runner)
- `node --test test/ship-assets.test.js` — single test file
- `node kit/grade.mjs` — mechanical renderer regression gate; run after ANY renderer change, must stay green
- `npm run shots` — headless screenshot mode; writes `.shots/*.png` for visual comparison against the three mockup PNGs in the repo root (gold samples: `3.universe-map-view.png` → universe, `2.solar-system-view.png` → system, `1.planet-view.png` → planet)
- `npm run ships:generate` — regenerate procedural ship GLB assets
- No lint/typecheck tooling; plain JavaScript only.

## Hard constraints (from kit/SPEC.md — read it before renderer work)

- **Frozen files** — read but never modify unless an active kit contract explicitly unfreezes them: `src/main/main.js`, `src/main/tracker.js`, `src/main/replay-source.js`, `src/preload.js`, `package.json` (no new dependencies, no script changes), `assets/*`, the mockup PNGs.
  - Security exception: `src/main/main.js`, `src/main/tracker.js`, `src/main/replay-source.js`, and `src/main/provider-adapters.js` were edited under the security hardening PR #24 and its follow-ups (`docs/PUBLIC-RELEASE-TASKS.md` Phase 1). Security fixes are the one standing exception to the freeze; they must be minimal and carry a `// Security` comment at the edit site.
- Renderer is plain JS with classic `<script>` tags — **no ES modules** (file:// CORS), no TypeScript, no bundler, no npm installs. Renderer code attaches to the single `window.AUR` namespace; script load order in `src/renderer/index.html` provides globals.
- Babylon loads from local UMD bundles in `node_modules` (`BABYLON`, `BABYLON.GUI` globals). Renderer is fully offline — zero network requests, system font stack only.
- `contextIsolation` is on; the renderer's only channel to the main process is the `window.AU` bridge defined in `src/preload.js` and documented in `kit/SPEC.md` §3.
- One `BABYLON.Engine` for the app lifetime; each view builds its own `BABYLON.Scene` and disposes it on view switch.
- New renderer files stay under ~600 lines. `app.js` (~3500), `scene-universe.js` (~970) and `scene-system.js` (~620) are known exceptions tracked in `docs/PUBLIC-RELEASE-TASKS.md` Phase 5; do not grow them further.
- Never generate or download art ad hoc — use a procedural fallback in code and log the want in `kit/ASSET-REQUESTS.md`.

## Architecture

**Main process (`src/main/`)** — `main.js` bootstraps the window, switches the active event source, and wires IPC. `tracker.js` tails Claude/Codex transcript JSONL (plus metadata-only "Signal" directories via `provider-adapters.js`) and derives ships/planets/events; `replay-source.js` is a read-only indexed history source that reconstructs the same event vocabulary for playback while the live Tracker keeps running in the background. `terminal-launcher.js` / `agent-launcher.js` implement the two LIVE-only actions; `goals.js` + `root-tasks.js` + `root-task-coordinator.js` + `task-runs.js` back the global IDEAS queue; `project-vcs-status-*` + `github-metadata-provider.js` supply per-project git/GitHub status. `window-security.js` hardens web contents and validates trusted frames.

**Renderer (`src/renderer/`)** — three Babylon views registered as `AUR.views.<name>(engine, data, ctx) => { scene, update(eventBatch), dispose() }`: `scene-universe.js` (galaxy map) → `scene-system.js` (one project) → `scene-planet.js` (planet close-up), orchestrated by `app.js`. `util.js` copies `fnv1a`/`mulberry32` from `tracker.js` so seeds agree between processes. `galaxy-layout.js` and `polish-math.js` are pure UMD/Node-testable helpers — keep them dependency-free.

**Kit workflow (`kit/`)** — this repo is developed via "kits": self-contained contract + rubric + grading-script packages executed by agents (see the `/distill` skill and `kit-runner` agent). `kit/README.md` is the status board; `kit/SPEC.md` is the live renderer contract (update it when the app evolves); `kit/RUBRIC.md` is the visual acceptance reference; completed kits are archived under `kit/done/<name>/` with their own grade scripts, pending ones live in `kit/todo/`. Each done kit's gate (e.g. `node kit/done/attention/grade-attention.mjs`) must keep passing.

**Test-mode flags** — `main.js` supports `--shots`, `--polish-test`, `--provider-test`, `--history-test`, `--control-test`, each with an `--<name>-output=` path, driving fixture-based headless runs used by the grade scripts.

Additional docs live in `docs/` (design direction, roadmap, playback, multi-provider, agent control, Windows launch).

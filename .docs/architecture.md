# Architecture — Agent Orrery

How the codebase is structured **today**, written for someone who finds it confusing.

- Snapshot: `main` after the 2026-10-07 cleanup (PRs #14–#22) and the fleet-v2 ships (2026-10-10).
  PR #11 had already split the old 2,217-line `src/main/main.js` into small files. Older docs
  still quote line numbers in the old `main.js`; §5.3 maps those to where the code lives now.
  The October 2026 file split then turned `tracker.js` and `replay-source.js` into façades over
  `src/main/live/`, `src/main/history/` and the shared `src/main/universe/`, and split the large
  renderer files; every source file is now 400 lines or fewer.
- Visual map: open [`architecture.html`](architecture.html) in a browser (works offline from disk).
  Deep links: `#trace=live|replay|ideas|terminal|git`, `#node=<id>` (e.g. `#node=tracker`), `#hot`, `#theme=light|dark`.

---

## 1. The one-minute version

Agent Orrery is an Electron desktop app that **watches** Claude Code and Codex work and
draws it as a universe. It never controls the agents (two narrow exceptions in §3).

- The **main process** (Node, `src/main/`) polls the transcript files that Claude Code and Codex
  already write to disk, turns them into a model (projects, ships, planets), and pushes small
  **event batches** to the window.
- The **preload** (`src/preload.js`) is the only door between the two halves: it exposes
  26 methods on `window.AU`, each a named IPC channel `au:*`.
- The **renderer** (browser, `src/renderer/`) keeps a copy of the model in one shared state
  object and draws it with Babylon.js in one of three views: universe → solar system → planet.

| Thing on screen | Comes from |
|---|---|
| Solar system (sun) | A project folder (one per working directory) |
| Galaxy | A group of projects that share a parent folder |
| Starship | A live Claude (neon purple) / Codex (blue) session, red on a local model; its hull class rises with the edits it has made |
| Drone | A Claude subagent (`Task`/`Agent` tool call) |
| Planet | A top-level folder inside the project; it grows as the agent edits files in it |
| Halo / "needs you" | A ship waiting on a question or permission |

```mermaid
flowchart LR
  subgraph Disk["Your machine — inputs"]
    CL["~/.claude/projects/*/*.jsonl"]
    CX["~/.codex/sessions/**/*.jsonl"]
    SG["Signal folders (providers.json)<br/>metadata only"]
    PD["Project folders<br/>dirs → planets · GOALS.md · .git"]
  end
  subgraph Main["Main process — src/main (Node)"]
    TR["tracker.js + live/<br/>live model, polls every 1–3 s"]
    RS["replay-source.js + history/<br/>history index for playback"]
    SV["services<br/>IDEAS queue · GOALS.md · git/GitHub · launchers"]
    WR["wiring<br/>app-context · replay-control · ipc/* · window"]
  end
  BR["preload.js<br/>window.AU — 26 methods"]
  subgraph Ren["Renderer — src/renderer (browser)"]
    APP["app/boot.js + app/*.js<br/>shared state · panels · routing"]
    VW["scene/universe / system / planet<br/>Babylon.js views"]
  end
  UD[("userData JSON<br/>universe-state · root-tasks · task-runs")]
  EXT["External programs<br/>git · gh · wt.exe / Terminal · codex"]
  CL --> TR
  CL --> RS
  CX --> TR
  CX --> RS
  SG -->|stat only| TR
  PD --> TR
  TR -->|events| WR
  RS -->|events| WR
  SV --> WR
  SV <-->|read / write| PD
  SV -->|spawn| EXT
  TR <-->|every 60 s| UD
  SV <--> UD
  WR <-->|"IPC au:*"| BR
  BR <--> APP
  APP -->|"update(batch)"| VW
```

---

## 2. App versus scaffolding

Most files in this repo are **not** the app. Only `src/` ships; everything else is art, tests,
or the record of how the app was built.

| Folder | Files | Size | What it is | Part of the running app? |
|---|---|---|---|---|
| `src/main/` + `src/preload.js` | 74 | 11,274 lines JS (1,345 of it test harness) | Main process | **Yes** (harness runs only with test flags) |
| `src/renderer/` | 47 | 7,622 lines JS + 3,060 HTML/CSS | Renderer (UI + 3D) | **Yes** |
| `assets/` | 347 | ~280 MB | Planet / skybox / asteroid textures, ship GLBs | Partly — see §8 |
| `test/` | 60 | 10,437 lines | Unit tests (`npm test`, Node's runner, no Electron) | No |
| `kit/` | 23 | — | Kit tooling, two stubs **and** 13 regression gate scripts | No (gates matter, see §9) |
| `scripts/` | 11 | — | One-step setup (run by the root `Install Agent Orrery.cmd` / `.command`), ship generators, the fleet-v2 LOD build, launcher shortcuts, demo screenshots and their synthetic profile, a VCS UI lab | No |
| `docs/` | 16 | — | Feature notes and plans; four of them are also gate fixtures | No |
| root | 11 | — | README, CLAUDE.md, SECURITY, LICENSE, `package.json` + lockfile, git config, 3 mockup PNGs | Mockups are the visual "gold samples" |
| `.github/` | 4 | — | CI (Ubuntu + Windows), Dependabot, CODEOWNERS, PR template | No |

Generated and ignored: `.shots/` (gate screenshots), `kit/done/*/output/` (old gate evidence),
`node_modules/`.

---

## 3. Where does feature X live?

Start here when you want to change something. Paths under "Main process" are relative to
`src/main/`, paths under "Renderer" to `src/renderer/`.

| Feature | Main process | IPC (`au:*`) | Renderer | Persisted in | Checked by |
|---|---|---|---|---|---|
| **Universe / system / planet views** | `tracker.js` façade over `live/` (`live/system-view.js` `getSystem`, `getPlanet`); `ipc/register.js` | `snapshot`, `system`, `planet`, push `events` | `app/boot.js` (routing), `app/store.js` (`applyEvent`), `scene/universe/*.js`, `scene/system/*.js`, `scene/planet.js`, `scene/common.js` | `universe-state.json` (build counts) | `kit/grade.mjs`, polish + galaxy gates |
| **Galaxy grouping** | `universe/galaxy.js`: `deriveGalaxy` (live), `historyGalaxy` (history) | in project payload | `galaxy-layout.js`, `scene/universe/galaxies.js` | — | `grade-galaxies.mjs` |
| **Claude / Codex / Signal providers** | `provider-adapters.js`, `live/claude-source.js`, `live/codex-source.js`, `live/signal-source.js`, `live/claude-records.js`, `live/provider-records.js` | push `events` | `util.js` (`PROVIDERS`, colours), `ship-assets*.js` (hulls) | `providers.json` (Signal config, read-only) | `grade-providers.mjs` |
| **Needs-attention + desktop notifications** | `live/attention.js` `classifyAttention` | `ship-updated` events | `app/store.js` `maybeNotifyAttention`, `app/chrome.js` agent list, halos in scenes | — | `grade-attention.mjs` |
| **History playback (scrubber)** | `replay-source.js` façade over `history/`, `replay-control.js` | `replay`, push `replay-state` | `app/playback.js` (history bar), `app/replay.js` (epochs, `issueReplay`), `app/history-metrics.js` (test metrics) | nothing (index in memory) | `grade-history.mjs`, `replay-source.test.js` |
| **Open Terminal** (LIVE only) | `ipc/terminal.js` → `terminal-launcher.js`, `path-safety.js` | `open-terminal` | `app/project/control.js`, `app/agent-focus.js` | — | `grade-control.mjs`, `terminal-launcher.test.js` |
| **Open folder / GitHub link** | `ipc/register.js` (inline handlers) | `open`, `open-external` | `app/project/control.js` | — | — |
| **Per-project TASKS panel** (`GOALS.md`) | `ipc/tasks.js` → `goals.js` | `tasks-get`, `task-add`, `task-set-done`, `task-remove`, push `tasks-changed` | `app/project/tasks.js` | `<project>/GOALS.md` | `grade-tasks.mjs`, `task-runs.test.js` |
| **IDEAS queue → start Codex** (LIVE only) | `ipc/root-tasks.js` → `root-task-coordinator.js`, `root-tasks.js`, `task-runs.js`, `agent-launcher.js`, `goals.js` | `root-tasks-get`, `root-task-create/remove/assign/retry`, push `root-tasks-changed` | `app/ideas.js`, `app/ideas-list.js` | `root-tasks.json`, `task-runs.json`, `GOALS.md` | 4 unit test files |
| **Project search + ALL PROJECTS list** | — (renderer only) | — | `search-core.js`, `app/project/search.js`, `app/project/directory.js` | — | `grade-search.mjs` |
| **Git / GitHub status markers** | `vcs-status/`: `collector.js` (git), `github-metadata-provider.js` (`gh`), `service.js` (cache), `controller.js` (wiring) | push `project-vcs-status-changed` (from `replay-control.js`), `vcs` field in snapshot | `components/project-vcs-status.js` + `.css` | memory only | 5 `project-vcs-status*` tests |
| **Find a moved project** (settings dialog) | `ipc/project-paths.js` → `project-paths.js` | `project-paths-scan`, `project-path-locate`, `project-path-apply` | `app/project/settings.js` | `universe-state.json` `pathOverrides` | **none** |
| **First-person ship cockpit** | — | — | `app/agent-focus.js`, `scene/system/view.js` `focusShip`, `scene/system/focus.js`, `assets/*.png` | `localStorage` | `agent-focus-hologram.test.js` (source text) |
| **Ship 3D models** | `live/ships.js` + `live/builds.js`, `history/apply-record.js` (each ship's `builds` count); `universe/ships.js` `createShipRecord` | `builds` on every ship | `ship-assets.js` (manifest, rank → hull), `ship-assets-hulls.js` (far / near file per view), `ship-assets-api.js` (`AUR.ships`, in-place `refresh`) + `assets/ships/manifest.json` + GLBs; `app/store.js` `refreshShipHulls` | — | ship tests, `grade-ships.mjs` |
| **Headless test modes** (`--shots`, `--polish-test`, …) | `flags.js`, `harness/fixtures.js`, `harness/driver.js`, `harness/metrics.js`, `harness/modes/*.js` | `debug-view`, `debug-ready` | `app/boot.js` `handleDebugView` | `.shots/`, `result.json` | every dynamic gate |

---

## 4. The process boundary

```
 main process (Node, full OS access)          preload            renderer (sandboxed browser)
 ─────────────────────────────────────        ───────            ────────────────────────────
 ipcMain.handle('au:snapshot', …)   ◄── invoke ── AU.snapshot()    ◄── app/boot.js boot
 webContents.send('au:events', …)   ── push  ──► AU.onEvents(cb)   ──► app/boot.js routeEvents
```

- Window (`window.js`): `contextIsolation`, no Node integration, `sandbox: true`.
- `window-security.js` blocks navigation and pop-ups and allows only the `notifications`
  permission, only for the main frame at the exact `file://` URL.
- Every `ipcMain.handle` (all registered in `ipc/register.js`) checks `trustedMainFrame` from
  `ipc/guards.js` first. Exception: `au:debug-ready` (renderer → main `send`, used only by
  `harness/modes/shots.js`) has no frame check.
- Transcript content is **untrusted input**: the parsers in `transcripts/` reduce records to
  structural signals (a Claude tool call still carries its file path and up to 60 characters of
  pattern or description, which live shows as `detail`), `isLocalProjectPath` rejects UNC /
  device paths before any `stat`, and every spawn uses `shell: false`.

### IPC contract (all 26 bridge methods)

| `window.AU` method | Channel | Kind | Main-process handler | Used by (renderer) |
|---|---|---|---|---|
| `snapshot` | `au:snapshot` | invoke | `ipc/register.js` → `replay-control.js` | `app/boot.js` |
| `getSystem` / `getPlanet` | `au:system` / `au:planet` | invoke | `ipc/register.js` | `app/boot.js`, `scene/system/view.js` |
| `openProject` / `openExternal` | `au:open` / `au:open-external` | invoke | `ipc/register.js` | `app/project/control.js`, `app/agent-focus.js` |
| `openTerminal` | `au:open-terminal` | invoke | `ipc/terminal.js` | `app/project/control.js` |
| `tasksGet`, `taskAdd`, `taskSetDone`, `taskRemove` | `au:tasks-get`, `au:task-*` | invoke | `ipc/tasks.js` | `app/project/tasks.js` |
| `rootTasksGet`, `rootTaskCreate/Remove/Assign/Retry` | `au:root-task*` | invoke | `ipc/root-tasks.js` | `app/ideas.js` |
| `projectPathsScan/Locate/Apply` | `au:project-path*` | invoke | `ipc/project-paths.js` | `app/project/settings.js` |
| `replay` | `au:replay` | invoke | `replay-control.js` | `app/playback.js` |
| `onEvents` | `au:events` | push | `app-context.js` | `app/boot.js` |
| `onReplayState` | `au:replay-state` | push | `replay-control.js` | `app/boot.js` |
| `onTasksChanged` / `onRootTasksChanged` | `au:tasks-changed` / `au:root-tasks-changed` | push | `app-context.js` / `ipc/root-tasks.js` | `app/boot.js` |
| `onProjectVcsStatusChanged` | `au:project-vcs-status-changed` | push | `replay-control.js` | `app/boot.js` |
| `onDebugView` / `debugReady` | `au:debug-view` / `au:debug-ready` | push / send | `harness/modes/*.js` | `app/boot.js` (test modes only) |

The `on*` wrappers return nothing, so listeners cannot be removed.

---

## 5. Main process (`src/main/`)

### 5.1 How it starts

`main.js` is 47 lines. Everything shared lives on one plain object, `ctx`:

```js
const flags = readFlags(process.argv);                 // flags.js
const ctx = createAppContext({ flags, fixtures });     // app-context.js: ctx = { win, tracker, replaySource,
                                                       //   activeSource, streamEpoch, services…, harness, start, cleanup }
ctx.replay = createReplayControl(ctx);                 // replay-control.js
ctx.ipc = { terminal, tasks, rootTasks, projectPaths } // ipc/*.js factories, each given ctx
registerIpc(ctx, { replay: ctx.replay, ...ctx.ipc });  // ipc/register.js: the 20 ipcMain.handle calls
app.whenReady() → ctx.win = createWindow(ctx); ctx.start();   // window.js, then build every service
app.on('before-quit', ctx.cleanup);
```

`ctx.start()` builds the Tracker, ReplaySource, git / GitHub status, IDEAS queue and launchers,
then subscribes to Tracker and ReplaySource `events` and forwards the active one as `au:events`.
No file under `src/main` keeps mutable state at file scope; each factory keeps its own state
in a closure, and anything shared is a field of `ctx`.

### 5.2 Module map

**Services** — what the app actually does:

| File | Lines | Shape | Job | Requires |
|---|---|---|---|---|
| `tracker.js` | 180 | `class Tracker extends EventEmitter` | Façade over `live/`: creates the one live model, runs the four timers, exposes `snapshot` / `getSystem` / `getPlanet`. `tracker.projects`, `.ships`, `.files` are the model's Maps; `tracker.model` is the model itself | `live/*`, `universe/galaxy`, `universe/public-shape` |
| `live/model.js` | 86 | factory | `createLiveModel`: the LiveModel object every live module takes as its first argument (maps, counters, time windows, read limits) | `live/state-file` |
| `live/events.js` | 53 | functions | Event queue (`seq` assigned on queue), feed, one flush per scan / poll / sweep | — |
| `live/attention.js` | 81 | functions | `classifyAttention` | `live/events`, `universe/public-shape` |
| `live/state-file.js` | 50 | functions | Load / save `universe-state.json` | `shared/atomic-write` |
| `live/system-view.js` | 139 | functions | `getSystem`, `getPlanet` from the project folder on disk | `universe/planets`, `universe/public-shape`, `build-buckets`, `path-safety`, `shared/hash` |
| `live/projects.js` | 235 | functions | Project registry: path → id, display path, folder still exists | `provider-adapters`, `shared/hash`, `universe/public-shape`, `live/events`, `live/state-file` |
| `live/ships.js` | 180 | functions | Ships and drones: spawn, pending tool calls, departure | `provider-adapters`, `universe/ships`, `universe/public-shape`, `live/events` |
| `live/builds.js` | 60 | functions | One verified edit → one build in its top-level folder | `build-buckets`, `path-safety`, `live/events` |
| `live/claude-source.js` | 150 | functions | Finds Claude projects and which transcripts to tail | `provider-adapters`, `universe/public-shape`, `live/projects`, `live/ships` |
| `live/claude-records.js` | 193 | functions | Reads new Claude text, applies each record | `transcripts/claude`, `provider-adapters`, `path-safety`, `live/projects`, `live/ships`, `live/builds` |
| `live/codex-source.js` | 219 | functions | Finds Codex rollouts, one tail per session (also across `archived_sessions/`) | `provider-adapters`, `transcripts/codex`, `shared/hash`, `live/projects`, `live/ships` |
| `live/signal-source.js` | 71 | functions | Signal ships from file stats only | `signal-sources`, `provider-adapters`, `live/projects`, `live/ships` |
| `live/provider-records.js` | 200 | functions | Codex / Signal bytes → `adaptLine` signals → ships, pending calls, builds | `provider-adapters`, `live/projects`, `live/ships`, `live/builds` |
| `replay-source.js` | 359 | `class ReplaySource extends EventEmitter` | Façade over `history/`: indexes all history once at startup; rebuilds the universe at any timestamp, from the nearest seek checkpoint | `history/*` |
| `history/options.js` | 107 | functions | Source roots and limits | — |
| `history/index-builder.js` | 295 | functions | Finds every transcript and records its time range from bounded head / tail reads | `provider-adapters`, `transcripts/*`, `shared/hash`, `history/jsonl`, `history/order` |
| `history/record-reader.js` | 267 | functions | Per-source cursors over the indexed byte ranges; 256 KB chunks, a read index into the cursor buffer, a shared pool of open handles | `provider-adapters`, `history/jsonl`, `history/historical-line` |
| `history/jsonl.js` | 73 | functions | Line helpers shared by the index and the reader | — |
| `history/historical-line.js` | 120 | functions | One line → history signals (Codex through `adaptLine`, parsed once; Claude read by history's own rules) | `provider-adapters`, `transcripts/*`, `history/jsonl` |
| `history/order.js` | 74 | functions | Deterministic record order: compare function and heap | — |
| `history/merge.js` | 78 | functions | k-way merge of the cursors | `history/order`, `history/record-reader` |
| `history/apply-record.js` | 156 | functions | Reduces one merged record into the historical model | `provider-adapters`, `transcripts/fields`, `shared/hash`, `universe/public-shape` |
| `history/model.js` | 314 | factory | The historical universe, its event batches, `getSystem` / `getPlanet` | `history/apply-record`, `universe/*`, `transcripts/fields`, `build-buckets`, `path-safety`, `shared/hash` |
| `history/checkpoint-plan.js` | 79 | function | Up to 32 checkpoint times that split the indexed bytes evenly | — |
| `history/checkpoints.js` | 277 | factory | In-memory seek checkpoints: capture, restore, a 64 MB budget, and a guard that redoes a seek cold when a checkpoint is stale | `history/checkpoint-plan`, `history/model` |
| `universe/galaxy.js` | 157 | functions | `deriveGalaxy` (live), `historyGalaxy` (history) | `provider-adapters`, `shared/hash` |
| `universe/planets.js` | 27 | function | `proceduralSystem` | `shared/hash` |
| `universe/ships.js` | 33 | function | `createShipRecord` | — |
| `universe/public-shape.js` | 79 | functions | `liveProject` / `liveShip`, `historyProject` / `historyShip`: the shapes the renderer receives | `universe/galaxy`, `provider-adapters`, `shared/hash` |
| `build-buckets.js` | 55 | functions | Build counts per top-level folder, one bucket per folder under a case-insensitive root | `path-safety` |
| `signal-sources.js` | 76 | functions | Which files a `providers.json` watch entry covers (listings and stats only) | `provider-adapters`, `shared/hash` |
| `provider-adapters.js` | 368 | pure functions | Provider names, project path keys, the cross-provider tool vocabulary (`classifyTool`), Signal config, `adaptLine` | `transcripts/codex`, `transcripts/fields` |
| `transcripts/codex.js` | 237 | pure functions | One Codex record → structural signals; rollout ownership; parent thread id | `transcripts/fields` |
| `transcripts/claude.js` | 116 | pure functions | One Claude Code record → structural facts for both models; Claude's own tool vocabulary (`claudeTool`) | `transcripts/fields` |
| `transcripts/model.js` | 31 | pure functions | Is a session on a local model: Codex `model_provider`, Claude `message.model` | — |
| `transcripts/fields.js` | 52 | functions | `safeId`, `safePath`, `plainObject`, `firstTrimmed` for transcript fields | — |
| `task-runs.js` | 397 | `class TaskRunTracker` | Matches a launched Codex run to its ship; ticks the `GOALS.md` box when done | `goals` |
| `root-task-coordinator.js` | 386 | `class RootTaskCoordinator` | Assign / retry flow: write goal → start run → launch Codex | `goals` |
| `goals.js` | 352 | functions | Line-preserving `GOALS.md` parse / write (temp file + rename, refuses symlinks) | — |
| `root-tasks.js` | 344 | `class RootTaskStore` | IDEAS queue records and phase transitions → `root-tasks.json` | — |
| `agent-launcher.js` | 391 | factory → `{launch}` | Finds the native `codex` binary on PATH, spawns `codex exec` detached | `path-safety` |
| `vcs-status/github-metadata-provider.js` | 301 | factory | Open-PR counts via `gh api graphql` (batches of 25, 5 min cache) | — |
| `vcs-status/collector.js` | 284 | factories | Runs `git status --porcelain=v2` + remote lookup (4 s timeout) | — |
| `vcs-status/service.js` | 307 | factory | 15 s cache, ≤4 concurrent reads, merges GitHub data | — |
| `terminal-launcher.js` | 206 | factory → `{open}` | `wt.exe -d <cwd>` (Windows) or `open -a Terminal` (macOS); Linux unsupported | `path-safety` |
| `project-paths.js` | 162 | functions | Bounded folder search for a moved project (depth 6, 12k dirs, 8 s) | — |
| `vcs-status/controller.js` | 127 | factory | Tracker events → debounced (400 ms) per-project git refresh | — |
| `path-safety.js` | 121 | functions | Shared "is this a canonical local path / inside that path" checks, `relativeInside` | `provider-adapters` |
| `window-security.js` | 55 | functions | Navigation / pop-up / permission lockdown, trusted-frame check | — |
| `shared/bounded-process.js` | 96 | function | One child-process runner with a timeout and output cap (git and gh) | `shared/values` |
| `shared/atomic-write.js` | 28 | function | Temp file + rename write (`GOALS.md`, IDEAS and run stores, `universe-state.json`) | — |
| `shared/hash.js` | 47 | functions | `fnv1a`, `hex8`, `mulberry32` (the renderer keeps its own copies) | — |
| `shared/values.js` | 25 | functions | `boundedInteger`, `ownString`, `bufferValue` | — |
| `shared/ids.js` | 23 | functions | `validProjectId`, `validGoalId`, control-character check | — |

**Wiring** — connects the services to the window:

| File | Lines | Job |
|---|---|---|
| `main.js` | 48 | Bootstrap (§5.1) |
| `flags.js` | 45 | Parses `argv` into a frozen flags object |
| `app-context.js` | 250 | Creates `ctx`; `start()` builds and wires every service; `cleanup()` tears down on quit |
| `user-data.js` | 39 | First run under the Agent Orrery name: copies the state files from the old `agent-universe-lite` folder |
| `replay-control.js` | 227 | LIVE ↔ REPLAY switching, `au:replay` commands, `streamEpoch`, replay-state and git-status pushes, visible snapshot |
| `window.js` | 62 | Creates and hardens the `BrowserWindow`, loads `index.html` |
| `ipc/register.js` | 77 | The one table of `ipcMain.handle` registrations; small handlers inline |
| `ipc/guards.js` | 12 | `validProjectId`, `trustedMainFrame` |
| `ipc/terminal.js` | 81 | Open Terminal checks, `liveProjectCwd` (also used by tasks and IDEAS) |
| `ipc/tasks.js` | 87 | `GOALS.md` handlers |
| `ipc/root-tasks.js` | 112 | IDEAS handlers, `root-tasks-changed` push |
| `ipc/project-paths.js` | 244 | Moved-project scan / locate / apply, one-time tokens, folder dialog |
| `preload.js` | 41 | `window.AU` bridge |

**Test harness** — only runs with a test flag (1,345 lines): `harness/fixtures.js` (179),
`harness/driver.js` (263), `harness/metrics.js` (190), `harness/modes/{shots,control,history,provider,polish}.js`
(117 / 153 / 205 / 98 / 140).

**Types** — `src/types/contract.d.ts` declares the shapes that cross the bridge (`AUBridge`, `Project`,
`Ship`, the event union, every result); `preload.js`, the IPC handlers and the renderer's `AU`
callers are checked against it by `npm run typecheck` (§9).

### 5.3 Where the old `main.js` went

Older docs (for example `docs/PUBLIC-RELEASE-TASKS.md`) quote line numbers in the pre-split
`main.js`. Use this table to find that code today.

| Old `main.js` lines | What | Now in |
|---|---|---|
| 28–51 | CLI flags, output paths | `flags.js` |
| 52–82 | File-scope state (`win`, `tracker`, `activeSource`, `streamEpoch`, …) | fields of `ctx` (`app-context.js`) |
| 84–242 | Test fixtures | `harness/fixtures.js` |
| 244–286 | Quit cleanup | `app-context.js` `ctx.cleanup()` |
| 288–461 | Playback plumbing, `au:replay` handler | `replay-control.js` |
| 463–480 | `validProjectId`, `trustedMainFrame` | `ipc/guards.js` |
| 481–533 | Open Terminal, `liveProjectCwd` | `ipc/terminal.js` |
| 535–651 | `GOALS.md` task handlers | `ipc/tasks.js` |
| 653–731 | IDEAS handlers | `ipc/root-tasks.js` |
| 733–930 | Moved-project recovery | `ipc/project-paths.js` |
| 932–984 | `createWindow` — the window | `window.js` |
| 985–1107 | `createWindow` — building every service | `app-context.js` `ctx.start()` |
| 1109–1162 | `ipcMain.handle` registrations | `ipc/register.js` |
| 1164–1270 | `--shots` mode | `harness/modes/shots.js` |
| 1272–1668 | Harness helpers | `harness/driver.js`, `harness/metrics.js` |
| 1670–2213 | Control / history / provider / polish modes | `harness/modes/*.js` |
| 2215–2217 | `app.whenReady` / quit hooks | `main.js` |

### 5.4 The live pipeline: from a transcript line to pixels

Everything is **polling**; nothing uses `fs.watch`.

| Timer (`tracker.js` 33–36, 60–63) | Interval | Does |
|---|---|---|
| `scan` | 3 s | Find project folders and session files; stat everything |
| `pollFiles` | 1 s | Read new bytes from "hot" files (modified in the last **15 min**), ≤ 8 MiB per poll |
| `sweepShips` | 5 s | Re-evaluate attention, depart idle ships |
| `saveState` | 60 s | Write `universe-state.json` (temp file + rename) |

At startup a Claude file is read from its **end** — history is never replayed into the live
view; that is what playback is for.

```mermaid
sequenceDiagram
  participant F as transcript .jsonl
  participant T as tracker.js + live/
  participant C as app-context.js
  participant P as preload
  participant A as app/boot.js
  participant V as active view
  T->>F: pollFiles every 1 s reads new bytes
  T->>T: transcripts/claude.js or adaptLine turns lines into signals, live/*-records.js apply them to the LiveModel
  T-->>C: emit events batch
  C->>P: send au:events with streamEpoch and mode, only while LIVE
  P->>A: onEvents callback
  A->>A: drop stale epoch or seq, applyEvent (app/store.js) into AUR.app.state.store
  A->>V: view.update(batch), once per batch
  A->>A: scheduleChrome (app/chrome-queue.js) redraws panels next frame
```

**Project identity.** Claude: the project id is the `~/.claude/projects/<slug>` folder name
(unless the canonical cwd is already known). Codex / Signal: canonical path key → known id, or
`project:<fnv1a(key)>`. The renderer seeds all randomness from `fnv1a(project.id)` — the main
process has it in `shared/hash.js`; `util.js` and `galaxy-layout.js` keep their own copies.

**Event vocabulary** (`au:events` batch; every event has `seq`):

| Type | Payload |
|---|---|
| `project-added`, `project-updated` | `project` = `{id, path, name, exists, firstSeen, lastActivity, totalBytes, totalBuilds, seed, galaxy{key,label}}` |
| `ship-spawned`, `ship-updated` | `ship` = `{id, name, project, kind, provider, status, detail, lastEvent, attention, attentionSince, taskId, turnOutcome}` |
| `ship-departed` | `shipId, ts` |
| `activity` | `project, shipId, tool, status, detail, ts` |
| `build` | `project, bucket, file, shipId, isNew, ts` — a file edit inside a top-level folder |
| `feed` | `entry{kind, text, project, ts}` |

The renderer also injects one type of its own, `project-vcs-status`, which is not in `kit/SPEC.md`.

**Attention** (`live/attention.js` `classifyAttention`): `question` (pending `AskUserQuestion` /
`ExitPlanMode` > 2 s), `permission` (any other pending tool > 10 s), `stalled` (> 180 s),
`done` (turn finished, quiet 10 s). Notifications are raised by the **renderer**.

### 5.5 Live versus replay

Two event sources run side by side; `app-context.js` forwards only the active one.

- `ctx.activeSource` is either the Tracker or the ReplaySource. `replay-control.js` switches it
  and increments `ctx.streamEpoch`; the renderer drops batches from retired epochs.
- Seek: forward seeks advance in place; other seeks restore the latest seek checkpoint at or
  before the target and replay from there (k-way merge over all files in `history/merge.js`).
  Play ticks every 100 ms at 1×–1000×.
  Reading uses 256 KB chunks, a read index into the cursor buffer instead of a copy per line,
  and one JSON parse per Codex line; on ~3.8 GB of real transcripts (480 sources) a seek to the
  end went from 18.7 s to 4.9 s and a seek to the middle from 6.1 s to 2.6 s.
- **Seek checkpoints** (`history/checkpoints.js`): at index time up to 32 times are planned that
  split the indexed bytes evenly; a seek that passes one saves a copy of the model and every
  source cursor there (8 MB for all 32 on that data; 64 MB budget). After the first seek to the
  end, a seek to the middle takes ~40 ms instead of ~1.6 s; seeks before the first checkpoint
  stay cold. Continuing from a checkpoint equals a cold seek only while every record applied is
  later than it; a record that is not marks the checkpoint stale for that target and the seek
  is redone cold. Checkpoints are dropped on re-index and on stop.
- The **Tracker never stops** during playback. Only the `au:events` send is gated, so IDEAS
  runs, git refreshes and `GOALS.md` ticks keep happening while you scrub.
- Live and history share `universe/` (galaxy, procedural planets, ship records, public shapes),
  but each keeps its own named variant where they differ (`deriveGalaxy` / `historyGalaxy`,
  `liveShip` / `historyShip`).
- Replay is not a faithful copy of live: different galaxy keys, different drone ids, no
  attention, no `vcs`, `files: 0` in systems. Ship `builds` can differ too: live reads a session
  that was already running at launch from the end of its transcript, so it restarts at 0 (an
  interceptor) while replay counts from the session's first edit. The index is built once at
  launch, so the scrubber's end time does not advance until restart.

### 5.6 IDEAS queue: from an idea to a Codex run

```mermaid
stateDiagram-v2
  state "goal-written" as goalWritten
  state "launch-requested" as launchRequested
  state "launch-failed" as launchFailed
  state "ready-for-review" as readyForReview
  state "completion-failed" as completionFailed
  state "agent-aborted / agent-departed / agent-not-found" as agentLost
  [*] --> idea: create
  idea --> prepared: assign to a LIVE project
  prepared --> goalWritten: line appended to GOALS.md
  goalWritten --> launchRequested: intent saved, codex spawned
  goalWritten --> launchFailed: spawn failed
  launchRequested --> readyForReview: ship done, box ticked
  launchRequested --> completionFailed: GOALS.md changed mid-write
  launchRequested --> agentLost: abort, ship left, or no ship in 5 min
  readyForReview --> reopened: box unticked by hand
  launchFailed --> goalWritten: retry
  agentLost --> goalWritten: retry
  reopened --> goalWritten: retry
```

The link between a launched process and a ship is a marker: the prompt contains
`agent-universe:<uuid>`, the Codex transcript echoes it, `provider-adapters.js` turns it into a
`task-claim` signal and `task-runs.js` binds the run to that ship. `completion-failed` has no
retry path.

### 5.7 Git / GitHub status

`tracker events → controller (400 ms debounce) → service (15 s cache, ≤4 parallel) → collector (git) + github provider (gh)`,
and back out through `replay-control.js`, which pushes only while LIVE. Refreshes run at start,
on window focus, and on every `project-added`, `project-updated` and **`build`** event — so
every file edit triggers a `git status` for that project.

---

## 6. Renderer (`src/renderer/`)

### 6.1 Layers and load order

No modules, no bundler: `index.html` loads classic `<script>` tags in a fixed order and every
file attaches to the global `window.AUR`. A file may only use what loaded above it.

```mermaid
flowchart TB
  V["1 · Vendor — babylon.js, babylon.gui, babylonjs.loaders (UMD from node_modules)"]
  L["2 · Shared libraries — util.js creates window.AUR · util-scene · procedural-worlds · ship-assets · ship-assets-hulls · ship-assets-api · polish-math · galaxy-layout · search-core · components/project-vcs-status"]
  S["3 · Views — scene/common creates AUR.sceneParts · scene/universe/* parts · scene/universe · scene/system/* parts · scene/system · scene/planet → AUR.views.*"]
  ST["4 · app/state.js — the only file that creates AUR.app.state and AUR.app.const"]
  M["5 · Feature modules — app/agent-focus · app/chrome · app/chrome-queue · app/history-metrics · app/ideas · app/ideas-list · app/playback · app/project/control · app/project/directory · app/project/search · app/project/settings · app/project/tasks · app/replay · app/store"]
  A["6 · app/boot.js — boot, event routing, view switching, debug hooks"]
  V --> L --> S --> ST --> M --> A
```

Exceptions to "everything on `AUR`": `polish-math.js` publishes `window.AUR_POLISH`,
`galaxy-layout.js` publishes `window.AUR_GALAXY`, and `search-core.js` also leaks a bare
global `searchProjects`. These three plus the VCS component are UMD so Node can load them.
The split views follow one pattern: `scene/common.js` creates `AUR.sceneParts` (and
`AUR.disposeMeshAndMaterial`), each `scene-<view>-*.js` part registers its builders on
`AUR.sceneParts.<view>` and loads before its view, and the view builds one explicit `view`
object and merges its parts into it.

For the type check, `src/types/renderer-globals.d.ts` declares the globals `AU` (typed by the
contract), `AUR`, `AUR_POLISH` and `AUR_GALAXY` (all `any` for now).

### 6.2 File map

| File | Lines | Job |
|---|---|---|
| `util.js` | 213 | Creates `AUR`; hashes, colours, provider metadata, motion tuning, asset paths, DOM helpers |
| `util-scene.js` | 209 | Babylon helpers on `AUR`: skybox (PhotoDome), starfield, orbit rings, ship and signal markers, GUI labels |
| `procedural-worlds.js` | 329 | Planet and asteroid surfaces (authored textures + generated normal maps) |
| `ship-assets.js` | 254 | Manifest, per-scene state, hull choice by rank (`builds` against the manifest ladder), container loading; procedural dart fallback |
| `ship-assets-hulls.js` | 252 | Builds a hull from a loaded model: provider livery, far-file instances on the universe map, near-file clones in system / planet views, within a 100k-triangle budget |
| `ship-assets-api.js` | 123 | `AUR.ships`: instantiate, upgrade a fallback dart, `refresh` in place on promotion, dispose a scene's hull state |
| `galaxy-layout.js` | 178 | Pure: galaxy grouping, spiral placement, Graveyard |
| `polish-math.js` | 56 | Pure: label overlap, sun pulse |
| `search-core.js` | 34 | Pure: project ranking |
| `components/project-vcs-status.js` | 268 | Pure presentation for git / GitHub markers and details |
| `scene/common.js` | 18 | Creates `AUR.sceneParts` and `AUR.disposeMeshAndMaterial` |
| `scene/universe/view.js` | 274 | Galaxy map: builds the `view` object and merges its parts |
| `scene/universe/galaxies.js` | 145 | Galaxy discs, outlines, labels, glyph placement, camera framing |
| `scene/universe/glyphs.js` | 138 | A project glyph's live state: dimming, search focus, attention halo, VCS markers, sun pulse |
| `scene/universe/labels.js` | 238 | Dirty-driven label layout (`updateLabelLayout`) |
| `scene/universe/ships.js` | 64 | Ships orbiting their project's glyph |
| `scene/universe/stats.js` | 218 | Measured metrics for the harness and gates |
| `scene/system/view.js` | 337 | Solar system + first-person focus camera (`focusShip`) |
| `scene/system/belt.js` | 46 | Asteroid belt (thin instances) |
| `scene/system/focus.js` | 94 | Fades the other ships while one is followed; focus stats |
| `scene/system/ships.js` | 193 | Ships: build / remove, patrols, fly-to-planet builds, `refetchPlanets`, the view's `update` |
| `scene/planet.js` | 196 | Planet close-up |
| `app/state.js` | 180 | Shared state and constants (including the chrome dirty bits, `AUR.app.const.CHROME`) |
| `app/store.js` | 113 | `seedStore`, `applyEvent`, `maybeNotifyAttention`, `refreshShipHulls`, `workedShipIds` |
| `app/chrome-queue.js` | 71 | `chromeMaskFor`, `scheduleChrome`, `renderChrome`: one panel redraw per frame |
| `app/playback.js` | 244 | History bar |
| `app/replay.js` | 193 | Stream epochs, playback state, `issueReplay` |
| `app/history-metrics.js` | 97 | `AUR.historyTestMetrics` for the history harness |
| `app/project/search.js` | 237 | Search box, GitHub filter |
| `app/project/directory.js` | 257 | ALL PROJECTS dialog |
| `app/boot.js` | 369 | Boot, routing, view switching, debug hooks |
| `app/ideas.js` | 144 | IDEAS panel |
| `app/ideas-list.js` | 274 | IDEAS list rendering |
| `app/chrome.js` | 369 | Command rail, RECENT strip, agent list, feed, summary, tabs |
| `app/agent-focus.js` | 327 | Cockpit overlay, hologram mini-map |
| `app/project/settings.js` | 340 | Moved-project dialog |
| `app/project/tasks.js` | 286 | TASKS panel |
| `app/project/control.js` | 244 | Project card, Open Terminal button, planet card |
| `index.html` | 374 | All panels exist in the HTML up front; modules show / hide them |
| `style.css` | 2,110 | All styles; ~470 lines are the cockpit |

### 6.3 Shared state and routing

- `AUR.app.state` (`S`) is one mutable object that every `app/*` module reads and writes:
  the model copy (`S.store` = projects, ships, feed), the active view, epoch / sequence
  cursors, replay flags, and one sub-object per panel.
- **Boot** (`app/boot.js` `boot`, from line 18): create the Babylon engine → wire every panel → subscribe to
  pushes → `AU.snapshot()` → seed the store → drain anything queued during boot →
  show the universe.
- **Routing**: `routeEvents` (`app/boot.js`) → epoch / `seq` checks → `applyEvent` (`app/store.js`)
  per event → `activeView.update(batch)` once → `scheduleChrome` (`app/chrome-queue.js`) sets
  `AUR.app.const.CHROME` bits, and one `requestAnimationFrame` re-renders only those panels.
- **View switch** (`setView`): build the new scene first, swap, then dispose the old one —
  after polling up to 4 s for Babylon's BRDF texture, because disposing too early throws.
- **Views** are `AUR.views.<name>(engine, data, ctx) → {scene, update, dispose, …}`. The app
  layer also probes for view-specific extras (`setSearchMatches`, `focusShip`, `planetData`).

### 6.4 Who owns which part of the screen

| Region | Element | Owner |
|---|---|---|
| 3D canvas | `#renderCanvas` | `app/boot.js` + active view |
| Top bar: RECENT / search / ALL PROJECTS / settings | `#recent`, `#project-search`, `#project-directory-button`, `#settings-button` | chrome / search / search / settings |
| Command rail: IDEAS, AGENTS, FEED | `#sidebar` (`#ideas-panel`, `#agents-panel`, `#feed-panel`) | chrome + ideas |
| Project card, planet card | `#project-card`, `#planet-card` | project-control |
| TASKS panel | `#tasks-panel` | project-tasks |
| Cockpit overlay | `#agent-focus` | agent-focus |
| History bar | `#history-bar` | playback (+ replay) |
| Settings / directory dialogs | `#settings-dialog`, `#project-directory` | settings / project-directory |

---

## 7. What is stored where

| Location | File | Written by | Holds |
|---|---|---|---|
| userData (`%APPDATA%\agent-orrery`) | `universe-state.json` | `live/state-file.js` (Tracker timer) every 60 s | Build counts per folder, path → id map, path overrides |
| userData | `root-tasks.json` | `root-tasks.js` | IDEAS queue (cap 1,000 records) |
| userData | `task-runs.json` | `task-runs.js` | Codex run ↔ ship bindings |
| userData | `providers.json` | you (read-only to the app) | Signal folders to watch |
| each project | `GOALS.md` | `goals.js` | Task checkboxes (TASKS panel and IDEAS) |
| browser | `localStorage` | renderer | Rail collapsed, cockpit environment / vantage |
| repo | `.shots/` | test modes | Screenshots, `state.json`, gate run folders |

Nothing is stored on disk for history playback; it re-reads the transcripts. Seek checkpoints live in memory only.

Until October 2026 the app was Agent Universe Lite, and userData was `%APPDATA%\agent-universe-lite`.
The first normal run under the new name copies the four userData files from there (`user-data.js`),
never writes to the old folder, and skips the copy in every test mode.

---

## 8. Assets

| Folder | Size | Loaded by | Notes |
|---|---|---|---|
| `assets/planets/` | 81 MB | `util.js` (paths), `procedural-worlds.js` | 31 textures, picked by hash |
| `assets/skyboxes/` | 59 MB | `util-scene.js` (PhotoDome) | 12 equirectangular images |
| `assets/asteroids/` | 4 MB | `procedural-worlds.js` | `-bump` files unused |
| `assets/ships/fleet-v2/` | 5.9 MB | `ship-assets*.js` | The Claude and Codex fleet: a far and a near GLB for each of 8 hulls, a 7-rank ladder (interceptor at 0 builds → carrier at 200) plus the wisp drone, which is reserved |
| `assets/ships/*.glb`, `manifest.json`, `textures/` | ~9 MB | `ship-assets.js` (manifest only) | The 6-hull shared fleet and `aur-aster-kite` are still in the manifest but no provider maps to them |
| `assets/ships/fleet-scale-v2/` | **123 MB** | **nothing** | Blender sources, FBX, build scripts, QA renders; the source the `fleet-v2/` files are built from |
| `assets/palettes/`, `assets/manifest.json` | 48 KB | **nothing** (one test reads the manifest) | Colours are hard-coded in `util.js` |
| `src/renderer/assets/*.png` | 6 MB | `app/agent-focus.js` | Cockpit backdrops; no provenance file |
| root `1.planet-view.png`, `2.…`, `3.…` | 5 MB | nobody at runtime | Mockups the renderer is graded against |

The older ship GLBs are regenerated by `npm run ships:generate` (`scripts/generate-*.mjs`); the
`fleet-v2/` files by `node scripts/build-fleet-v2-runtime.mjs`, which runs `@gltf-transform/cli`
through `npx` (fetched on first run, not a dependency).

---

## 9. Tests, gates and CI

There are four layers of checking, and only the first three run in CI.

| Layer | Command | Runs Electron? | In CI? |
|---|---|---|---|
| Unit tests (58 files, 435 tests) | `npm test` | No | **Yes** (Ubuntu + Windows) |
| Type check (JSDoc, files starting `// @ts-check`) | `npm run typecheck` | No | **Yes** |
| Renderer regression gate | `node kit/grade.mjs` | Yes (`--shots`, on a synthetic profile; `--real` for your own data) | No |
| 12 archived kit gates | `node kit/done/<kit>/grade-*.mjs` | Most do | No |
| Everything at once | `node kit/done/main-split/grade-main-split.mjs --full` | Yes | No |

| Gate | Checks | Static or launches the app |
|---|---|---|
| `kit/grade.mjs` | 3 screenshots render, ≥1 project, no renderer errors | `--shots` |
| `attention/grade-attention.mjs` | `classifyAttention` cases, then `grade.mjs` | fixtures + `--shots` |
| `polish-pass/grade-polish.mjs` | label layout, real pointer flow | `--polish-test` |
| `packaging/grade-packaging.mjs` | Windows shortcuts; **fails if the working tree has changes outside its own files, untracked ones included** | PowerShell, Windows only |
| `galaxy-grouping/grade-galaxies.mjs` | galaxy derivation and layout metrics | `--polish-test` |
| `multi-provider/grade-providers.mjs` | adapters, privacy sentinel, provider rendering | `--provider-test` |
| `history-playback/grade-history.mjs` | replay fixtures, scrubber, no new dependencies | `--history-test` |
| `agent-control/grade-control.mjs` | terminal spec, LIVE-only gating, no new dependencies | `--control-test` |
| `project-tasks/grade-tasks.mjs` | `GOALS.md` parse / write, then `grade.mjs` | fixtures + `--shots` |
| `project-search/grade-search.mjs` | ranking, then `grade.mjs` | fixtures + `--shots` |
| `ship-assets-pack/grade-ships.mjs` | manifest schema, loader pin, then `grade.mjs` | static + `--shots` |
| `structural-cleanup/grade-structure.mjs` | every renderer file ≤ 400 lines (T1), script order, `AUR.app` ownership, runs tests | static (`--full` runs all) |
| `main-split/grade-main-split.mjs` | `main.js` is a bootstrap, every other `src/main` module ≤ 400 lines (T6), no module-level state in `src/main` | static (`--full` runs all) |

Six of the older gates grep "the main process" by concatenating every `.js` file under `src/main`,
so they keep passing wherever code moves inside that folder. The galaxy and provider gates read
`tracker.js` together with `live/` and `universe/`. The galaxy, provider, polish and history
gates read a view's source as its `scene-<view>*.js` files plus the shared `scene-*.js` and
`ship-assets*.js`, and util source as `util.js` plus `util-*.js`.

**How "frozen" is enforced.** By review, not by the gates: the **Frozen files** bullet in
`CLAUDE.md` lists what changes only on the owner's request. Until October 2026 two gates also
stored SHA-256 fingerprints of 7 renderer files; they were retired because every edit needed a
re-pin step and the fingerprints caught nothing the PR diff doesn't show. The control and
history gates still fail if a dependency is added. Every source file is held to 400 lines
(`grade-main-split.mjs` T6 for `src/main`, `grade-structure.mjs` T1 for the renderer). The
owner's rule is about 300 lines as the target and 400 as the maximum; going over needs a written
reason.

---

## 10. Where the mess is

Facts only, grouped by why they hurt. Items marked *(by reading)* were found in the source but
not reproduced.

### Too much in one place
1. *(resolved)* `tracker.js` (180) and `replay-source.js` (359) are façades over `live/` and
   `history/`; the public shapes, galaxies, planets and ship records are shared in `universe/`.
2. *(resolved)* `scene/universe/view.js` is split into five parts (§6.2). `updateLabelLayout`
   (`scene/universe/labels.js`) is still one 158-line function.
3. `style.css` is 2,110 lines in one file.
4. `ctx` is a service locator: `app-context.js` `start()` calls into `ctx.ipc.*` and
   `ctx.replay.*`, which `main.js` must attach first, and test-fixture branches are mixed into
   service construction.

### The same logic written more than once
5. **One Claude parser, two readings**: `transcripts/claude.js` feeds both models, but live
   (`resumesTurn`, `claudeTool`) and history (`historicalClaudeSignals`, `classifyTool`) still
   read its facts differently; the `differs:` tests in `tracker-replay-parity.test.js` name each
   difference (§5.5).
6. `fnv1a` / `mulberry32`: one main-process copy (`shared/hash.js`) plus copies in the classic
   renderer scripts `util.js` and `galaxy-layout.js`.
7. "Is path inside folder": 4 variants that really do answer differently (`isInsidePath`,
   `isPathInside` — which accepts UNC roots and long paths — `isInside`, which treats an equal
   path as outside, and `relativeInside`, whose callers choose the separator).
8. *(resolved)* `tracker.js` now uses `shared/atomic-write.js`.
9. Ship building / removal in all three scenes (3 copies that already differ: `scene/universe/ships.js`,
   `scene/system/ships.js`, `scene/planet.js`); camera,
   skybox, starfield and dispose setup also ×3.
10. "Question or permission" attention check hard-coded in 6 places.

### Hidden contracts (break these and a gate fails, not the app)
11. Tests and gates regex-match **source text**: DOM ids, CSS strings, literal code lines
    (`agent-focus-hologram.test.js`, most gates).
12. The test harness drives the renderer through DOM ids, mesh metadata keys and camera
    names (`ucam` / `scam` / `pcam`).
13. Four `docs/*.md` files and a section of `kit/ASSET-REQUESTS.md` are gate fixtures —
    editing their wording can fail a gate.
14. *(resolved)* The file fingerprints are retired; the frozen list in `CLAUDE.md` is the only one.
15. *(resolved)* The scene caps no longer equal the current sizes; every source file shares the
    400-line cap.
16. *(resolved)* `kit/grade.mjs` replaces only its own files in `.shots/`.

### Live and replay drift apart
17. Different galaxy keys (`deriveGalaxy` / `historyGalaxy`) (projects regroup while scrubbing), different drone ids, no attention,
    no git status in replay; a session running before launch has fewer live `builds` (a smaller
    hull) than replay gives it.
18. IDEAS runs can tick `GOALS.md` while you are in playback; `tasks-changed` pushes are not
    gated on mode while `vcs` pushes are.
19. The replay index is built once at launch; the scrubber's end time is frozen until restart.

### Dead weight
20. `assets/ships/fleet-scale-v2/` (123 MB, now only the source of `fleet-v2/`),
    `assets/palettes/`, `assets/manifest.json`, the `aur-aster-kite` hull and the 6-hull shared
    fleet — not loaded at runtime.
21. *(resolved)* `edge-validation.mjs` was folded into `test/tracker.test.js`.
22. Unused by the app: `providerToolStatus` (only `grade-providers.mjs` calls it),
    `AUR.attentionLabel`, `scene/system/view.js` `focusStats`.

### Stale documentation
23. Older docs quote line numbers in the pre-split `main.js` (§5.3 maps them).
24. *(resolved)* Every archived gate prints its `kit/done/` usage path.
25. No single backlog: `ROADMAP`, `UX-IMPROVEMENTS`, `DESIGN-DIRECTION`, `TIMELINE-SLIDER`,
    `PUBLIC-RELEASE-TASKS` Phase 5 and `kit/todo/` overlap.
26. *(resolved)* One name: Agent Orrery for the repo, package, userData folder, window and docs.
    The `agent-universe:<uuid>` task marker keeps its spelling: it is already written into `GOALS.md` files.

### Test gaps
27. *(mostly resolved)* The wiring has unit tests (`app-context`, `replay-control`, `ipc-*`), and
    `tracker.js` / `replay-source.js` have characterization tests, plus unit tests for the `live/`
    and `history/` modules. Still open: `goals.js` is tested
    only indirectly, and every `app/*.js` file is checked by source-text grep only.
28. *(resolved)* `kit/grade.mjs` runs against a synthetic profile (`scripts/lib/synthetic-profile.mjs`);
    `--real` uses your own transcripts and userData.

### Possible bugs *(by reading)*
29. *(resolved)* A Claude session that resumes after 15 quiet minutes no longer re-counts its
    old edits.
30. *(resolved)* Signal ships for files 5–15 min old no longer depart and respawn every scan.
31. `scene/system/ships.js` `refetchPlanets` can add meshes to a scene that has already been
    disposed after a quick view switch.
32. Every scan stats every Claude transcript and lists all Codex history (all years) every
    3 s — cost grows with history size.

---

## 11. Glossary

| Term | Means |
|---|---|
| Kit | A contract + grading script handed to an agent to build one feature. Finished ones keep only their gate, in `kit/done/`. |
| Gate | A `grade-*.mjs` script that exits 0 / 1. |
| Frozen | A file that changes only on the owner's request (`CLAUDE.md`, Frozen files). |
| `ctx` | The one shared object in the main process (`app-context.js`); holds the window, sources and services. |
| LIVE / REPLAY | Whether the window shows the Tracker or the history ReplaySource. |
| Epoch | Counter that increments on every LIVE ↔ REPLAY switch; stale batches are dropped. |
| Signal | A third provider type: a folder you list in `providers.json`; only file sizes and times are read. |
| IDEAS / root task | A global to-do you can assign to a project, which starts Codex on it. |
| TASKS / goal | A checkbox line in a project's `GOALS.md`. |
| Build | A file edit inside a project; grows the planet for its top-level folder. |
| Bucket | The top-level folder a build counts toward (`(root)` for files at the top). |

# Kit 14 — Split `src/main/main.js` and remove its global state

Distilled 2026-10-01. Executor: a coding agent run by the owner's planner (Codex or
Claude). Fallback: **none — stop and report**. Gate:
`node kit/todo/grade-main-split.mjs --stage <task> [--full]` (FAILS cleanly until built;
`--stage` reports later tasks' checks as SKIP; `--full` also runs every archived gate and
the renderer gate three times, skipping the packaging gate while the tree is dirty).
On completion the executor moves this file and the gate to `kit/done/main-split/` with an
`EXECUTOR-REPORT.md`, like every other archived kit.

## 0. Brief

`src/main/main.js` is 2,217 lines with 25 module-level `let`s and 5 module-level mutable
collections. Over half of it (≈1,200 lines) is the headless test harness for the kit
gates, which never runs for a user. The rest is six unrelated IPC domains, replay
control, service construction and window creation, all sharing state through file-scope
globals. This kit moves each concern into its own module, gives each module ownership of
its own state, and leaves `main.js` as a ≤150-line bootstrap. **Behaviour is identical
before and after**; the archived gates and the unit tests are the proof.

| Task | Item | Stage |
|---|---|---|
| 0 | **Kill switch**: `flags.js` + `harness/fixtures.js` | `A` |
| B | Harness driver, metrics and the five mode runners | `B` |
| C | `app-context.js` (service construction, cleanup) + `window.js` | `C` |
| D | `replay-control.js` + `ipc/*` handlers + `ipc/register.js` | `D` |
| E | `main.js` reduced to bootstrap; CLAUDE.md + kit/SPEC.md frozen lists updated | `E` |
| F | Archive the kit, executor report, PR | (no `--stage`) |

Gate greps were widened to the whole `src/main` layer **in the PR that added this kit**,
and every archived gate was green on the unsplit tree afterwards, so the executor never
edits an archived gate.

## 1. Hard constraints

- CommonJS throughout `src/main`; Node built-ins and `electron` only; no new npm packages.
- **Frozen, never changed**: `src/main/tracker.js`, `src/main/replay-source.js`,
  `src/main/provider-adapters.js`, `src/preload.js`, `package.json`, `package-lock.json`,
  everything under `src/renderer/` and `assets/`, the root mockup PNGs.
  `git diff --stat origin/main -- <that list>` must be empty at every commit.
  `main.js` itself is **unfrozen by this kit** (task E records that in CLAUDE.md and
  `kit/SPEC.md`).
- The 27 `au:*` IPC channel names in `src/preload.js`, their argument shapes and their
  return shapes do not change. The renderer is not touched, so any change there would
  break it; the renderer gate and the unit tests will show it.
- Every test-mode flag (`--shots`, `--polish-test`, `--provider-test`, `--history-test`,
  `--control-test`, each `--<name>-output=`) keeps working exactly as before; the archived
  gates spawn the app with them.
- Behaviour-preserving: **move code, do not rewrite it.** The only edits inside moved
  code are the mechanical ones §2.2 prescribes (a global becomes a field of the context
  or a module-private variable; a direct call becomes a call through the context).
- `git add` with explicit paths only. No generated artifacts, no `kit/BLOCKED.md`, no
  `.shots` committed.

## 2. Decisions (made here; the executor implements, never redesigns)

### 2.1 Module layout

All new files live under `src/main/`. Line ranges refer to `main.js` on `origin/main` at
the time of distilling and are a guide, not a contract; the function names are the contract.

| New module | Takes over (from `main.js`) | Exports |
|---|---|---|
| `flags.js` | the `SHOT_MODE` … `CONTROL_TEST` constants and the `--*-output=` parsing (≈ lines 28–50) | `readFlags(argv)` → frozen object `{ shots, polishTest, providerTest, historyTest, controlTest, testMode, outputs: {…} }` |
| `harness/fixtures.js` | `createProviderFixture`, `historyLine`, `createHistoryFixture`, `createControlFixture`, `createRecordingTerminalLauncher` (≈ 84–243) | those five, unchanged signatures |
| `harness/driver.js` | `rendererEval`, `readViewState`, `waitForView`, `readPolishStats`, `findCanvasTarget`, `validatePointerPick`, `acquirePointerTarget`, `sendTestInput`, `clickPoint`, `screenshotClick`, `elementCenter`, `capture`, `percentile`, `backdropLuma`, `exerciseCamera` (≈ 1274–1504) | `createDriver(ctx)` returning an object with those functions |
| `harness/metrics.js` | `readHistoryMetrics`, `waitForHistory`, `clickHistoryControl`, `historyScrubberPoint`, `scrubHistory`, `dragHistory`, `snapshotBuilds`, `liveTrackerBuilds`, `readControlMetrics`, `waitForControl`, `safeRecordedTerminalCalls` (≈ 1505–1669) | `createMetrics(ctx, driver)` |
| `harness/modes/shots.js`, `control.js`, `history.js`, `provider.js`, `polish.js` | `runShotMode`, `runControlMode`, `runHistoryMode`, `runProviderMode`, `runPolishMode` (≈ 1164–1273, 1670–2214) | each `run(ctx, driver, metrics)` |
| `app-context.js` | service construction now inside `createWindow` (tracker, replay source, active source, launchers, task stores, coordinator, VCS controller, timers) and `cleanupForExit` (≈ 244–287, 932–1079) | `createAppContext({ flags, fixtures })` → `ctx`; `ctx.cleanup()` |
| `window.js` | `BrowserWindow` creation, `hardenWebContents`, renderer load, console forwarding, test-error collection | `createWindow(ctx)` → `BrowserWindow` |
| `replay-control.js` | `boundedReplayStatus`, `visibleSnapshot`, `visibleSystem`, `sendProjectVcsStatusChanged`, `replayResult`, `sendReplayState`, `ensureReplayIndex`, `validateReplayCommand`, `handleReplayCommand`, `visibleProject` (≈ 288–470) | `createReplayControl(ctx)` |
| `ipc/guards.js` | `validProjectId`, `trustedMainFrame` (≈ 471–480) | both |
| `ipc/terminal.js` | `liveProjectCwd`, `terminalFailure`, `handleOpenTerminal` (≈ 481–534) | `createTerminalIpc(ctx)` |
| `ipc/tasks.js` | `handleTasksGet` … `taskMutationResult` (≈ 535–652) | `createTasksIpc(ctx)` |
| `ipc/root-tasks.js` | `rootTaskFailure` … `sendRootTasksChanged`, `liveProjectShips` (≈ 653–732) | `createRootTasksIpc(ctx)` |
| `ipc/project-paths.js` | `projectPathFailure` … `handleProjectPathApply` (≈ 733–931) | `createProjectPathsIpc(ctx)` |
| `ipc/register.js` | the `ipcMain.handle('au:…')` table (≈ 1109–1160) | `registerIpc(ctx, handlers)` |

`main.js` keeps: requires, `readFlags`, `createAppContext`, `createWindow`, `registerIpc`,
the test-mode dispatch (`if (flags.controlTest) …`), and the three `app.*` lifecycle
lines. Target ≤ 150 lines.

### 2.2 State rule (the point of the kit)

- **No module-level `let` anywhere under `src/main`.** Zero. The gate counts them.
- **No module-level mutable collection** (`const x = new Map()` / `new Set()` / `= []`
  at file scope) in `main.js` or any new module. They move inside the factory that owns
  them.
- Shared runtime objects (`win`, `tracker`, `replaySource`, `activeSource`,
  `terminalLauncher`, `taskRuns`, `rootTasks`, `rootTaskCoordinator`,
  `projectVcsStatusController`, `taskRunSweepTimer`, `streamEpoch`) become **fields of
  `ctx`**, the object `createAppContext` returns. `activeSource` and `streamEpoch` are
  reassigned at runtime; that is fine, they are properties, not globals.
- State used by exactly one concern becomes a **module-private variable inside that
  concern's factory**: replay operation state (`replayOperation`,
  `replayBoundaryOperations`, `replayIndexPromise`, `replayStateLastSent`,
  `replayStateTimer`) in `replay-control.js`; `terminalLaunchInFlight`,
  `terminalLaunchCooldownUntil` in `ipc/terminal.js`; `projectPathDialogInFlight`,
  `projectPathScanAbort`, `projectPathCandidates`, `PROJECT_PATH_CANDIDATE_TTL_MS` in
  `ipc/project-paths.js`; fixture roots and `controlFixture`/`historyFixture`,
  `controlTerminalUnrefs`, `controlTerminalCalls`, `rendererTestErrors`,
  `openedProjects`, `pointerInputEvents` in the harness modules that use them (`ctx.harness`
  may carry the few that both `window.js` and a mode need, such as `rendererTestErrors`).
- Mechanical mapping: a bare global `x` read inside moved code becomes `ctx.x`, or the
  module-private `x` if §2.2 assigns it to that module. Nothing else is renamed.

### 2.3 Gate greps (already done)

The archived gates for agent-control, galaxy-grouping, history-playback, multi-provider
and polish-pass read `src/main/main.js` and grep feature strings. In the PR that added
this kit, each `mainSource` became the concatenation of **every `.js` under `src/main`**
(recursive, sorted) with a dated comment, and every gate was green on the unsplit tree.
The polish gate's `P4` rule (no `.click()` in the harness) therefore now applies to the
whole main layer; the layer has none today, keep it that way.

### 2.4 Line caps

New modules ≤ 450 lines each (the largest, `harness/modes/history.js`, is ≈ 190 on the
map above). `main.js` ≤ 150 from stage `E`. Frozen files keep their exact sizes
(`tracker.js` 1573, `replay-source.js` 1420, `provider-adapters.js` 570). Line counts
use `wc -l` semantics.

### 2.5 Gate stages

| `--stage` | Use it for | Adds checks |
|---|---|---|
| `A` | task 0 | `flags.js` and `harness/fixtures.js` exist; `main.js` no longer defines the five fixture functions or the `SHOT_MODE` … constants |
| `B` | task B | driver, metrics and the five mode files exist; `main.js` defines no `run*Mode`, no `rendererEval`, no `sendTestInput` |
| `C` | task C | `app-context.js`, `window.js` exist; `main.js` contains no `new BrowserWindow(` and no `new Tracker(` |
| `D` | task D | `replay-control.js`, `ipc/guards.js`, `ipc/terminal.js`, `ipc/tasks.js`, `ipc/root-tasks.js`, `ipc/project-paths.js`, `ipc/register.js` exist; `main.js` contains no `ipcMain.handle(` and no `handleReplayCommand` definition |
| `E` | task E | `main.js` ≤ 150 lines, zero `let`, zero file-scope `new Map`/`new Set`/`= []`; CLAUDE.md and `kit/SPEC.md` no longer list `main.js` as frozen |
| `all` | task F and forever after | everything |

At every stage: T6 line caps, T7 zero module-level `let` in every `src/main` file other
than `main.js` (and in `main.js` from `E`), T8 `node kit/repin.mjs --check`, T9
`npm test`; `--full` adds every archived gate (packaging only on a clean tree) and
`kit/grade.mjs` three times.

## 3. Order of work and the kill switch

Every task is gated twice: `--stage <X> --full` before the commit (packaging reports SKIP
on the dirty tree) and again immediately after the commit (nothing skipped). The
post-commit run must be fully green before the next task starts.

1. **Task 0 — kill switch.** Create `flags.js` and `harness/fixtures.js`; `main.js`
   requires them and deletes its copies. Gate `--stage A --full` before and after.
   **If any archived gate goes red for a reason attributable to the module split,
   STOP: revert, write `kit/BLOCKED.md` with the failing output, report.** Commit
   `refactor(main): extract flags and harness fixtures`.
2. **Task B**, one commit per file in this order: `harness/driver.js`,
   `harness/metrics.js`, then the five modes. Gate `--stage A --full` for the
   intermediate commits (stage `B` checks need all seven files) and `--stage B --full`
   for the last one.
3. **Task C**: `app-context.js` then `window.js`, one commit each; `--stage B` for the
   first, `--stage C` for the second.
4. **Task D**: `replay-control.js`, then the `ipc/*` modules, then `ipc/register.js`,
   one commit each; `--stage C` until the last, which uses `--stage D`.
5. **Task E**: finish `main.js` (≤ 150 lines, no `let`, no file-scope collections);
   update the frozen-file bullet in `CLAUDE.md` and the frozen list in `kit/SPEC.md`
   (remove `main.js`, add one sentence: "`main.js` is a bootstrap; concerns live in
   `app-context.js`, `window.js`, `replay-control.js`, `ipc/`, `harness/`"); update the
   Architecture paragraph in CLAUDE.md to match. Gate `--stage E --full`.
6. **Task F**: move this file to `kit/done/main-split/CONTRACT.md` and the gate to
   `kit/done/main-split/grade-main-split.mjs` (its root detection already handles both
   locations); add status-board rows in `kit/README.md` and `kit/todo/README.md`; write
   `kit/done/main-split/EXECUTOR-REPORT.md` with every file created, the line counts of
   `main.js` before and after, the final full gate output, and anything skipped. Final
   gate: `node kit/done/main-split/grade-main-split.mjs --full` with no `--stage`.
   Commit `chore(kit): archive kit 14`, push, open a PR to `main`. Do not merge.

## 4. Rubric

| Check | How |
|---|---|
| `main.js` ≤ 150 lines, no `let`, no file-scope mutable collections | gate T-E |
| No module-level `let` anywhere in `src/main` | gate T7 |
| Every new module ≤ 450 lines; frozen files byte-identical | gate T6 + frozen diff |
| All 27 `au:*` channels still registered with unchanged handlers | `npm test` (window-security, launcher, task tests) + archived gates |
| Every test mode still drives the app | the five archived gates that spawn it, green |
| No behaviour change | every gate green, `kit/grade.mjs` ×3, and a human runs `npm start` once: open a system, open a terminal, assign an idea, scrub history |

Reject examples: a module that reads a global from `main.js` (there are none left to
read); a `ctx` field invented for state that only one module uses; an IPC handler whose
return shape changed "while I was there"; an archived gate regex loosened; a harness
helper rewritten "more cleanly" instead of moved.

## 5. Objections, pre-answered

- *"Why a `ctx` object instead of passing each dependency?"* Fourteen modules sharing
  eleven runtime objects; a context object is the smallest interface that is not a
  global, and it is what the renderer split (`AUR.app`) already does on the other side.
- *"Why move the harness instead of deleting it?"* It is the only end-to-end test the
  renderer has. It just doesn't belong in the file that boots the app.
- *"Why not also split `tracker.js`?"* Frozen and hash-pinned by two gates, and it is one
  concern (transcript tailing). Separate decision, separate kit.

## 6. Executor prompt (paste verbatim, from the `agent-orrery` checkout on an updated `main`)

```
You are executing kit 14 in this repository. Read, in this order, before touching any file:
CLAUDE.md, kit/SPEC.md, kit/todo/14-main-split.md (the contract; it overrides anything else
you assume), kit/todo/grade-main-split.mjs (the gate), kit/done/structural-cleanup/CONTRACT.md
and kit/done/structural-cleanup/EXECUTOR-REPORT.md (the previous split, same mechanics).

Then execute kit/todo/14-main-split.md end to end, in the order of its section 3, on a new
branch kit/14-main-split created from main. Rules that are not negotiable:

1. Every decision in section 2 is already made. Do not redesign the module layout, the ctx
   object or the state rule. If a decision cannot be implemented as written, stop, write
   kit/BLOCKED.md explaining exactly why with the failing command output, and report; do not
   improvise an alternative.
2. Task 0 is a kill switch. If node kit/todo/grade-main-split.mjs --stage A --full is not
   fully green after task 0 for a reason attributable to the split, revert to main, write
   kit/BLOCKED.md, and stop.
3. One commit per file as section 3 lists. Before every commit, and again immediately after
   it, run node kit/todo/grade-main-split.mjs --stage <X> --full with the stage section 3
   assigns to that commit (task F runs it with no --stage). SKIP lines for later stages and
   a packaging SKIP on the pre-commit run are expected; the post-commit run must have no
   FAIL and no packaging SKIP. Paste the post-commit summary lines into the commit body.
4. Frozen files never change: src/main/tracker.js, src/main/replay-source.js,
   src/main/provider-adapters.js, src/preload.js, package.json, package-lock.json, everything
   under src/renderer and assets. Before every commit run
   git diff --stat origin/main -- src/main/tracker.js src/main/replay-source.js src/main/provider-adapters.js src/preload.js package.json package-lock.json src/renderer assets
   and it must print nothing. If node kit/repin.mjs --check reports any stale path, you
   edited a frozen file: revert it.
5. Move code, do not rewrite it. The only edits inside moved code are the mechanical ones
   section 2.2 prescribes. IPC channel names, argument shapes and return shapes are
   unchanged. Never edit an archived gate; they were widened already.
6. CommonJS, Node built-ins and electron only, no new dependencies. git add with explicit
   paths, never git add -A. Do not change git config. Do not merge the PR.
7. Finish with task F exactly as section 3 step 6 says, push the branch and open a pull
   request to main with the executor report as the body.

Work autonomously; do not ask questions. When you are done, reply with the PR URL, the final
gate output, git log --oneline origin/main..HEAD, and anything you could not do.
```

# Kit 14 — Main-process split: executor report

**Verdict: PASS** (executed 2026-10-01 on branch `kit/14-main-split`).

Executor: Claude Code (Opus-class), working in the worktree `agent-orrery-kit14`. The run was
interrupted twice. Each later session resumed from the committed state. Before continuing, it
re-ran the gate on HEAD. The last resume ran `--stage B --full` on the app-context commit, and
it was green.

The branch is based on `origin/kit/14-distill` (PR #10). That branch carries the distill
commit `9b521d8` (contract, gate, five widened archived gates). This PR therefore supersedes
PR #10.

Delivered:

- **Task 0:**
  - `flags.js`: `readFlags(argv)` returns a frozen flags object.
  - `harness/fixtures.js`: the five fixture builders, with signatures unchanged.
- **Task B:**
  - `harness/driver.js`: `createDriver(ctx)`.
  - `harness/metrics.js`: `createMetrics(ctx, driver)`.
  - Five mode runners, `harness/modes/{shots,control,history,provider,polish}.js`. Each is
    `run(ctx, driver, metrics)`.
- **Task C:**
  - `app-context.js`: `createAppContext({ flags, fixtures })` returns `ctx`.
    - Service construction is `ctx.start()`.
    - `cleanupForExit` is `ctx.cleanup()`.
  - `window.js`: `createWindow(ctx)` returns the `BrowserWindow`. It also exports
    `RENDERER_ENTRY_URL`.
- **Task D:**
  - `replay-control.js`: `createReplayControl(ctx)`.
  - `ipc/guards.js`: `validProjectId` and `trustedMainFrame(ctx, event)`.
  - `ipc/terminal.js`, `ipc/tasks.js`, `ipc/root-tasks.js` and `ipc/project-paths.js`. Each is
    a `create*Ipc(ctx)` factory.
  - `ipc/register.js`: `registerIpc(ctx, handlers)`.
  - The owner-authorized project-tasks gate widening, in its own commit right before
    `ipc/register.js`. See "Amendment" below.
- **Task E:**
  - `main.js` is a 47-line bootstrap. It has no `let` and no file-scope collection.
  - CLAUDE.md:
    - the frozen-files bullet drops `main.js` and gains the sentence the contract
      prescribes;
    - the Architecture and Test-mode flags paragraphs now describe the new layout.
  - `kit/SPEC.md`: its frozen list drops `main.js` and gains the same sentence.
- **Task F:**
  - The kit is archived here.
  - §2.3 of `CONTRACT.md` now says six gates were widened.
  - Both status boards are updated.
  - `docs/PUBLIC-RELEASE-TASKS.md` 5.4 points at the code's new location.

## Commits

```
(this commit) chore(kit): archive kit 14
0b0dbba refactor(main): reduce main.js to a bootstrap
3dab508 refactor(main): extract ipc registration
41367a4 fix(kit): widen project-tasks gate to the src/main layer
4cff03a refactor(main): extract project path ipc
df6c93c refactor(main): extract root task ipc
ac22147 refactor(main): extract project task ipc
5a926d3 refactor(main): extract terminal ipc
cd1be9e refactor(main): extract ipc guards
1a7aef0 refactor(main): extract replay control
21880b5 refactor(main): extract window creation
a5baa90 refactor(main): extract app context
0d7ba96 refactor(main): extract polish mode runner
7a32170 refactor(main): extract provider mode runner
fed1894 refactor(main): extract history mode runner
3a7444e refactor(main): extract control mode runner
de7d2e8 refactor(main): extract shots mode runner
1d42ced refactor(main): extract harness metrics
1ea37bd refactor(main): extract harness driver
891fd94 refactor(main): extract flags and harness fixtures
9b521d8 kit: distill kit 14, split main.js and remove its global state
```

Each task was gated twice with `grade-main-split.mjs --stage <X> --full`: once before its
commit and once immediately after it. The post-commit run, with the packaging gate included
on the clean tree, is pasted into each commit body. Stages followed §3:

- `A` for task 0 and the intermediate task B commits;
- `B` for the last mode and for `app-context.js`;
- `C` for `window.js` through `project-paths.js` and the gate widening;
- `D` for `ipc/register.js`;
- `E` for the bootstrap;
- no `--stage` for this archive commit.

The body of `a5baa90` (app context) gained its post-commit summary when this session resumed;
the commit was interrupted before that step. Only the message changed, not the tree.

## What moved where

The split was mechanical: functions were cut from `main.js` and pasted into a factory (or a
plain module) with two spaces of indentation. Inside moved code the only edits are the ones
§2.2 prescribes:

- a bare global `x` became `ctx.x`, or the factory-private `x`;
- a `*_TEST` constant became `ctx.flags.*`;
- a call into another concern became a call through `ctx`.

Nothing else was renamed. At the end of the run, a scratch script diffed every moved function
against the same function in `origin/main:src/main/main.js`, including the modules committed
in earlier sessions:

- the fixtures, driver, metrics and five modes;
- the service construction in `app-context.js` and its `cleanup`;
- `window.js`, `replay-control.js` and the five ipc modules;
- the `register.js` table.

The only changed lines are those mappings, the destructuring of driver and metrics helpers at
the top of each mode, and the points listed under "Judgment calls".

| New file | Takes over from `main.js` | Exports |
|---|---|---|
| `flags.js` | `SHOT_MODE` … `CONTROL_TEST`, the four `--*-output=` parsers | `readFlags(argv)` |
| `harness/fixtures.js` | `createProviderFixture`, `historyLine`, `createHistoryFixture`, `createControlFixture`, `createRecordingTerminalLauncher` | those five |
| `harness/driver.js` | `rendererEval` … `exerciseCamera` | `createDriver(ctx)` |
| `harness/metrics.js` | `readHistoryMetrics` … `safeRecordedTerminalCalls` | `createMetrics(ctx, driver)` |
| `harness/modes/*.js` | `runShotMode`, `runControlMode`, `runHistoryMode`, `runProviderMode`, `runPolishMode` | `run(ctx, driver, metrics)` |
| `app-context.js` | service construction formerly in `createWindow`; `cleanupForExit` | `createAppContext({ flags, fixtures })` |
| `window.js` | `BrowserWindow` creation, `hardenWebContents`, test-mode console forwarding, renderer-error collection, load diagnostics, `loadFile` | `createWindow(ctx)`, `RENDERER_ENTRY_URL` |
| `replay-control.js` | `boundedReplayStatus` … `visibleProject` | `createReplayControl(ctx)` |
| `ipc/guards.js` | `validProjectId`, `trustedMainFrame` | both |
| `ipc/terminal.js` | `liveProjectCwd`, `terminalFailure`, `handleOpenTerminal` | `createTerminalIpc(ctx)` |
| `ipc/tasks.js` | `handleTasksGet` … `taskMutationResult` | `createTasksIpc(ctx)` |
| `ipc/root-tasks.js` | `rootTaskFailure` … `liveProjectShips` | `createRootTasksIpc(ctx)` |
| `ipc/project-paths.js` | `projectPathFailure` … `handleProjectPathApply` | `createProjectPathsIpc(ctx)` |
| `ipc/register.js` | the 20 `ipcMain.handle` registrations for `au:*` channels, including the inline `au:open-external`, `au:planet` and `au:open` handlers | `registerIpc(ctx, handlers)` |

### Where the 25 `let`s and 5 collections went

| Former global | Now |
|---|---|
| `win`, `tracker`, `replaySource`, `activeSource`, `terminalLauncher`, `taskRuns`, `rootTasks`, `rootTaskCoordinator`, `projectVcsStatusController`, `taskRunSweepTimer`, `streamEpoch` | fields of `ctx` |
| `replayOperation`, `replayBoundaryOperations`, `replayIndexPromise`, `replayStateLastSent`, `replayStateTimer` | private to `createReplayControl` |
| `terminalLaunchInFlight`, `terminalLaunchCooldownUntil` | private to `createTerminalIpc` |
| `projectPathDialogInFlight`, `projectPathScanAbort`, `projectPathCandidates` (Map), `PROJECT_PATH_CANDIDATE_TTL_MS` | private to `createProjectPathsIpc` |
| `providerFixtureRoot`, `historyFixtureRoot` | private to `createAppContext` |
| `historyFixture`, `controlFixture`, `rendererTestErrors`, `openedProjects` | `ctx.harness` (read by `window.js`, `app-context.js`, `ipc/register.js` and the modes) |
| `controlTerminalCalls`, `controlTerminalUnrefs` | private to `createRecordingTerminalLauncher` |
| `pointerInputEvents` | private to `createDriver` (exposed on the driver for the polish mode) |

`ctx` also carries:

- `ctx.flags`;
- `ctx.replay`, the replay controller;
- `ctx.ipc` = `{ terminal, tasks, rootTasks, projectPaths }`. App-context, the control mode
  and the IPC table reach the concerns through these;
- `ctx.harness.runTestMode`;
- `ctx.start` and `ctx.cleanup`.

`main.js` wires `ctx.replay` and `ctx.ipc` right after `createAppContext`.

## Judgment calls (all mechanical, recorded so a reviewer can check them)

- **`replayBoundaryOperations` is read by four other concerns.** The terminal, task,
  root-task and project-path guards all read it, and §2.2 makes it private to
  `replay-control.js`.
  - The factory exposes it as a read-only getter under the same name.
  - Every read became `ctx.replay.replayBoundaryOperations > 0`.
  - There is no new ctx field and no rename.
- **`trustedMainFrame` read the window global.** `ipc/guards.js` exports
  `trustedMainFrame(ctx, event)`.
  - Each module that uses it binds it once:
    `const trustedMainFrame = (event) => guards.trustedMainFrame(ctx, event);`.
  - Every call site keeps its one-argument form.
  - `RENDERER_ENTRY_URL` is defined once, in `window.js`, and imported by the guard.
- **Test-mode dispatch.**
  - §2.1 keeps the `if (flags.controlTest) …` dispatch in `main.js`.
  - The `did-finish-load` listener stays where it was: registered inside the test-mode block
    of `window.js`, before `loadFile`. The comment that travels with that block explains
    why.
  - The listener calls `ctx.harness.runTestMode()`, and `main.js` sets that to its dispatch
    before the window exists.
  - Attaching the listener in `main.js` after `createWindow` returned would have moved it
    past `loadFile`, so that option was not used.
- **Window ownership.** `createWindow(ctx)` returns the window. `main.js` runs
  `ctx.win = createWindow(ctx); ctx.start();`. Start-up order is the same as before:
  1. create the window;
  2. harden it;
  3. register the test listeners;
  4. `loadFile`;
  5. build the services.
- **One comment edit.** The moved comment in `window.js` said "the synchronous tracker setup
  below". It now says "the synchronous tracker setup (ctx.start)", because that setup is no
  longer below it.
- **Interim shims.** Between `app-context.js` and the ipc modules, `main.js` carried an
  interim `ctx.replay` / `ctx.ipc` shim over its remaining `let`s. App-context could
  therefore call `reset()`, `liveProjectCwd`, `sendRootTasksChanged` and similar through
  `ctx` from the first commit. Each shim piece was deleted in the commit that moved its
  concern. In the interim commits, `main.js` destructured handlers from `ctx.ipc.*` so its
  IPC table did not change until `ipc/register.js` took it.
- **Cleanup order.** `ctx.cleanup()` runs exactly the statements `cleanupForExit` ran.
  - The reset statements are grouped by owner:
    - `ctx.replay.reset()` first, then `ctx.ipc.projectPaths.reset()`;
    - the terminal reset where it was.
  - As a result, `replayBoundaryOperations = 0` and the replay-state timer clear run a few
    statements earlier than before.
  - All of these are synchronous, independent assignments inside one call.
- **`ctx.ipc.tasks`.** It holds only handlers and no state, and only the IPC table reads it.
  It sits in `ctx.ipc` beside the other three so that
  `registerIpc(ctx, { replay: ctx.replay, ...ctx.ipc })` is one line.
- **Fixture roots (earlier session).** `createProviderFixture` and `createHistoryFixture`
  used to assign the globals `providerFixtureRoot` and `historyFixtureRoot`.
  - They now keep the root in a local and return it as `root` on the fixture.
  - `ctx.start()` copies it into the factory-private root variables.
  - `createControlFixture` reads `fixture.root` where it read `historyFixtureRoot`.
- **Recorded terminal calls (earlier session).** The recording launcher's
  `controlTerminalCalls` and `controlTerminalUnrefs` became private to
  `createRecordingTerminalLauncher`. It exposes them as `calls` and `unrefs`, so the control
  mode and metrics read `ctx.terminalLauncher.calls` and `ctx.terminalLauncher.unrefs`.
- **Shots output path.** The shots mode moved two directories deeper, so its `.shots` path
  gained two parent-directory segments. It still resolves to `<repo>/.shots`.
- **`docs/PUBLIC-RELEASE-TASKS.md` 5.4.** Its pointer `src/main/main.js:491` now reads
  `src/main/ipc/terminal.js:24` (`liveProjectCwd`). The text of that item is unchanged.

## Amendment: sixth archived gate

`kit/done/project-tasks/grade-tasks.mjs` grepped `src/main/main.js` for `au:tasks-get` and
`au:tasks-save`. It is a sixth gate of that kind, and the distill missed it. The owner
authorized exactly one archived-gate edit: widen it the same way as the other five.

- `mainSrc` becomes the sorted, recursive concatenation of every `.js` under `src/main`,
  with the same dated comment.
- The check and its failure message are unchanged.
- It landed as its own commit, `fix(kit): widen project-tasks gate to the src/main layer`,
  immediately before `refactor(main): extract ipc registration`. That second commit is the
  one that moved those strings out of `main.js`.
- The gate was green on the tree before and after the widening commit.

§2.3 of `CONTRACT.md` was edited to say six gates were widened and to name project-tasks. No
other archived gate was touched, and no regex was loosened.

## Verification beyond the gates

These checks ran before every commit of this session from `window.js` through the bootstrap.
The load smoke ran before each commit from `window.js` through `ipc/register.js`, and once
more on the final HEAD.

- `git diff --stat origin/main -- <frozen list>` was empty.
- **Channel drift:** the sorted set of `au:*` channel literals across `src/main` equals the
  set in `origin/main:src/main/main.js`: 27 channels. Both have 20 `ipcMain.handle`
  registrations.
- **Load smoke:** `main.js` was loaded under Node with `electron` stubbed. It loads, and from
  `ipc/register.js` on it registers 20 distinct handlers at load time, as before.
- `node kit/repin.mjs --check`: all pins current.
- **New files are LF.** The repo stores LF (`* text=auto`).

The polish gate's P4 rule (no direct element click in the harness) now covers the whole
`src/main` layer, and the layer has none.

## Line counts (`wc -l`), origin/main → final

| File | Before | After |
|---|---|---|
| src/main/main.js | 2217 (25 `let`, 5 file-scope collections) | 47 (0, 0) |
| src/main/flags.js | — | 44 |
| src/main/app-context.js | — | 217 |
| src/main/window.js | — | 54 |
| src/main/replay-control.js | — | 215 |
| src/main/ipc/guards.js | — | 15 |
| src/main/ipc/terminal.js | — | 76 |
| src/main/ipc/tasks.js | — | 131 |
| src/main/ipc/root-tasks.js | — | 100 |
| src/main/ipc/project-paths.js | — | 233 |
| src/main/ipc/register.js | — | 74 |
| src/main/harness/fixtures.js | — | 178 |
| src/main/harness/driver.js | — | 262 |
| src/main/harness/metrics.js | — | 189 |
| src/main/harness/modes/shots.js | — | 116 |
| src/main/harness/modes/control.js | — | 152 |
| src/main/harness/modes/history.js | — | 204 |
| src/main/harness/modes/provider.js | — | 97 |
| src/main/harness/modes/polish.js | — | 139 |
| kit/done/project-tasks/grade-tasks.mjs | 94 | 100 |
| CLAUDE.md | 40 | 40 |
| kit/SPEC.md | 410 | 411 |

The frozen files are byte-identical to `origin/main`: tracker.js 1573, replay-source.js 1420,
provider-adapters.js 570, `src/preload.js`, `package.json`, `package-lock.json`,
`src/renderer/*` and `assets/*`. Every new module is under the 450-line cap; the largest is
`harness/driver.js` at 262.

## Flakes

None in this session. Every pre-commit and post-commit gate run since the resume was green on
its first attempt. Every commit body on the branch from `891fd94` on carries a fully green
post-commit gate summary, with no FAIL and no packaging SKIP.

## Not done / out of scope

- **The rubric's human check was not done by a human:** `npm start`, open a system, open a
  terminal, assign an idea, scrub history. Coverage instead comes from the archived gates
  that drive the real app headlessly through each test mode:
  - control: terminal button, LIVE/replay gating;
  - history: scrubbing, LIVE return;
  - provider and polish: pointer flows;
  - `kit/grade.mjs` ×3: shots.
- `tracker.js` was not split; §5 of the contract makes that a separate decision.
- Pre-existing modules outside this kit keep their file-scope constant lookup `Set`s, for
  example `FAILURE_CODES` in `agent-launcher.js`. §2.2 applies the collection rule to
  `main.js` and the new modules only.

## Final gate

`node kit/done/main-split/grade-main-split.mjs --full` (no `--stage`, so every check runs):

```
TA PASS  flags and harness fixtures extracted
TB PASS  harness driver, metrics and five modes extracted
TC PASS  app-context and window extracted
TD PASS  replay control and ipc modules extracted
TE PASS  main.js is a 47-line bootstrap; frozen lists updated
T6 PASS  every src/main module within its cap; frozen sizes intact
T7 PASS  no module-level let in src/main
T8 PASS  all frozen-file pins current
T9 PASS  npm test green (ℹ pass 157, ℹ fail 0)
FULL PASS  kit\done\agent-control\grade-control.mjs green
FULL PASS  kit\done\attention\grade-attention.mjs green
FULL PASS  kit\done\galaxy-grouping\grade-galaxies.mjs green
FULL PASS  kit\done\history-playback\grade-history.mjs green
FULL PASS  kit\done\multi-provider\grade-providers.mjs green
FULL PASS  kit\done\packaging\grade-packaging.mjs green
FULL PASS  kit\done\polish-pass\grade-polish.mjs green
FULL PASS  kit\done\project-search\grade-search.mjs green
FULL PASS  kit\done\project-tasks\grade-tasks.mjs green
FULL PASS  kit\done\ship-assets-pack\grade-ships.mjs green
FULL PASS  kit\done\structural-cleanup\grade-structure.mjs green
FULL PASS  kit/grade.mjs run 1 green
FULL PASS  kit/grade.mjs run 2 green
FULL PASS  kit/grade.mjs run 3 green
============= KIT 14 MAIN-SPLIT GRADE (stage all, full) =============
PASS  every check expected at stage all is green, including every archived gate and 3x renderer gate
```

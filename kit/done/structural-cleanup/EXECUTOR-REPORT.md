# Kit 13 — Structural cleanup: executor report

**Verdict: PASS** (executed 2026-09-27 → 2026-09-28 on branch `kit/13-structural-cleanup`).

Executor: Claude Code (Opus-class) in an isolated worktree. The contract named Codex; the
owner's coordinator reassigned it. §2.6 (observable-driven scene dispose) was reversed by
the owner's planner during execution. See "Behaviour notes" below.

Delivered:

- **Task A:** `kit/repin.mjs` re-pins the two hash-pinning gates. It hashes with LF
  normalization, has a `--check` mode, and requires `--note`. `test/repin.test.js` tests it.
- **Tasks 0 + B:** `src/renderer/app.js` (3499 lines) is split into `app-state.js` plus eight
  `AUR.app` modules. `app.js` keeps boot, event routing, view switching, overlay chrome
  scheduling, debug/shots and go, and is now 467 lines.
- **Task C:** one shared path classifier, `src/main/path-safety.js`. Both launchers import it,
  and their local copies are deleted. A follow-up fix tolerates one trailing separator in
  PATH entries.
- **Task D (reversed):** the bounded `isReady()` poll in `disposeSettled` stays. A comment now
  documents why, and gate T5 checks that design.
- **Task E:** the comment about POSIX `codex` shims in `agent-launcher.js` is now accurate.
- **Task F:** CLAUDE.md, `docs/PUBLIC-RELEASE-TASKS.md` (5.1, 5.2 and 5.5 ticked; 5.3 marked
  withdrawn) and both status boards are updated. The kit is archived here.

## Commits

```
(this commit) chore(kit): archive kit 13
5f5f7f8 docs(main): truthful comment on POSIX codex shims in agent-launcher
09ae650 refactor(renderer): document why scene dispose polls isReady (kit 13 §2.6 reversed)
a7adcea fix(main): tolerate a trailing separator in PATH entries
5fcb76b refactor(main): one shared path classifier in path-safety.js
fb6d851 refactor(renderer): extract app-project-tasks
2f1c57e refactor(renderer): extract app-ideas
9af8ecd refactor(renderer): extract app-project-control
592cf2a refactor(renderer): extract app-project-settings
41d73c0 refactor(renderer): extract app-project-search
59d38ed refactor(renderer): extract app-chrome
52565e6 refactor(renderer): extract app-playback
956140c refactor(renderer): extract app-state and app-agent-focus
6ef772c feat(kit): add repin helper
ca095f2 kit: gate tolerates a dirty tree for the packaging check; gate before and after each commit
```

Every commit was gated twice, once before and once right after the commit. The post-commit
run (packaging gate included) is pasted into each commit body.

## What moved where

The split was mechanical. A scope-aware transform built on an acorn AST (a scratchpad tool,
not committed) followed three rules:

- closure variable `x` becomes `S.x` (state) or `C.X` (constants);
- a function called from another file becomes `A.f = function f(…) {…};`;
- every other helper stays a plain function inside its module.

No other renames.

| New file | Contents (from `app.js` sections) |
|---|---|
| `app-state.js` | `store` and `runtime` sections: all 37 closure state variables become `AUR.app.state`; the 13 constants become `AUR.app.const` |
| `app-agent-focus.js` | first-person agent focus (kill switch, task 0) |
| `app-playback.js` | epoch/playback/replay helpers (`epochOf` … `issueReplay`, from the boot section), live/history controls, `historyTestMetrics` (history test hook, from the tab-bar section) |
| `app-chrome.js` | collapsible command rail + recent strip; agents/feed/summary renderers (`shipsSorted` … `planetSummaryStats`, physically in the old settings section); tab bar + back button |
| `app-project-search.js` | universe project search; searchable all-projects directory |
| `app-project-settings.js` | project path settings (`wireProjectSettings` … `renderProjectSettings`) |
| `app-project-control.js` | project card; `renderProjectCard`/`pcRow` (physically in the old tasks section); planet card |
| `app-ideas.js` | root task ideas |
| `app-project-tasks.js` | project tasks |

`index.html` loads the files in this order: `scene-planet.js` → `app-state.js` → the other
`app-*.js` alphabetically → `app.js`. The only frozen-file change is those script tags, and
`kit/repin.mjs` re-pinned them after every module commit.

Verification beyond the gates, run on every module commit:

- **Static checker:**
  - No identifier resolves to nothing, compared with the globals of the original app.js.
  - Every `S.x` / `C.x` exists in app-state.js.
  - Every `A.f` used is assigned somewhere.
  - No module calls another module at load time.
- **Token-level equivalence:** every top-level statement of the original matches the
  output once the `S./C./A.` mapping is undone. The only differences are the load guards and
  shorthand properties expanded (`{ store }` → `{ store: S.store }`).
- **Live CDP smoke test** against `electron . --shots` covered:
  - agent focus enter, vantage switch and exit;
  - search type and clear;
  - settings open and close;
  - ideas toggle;
  - the history hooks.

  No renderer exceptions or console errors.

## Line counts (`wc -l`), origin/main → final

| File | Before | After |
|---|---|---|
| src/renderer/app.js | 3499 | 467 |
| src/renderer/app-state.js | — | 162 |
| src/renderer/app-agent-focus.js | — | 346 |
| src/renderer/app-playback.js | — | 523 |
| src/renderer/app-chrome.js | — | 368 |
| src/renderer/app-project-search.js | — | 482 |
| src/renderer/app-project-settings.js | — | 332 |
| src/renderer/app-project-control.js | — | 240 |
| src/renderer/app-ideas.js | — | 401 |
| src/renderer/app-project-tasks.js | — | 278 |
| src/renderer/index.html (script tags only) | 347 | 356 |
| src/main/path-safety.js | — | 84 |
| src/main/agent-launcher.js | 379 | 363 |
| src/main/terminal-launcher.js | 191 | 185 |
| kit/repin.mjs | — | 68 |
| test/repin.test.js | — | 66 |
| test/path-safety.test.js | 158 | 253 |
| test/agent-launcher.test.js | 333 | 362 |
| test/agent-focus-hologram.test.js | 68 | 73 |
| kit/done/agent-control/grade-control.mjs | 415 | 426 |
| kit/done/history-playback/grade-history.mjs | 412 | 415 |
| kit/done/multi-provider/grade-providers.mjs | 366 | 369 |
| kit/todo/13-structural-cleanup.md → kit/done/structural-cleanup/CONTRACT.md | 303 | 308 |
| kit/todo/grade-structure.mjs → kit/done/structural-cleanup/grade-structure.mjs | 178 | 189 |

The other renderer files are unchanged. Frozen files: galaxy-layout 178, polish-math 56,
scene-planet 196, scene-system 618, scene-universe 971, util 408. Not frozen but untouched:
procedural-worlds 328, search-core 33, ship-assets 300. Across the branch,
`git diff --stat origin/main -- <every frozen file except index.html>` is empty.

## Behaviour notes

### Task C: judgment calls in `src/main/path-safety.js`

Where the launchers' former copies disagreed, the stricter rule wins (§2.5):

- **`pathFlavor`** returns `'win32' | 'posix' | null`. UNC and `//host/share` are null. The
  old agent-launcher copy treated UNC as win32. `isCodexExecutablePath` now looks the path
  module up by name.
- **`validPathString`** allows at most 4096 characters and no NUL or other control
  characters. Before, the limit was 32767 and only NUL was rejected.
- **`isCanonicalPath`** additionally rejects a trailing separator, with drive roots
  excepted. So **the POSIX root `/` is not canonical**: only drive roots such as `C:\` are
  excepted.
- **`isAbsolutePosixPath`** uses the stricter reading of its table row. It keeps the
  terminal launcher's former validity and normalization checks and adds
  `pathFlavor === 'posix'`. The row's literal "`pathFlavor === 'posix'`" alone would have
  loosened the macOS terminal check, and the table header says the stricter copy wins.
- **`isInsidePath`** keeps its former case folding. That fails closed on the launcher's
  "executable must not live inside the project" check.
- **PATH entries with a trailing separator.** The "no trailing separator" rule made
  `resolveCodexExecutable` skip entries such as `C:\Users\x\AppData\Roaming\npm\`, which
  regressed IDEAS → Codex on such machines. Commit
  `fix(main): tolerate a trailing separator in PATH entries` strips exactly one trailing
  separator from each PATH entry before the canonical check. Roots (`C:\`, `/`) are never
  stripped, and path-safety.js semantics are unchanged. New tests in
  `test/agent-launcher.test.js` show that `…\npm\`, `…\npm/` and `…\Codex\` resolve to the
  same executable as the plain entry (Windows and macOS), and that a doubled separator is
  still skipped.
- `isLocalProjectPath` and `canonicalProjectPath` are re-exported unchanged from the frozen
  `provider-adapters.js`. `tracker.js` / `replay-source.js` keep their `relativeInside`.

### §2.6 reversed: scene dispose keeps the bounded `isReady()` poll

§2.6 said to dispose when the BRDF texture's `onLoadObservable` fires, on the assumption
that this marks decode completion. In Babylon 9.28 it does not: `onLoadObservable` is the
hook that *starts* the decode. `RGBDTextureTools.ExpandRGBDTexture` sets the internal
texture's `isReady` to false, then `e.onLoadObservable.addOnce(o)`, where `o` runs the
asynchronous RGBD decode (shader import, post-process, effect compile, direct render) and
only then sets `i.isReady=!0`. The original design therefore either disposes mid-decode,
which is the crash the function exists to prevent, or never fires and always waits the
4 s fallback. Execution blocked on this, and the owner's planner reversed the decision.
The poll stays and is documented in `disposeSettled`, and gate T5 checks that design.

Runtime probe (CDP against `electron . --shots`; five fresh scenes, times in ms after
`GetEnvironmentBRDFTexture`):

```
run  readyAtCreate  onLoadAt  readyAtOnLoad  readyAt  lateAddOnceFired
1    false          53.9      false          90.5     false
2    false          1.0       false          19.3     false
3    false          0.9       false          21.2     false
4    false          1.1       false          21.0     false
5    false          0.8       false          22.7     false
no renderer exceptions or console errors
```

`isReady()` is still false when `onLoadObservable` fires, and the decode finishes 20–37 ms
later. An `addOnce` registered after the load event never fires.

The §4 rubric row and the §7 executor prompt in `CONTRACT.md` still describe the original
observable design. They were left as distilled; §0 and §2.6 carry the reversal.

### Unlisted grep site: `test/agent-focus-hologram.test.js`

This test read only `app.js`, and the contract did not list it. It received the same §2.3
widening as the three archived gates: the sorted concatenation of every
`src/renderer/app*.js`, with the kit 13 comment. One assertion,
`Object\.hasOwn\(AGENT_FOCUS_ENVIRONMENTS,`, now names the constant the way §2.1 requires:
`Object\.hasOwn\(C\.AGENT_FOCUS_ENVIRONMENTS,`. It is exactly as strict; the prefix is not
optional. No regex in any archived gate was loosened.

### Recorded `kit/grade.mjs` flake

This happened once, on the first post-commit run of `refactor(renderer): extract app-chrome`:
run 2 of 3 was red. A standalone `node kit/grade.mjs` right after passed, and the whole
post-commit run was repeated fully green. The commit body records it. No other gate run on
this branch was red.

### Other notes

- **Contract fix (commit 0).** The packaging gate's W0 check fails whenever the tree is dirty,
  so the gate reports it as SKIP pre-commit, and every task is gated again right after its
  commit.
- **Stale branch deletion.** Deleting the stale local `kit/13-structural-cleanup` branch
  meant switching the primary checkout (same commit) to `main`. Its untracked files were
  left alone.

## Final gate

`node kit/done/structural-cleanup/grade-structure.mjs --full` (no `--stage`; everything checked):

```
T1 PASS  all 19 renderer files within caps
T2 PASS  index.html loads 9 module(s) between app-state.js and app.js
T3 PASS  AUR.app owned by app-state.js; every module guards its load order
T4 PASS  one path classifier in path-safety.js; launchers import it
T5 PASS  disposeSettled is a documented, bounded isReady() poll
T6 PASS  all frozen-file pins current
T7 PASS  npm test green (ℹ pass 157, ℹ fail 0)
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
FULL PASS  kit/grade.mjs run 1 green
FULL PASS  kit/grade.mjs run 2 green
FULL PASS  kit/grade.mjs run 3 green
PASS  every check expected at stage all is green, including every archived gate and 3x renderer gate
```

## Not done / out of scope

- Task 5.4 (mapped network drives) stays parked, as the contract says.
- The rubric's human check (open the app, universe → system → planet → back, terminal
  button, agent focus, history slider) was not done by a human. The CDP smoke test above
  covers agent focus, navigation back to the universe, search, settings, ideas and the
  history hooks. The polish, control and history gates cover the pointer flows, the
  terminal button and the history controls.

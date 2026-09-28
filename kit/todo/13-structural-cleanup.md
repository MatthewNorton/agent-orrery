# Kit 13 — Structural cleanup (Phase 5 of `docs/PUBLIC-RELEASE-TASKS.md`)

Distilled 2026-09-27. Executor: **Codex** (`codex` CLI in this checkout). Fallback:
**none — stop and report**; no other model may substitute without the owner saying so.
Gate: `node kit/todo/grade-structure.mjs` (FAILS cleanly until built; `--full` also
runs every archived gate and the renderer gate three times). On completion the
executor moves this file and the gate to `kit/done/structural-cleanup/` with an
`EXECUTOR-REPORT.md`, exactly like the other archived kits.

## 0. Brief

Three behaviour-preserving refactors plus two small hygiene items, in a fixed
order, each landing as its own commit on branch `kit/13-structural-cleanup`,
with every gate green after every commit:

| # | Item | Size |
|---|---|---|
| A | `kit/repin.mjs` — one-command re-pin helper for the two hash-pinning gates | ~20 min |
| 0 | **Kill switch**: extract ONE module (agent focus) from `app.js` using the module mechanism in §2 | ~1 h |
| B | Extract the remaining modules until every renderer file is ≤ 600 lines | ~3–4 h |
| C | One shared path classifier `src/main/path-safety.js`; launchers use it | ~1.5 h |
| D | Scene dispose waits on the BRDF texture's load observable, not a 50 ms poll | ~30 min |
| E | Truthful comment on POSIX `codex` shims in `agent-launcher.js` (no behaviour change) | ~10 min |
| F | Gate maintenance, docs, archive the kit | ~30 min |

Out of scope, do not touch: task 5.4 (mapped network drives; needs hardware, parked),
the `relativeInside` copies inside `tracker.js` and `replay-source.js` (frozen files;
migrating them needs an explicit unfreeze, see §2.5), any visual or behavioural change.

## 1. Hard constraints (inherited; violating any one fails the kit)

- Renderer is plain JS with classic `<script>` tags: **no ES modules, no `import`/`export`,
  no bundler, no TypeScript, no new npm packages.** Script load order in
  `src/renderer/index.html` provides globals. Everything hangs off `window.AUR`.
- **Frozen files never change**: `src/main/main.js`, `src/main/tracker.js`,
  `src/main/replay-source.js`, `src/main/provider-adapters.js`, `src/preload.js`,
  `package.json`, `package-lock.json`, `assets/*`, `src/renderer/util.js`,
  `src/renderer/scene-*.js`, `src/renderer/galaxy-layout.js`, `src/renderer/polish-math.js`,
  the mockup PNGs. The **one** pinned file this kit may edit is `src/renderer/index.html`
  (script tags only). `git diff --stat main -- <that list minus index.html>` must be empty
  at every commit.
- Behaviour is identical before and after. Proof is mechanical: `npm test`, all ten
  `kit/done/*/grade-*.mjs`, and `node kit/grade.mjs` **three consecutive green runs**
  (it is the flaky one) after every commit. No screenshot may change meaning.
- One `BABYLON.Engine` for the app lifetime; each view builds its own scene and disposes
  it on view switch (unchanged).
- No `git add -A`. Author email is the repo default (already the noreply address).

## 2. Decisions (made here so the executor never has to)

### 2.1 Module mechanism — `AUR.app`

- `src/renderer/app-state.js` is loaded first among the app files and is the **only**
  file that assigns `AUR.app = { ... }`. It owns everything that today is closure state at
  the top of `app.js` (the `store` object and its caps, the `runtime` `let`s such as
  `engine`, `canvas`, `activeView`, `activeScene`, `current`, `routeRequestGeneration`,
  `booting`, playback/notification/search timers, DOM element caches) as **properties
  of `AUR.app.state`**, and the constants (`FEED_CAP`, `REPLAY_SPEEDS`, …) as
  `AUR.app.const`.
- Every other module is one IIFE:
  ```js
  // app-<name>.js — <one line purpose>
  'use strict';
  (function () {
    const AUR = window.AUR;
    const A = AUR.app;               // created by app-state.js; throw if missing
    if (!A) throw new Error('app-state.js must load before app-<name>.js');
    const S = A.state, C = A.const;
    A.wireThing = function wireThing() { /* … */ };
    A.renderThing = function renderThing() { /* … */ };
  })();
  ```
- **No module calls another module's function at load time.** Every `A.<fn>(…)` call sits
  inside a function body, so load order among `app-*.js` files does not matter; only
  `app-state.js` first and `app.js` last is required.
- `app.js` keeps the orchestration only: boot, event routing (`handleEvents`,
  `applyEvent`, `routeEvents`…), view switching (`setView`, `openSystem`, …,
  `disposeSettled`), chrome scheduling (`scheduleChrome`, `renderChrome`), debug/shots
  hooks, and `boot()` calling the `A.wire*()` functions. It reads state through `A.state`
  like everyone else.
- Mechanical rule for the move: a closure variable `x` becomes `S.x`; a closure function
  `f` that other modules need becomes `A.f`; a helper used by one module only stays a
  plain function inside that module's IIFE. Do not rename anything else.

### 2.2 File map (starting point; split further if a file would exceed 600 lines, never merge)

Section headers are the `// ---------- name ----------` comments already in `app.js`.

| New file | Sections moved out of `app.js` |
|---|---|
| `app-state.js` | store, runtime, constants |
| `app-agent-focus.js` | first-person agent focus **(kill switch, task 0)** |
| `app-playback.js` | epoch/playback/replay helpers (`epochOf` … `issueReplay`), live/history controls |
| `app-chrome.js` | collapsible command rail + recent, agents/feed/summary renderers, tab bar |
| `app-project-search.js` | universe project search, searchable all-projects directory |
| `app-project-settings.js` | project path settings |
| `app-project-control.js` | project card, planet card |
| `app-ideas.js` | root task ideas |
| `app-project-tasks.js` | project tasks |

Stays in `app.js`: boot, event routing, view switching, overlay chrome scheduling,
debug/shots, go. Expected size ≈ 450 lines.

`index.html` load order: after `scene-planet.js` → `app-state.js` → the other
`app-*.js` in alphabetical order → `app.js` last.

### 2.3 Archived gates that grep `app.js`

`kit/done/agent-control/grade-control.mjs`, `kit/done/history-playback/grade-history.mjs`
and `kit/done/multi-provider/grade-providers.mjs` do `read('src/renderer/app.js')` and
grep feature strings (`project-terminal`, `streamEpoch`, `/provider/i`, …). After the
split those strings live in modules. Change each `appSource` to the concatenation of
**every** `src/renderer/app*.js` (sorted), with the comment
`// 2026-09-27 kit 13: app.js split into app-*.js modules; grep the whole app layer.`
Do **not** loosen any regex. `kit/done/project-search/grade-search.mjs` checks
`search-core.js` loads before `app.js`; that stays true and needs no change.

### 2.4 Re-pinning (`kit/repin.mjs`, task A)

The agent-control and history-playback gates pin SHA-256 digests of frozen files
(LF-normalized: read as UTF-8, replace CRLF with LF, hash). Editing `index.html` script
tags changes its pin. Write `kit/repin.mjs`:

- Finds every line matching `['<relative path>', '<64 hex>']` inside the two gate files
  and recomputes the hex from the file on disk with the LF-normalized digest above.
- Default mode rewrites stale hexes in place, preserving the file's own line endings, and
  inserts one comment line `// <YYYY-MM-DD> re-pinned: <paths> — <note>` directly above
  the `const frozen = new Map([` line, where `<note>` comes from `--note "<text>"`
  (required in rewrite mode; refuse without it).
- `--check` mode changes nothing, prints each stale pin as `STALE <gate> <path>`, and
  exits 1 if any; exits 0 with `all pins current` otherwise.
- Node built-ins only, ESM, under 80 lines. Add `test/repin.test.js`: run `--check`
  against a temp copy with one deliberately wrong hex and assert exit 1 and the STALE line.

In this kit only `src/renderer/index.html` may ever show up as stale. If `--check`
reports any other path, you edited a frozen file: revert it.

### 2.5 Shared path classifier (task C)

Create `src/main/path-safety.js` (CommonJS, Node built-ins only) exporting:

| Export | Semantics (the stricter of today's copies wins) |
|---|---|
| `pathFlavor(value)` | `'win32'` for `X:\…`/`X:/…`, `'posix'` for `/…`, `null` otherwise. UNC (`\\host\share`) and `//host/share` are **null**. |
| `validPathString(value)` | non-empty string, ≤ 4096 chars, no NUL, no control chars |
| `isCanonicalPath(value)` | `validPathString` **and** `pathFlavor` non-null **and** the path equals its own `path.<flavor>.normalize` result with no trailing separator (drive roots excepted) and no `..`/`.` segments |
| `isCanonicalPathFor(value, platform)` | `isCanonicalPath` **and** flavor matches `platform` (`win32` ↔ `'win32'`, else `'posix'`) |
| `isAbsolutePosixPath(value)` | `pathFlavor === 'posix'` |
| `isInsidePath(root, candidate)` | both canonical, same flavor, and `path.<flavor>.relative(root, candidate)` is `''` or has no leading `..` and is not absolute |
| `isLocalProjectPath`, `canonicalProjectPath` | **re-exported** unchanged from `./provider-adapters` (that file is frozen; do not move code out of it) |

Then `src/main/agent-launcher.js` and `src/main/terminal-launcher.js` `require('./path-safety')`
and **delete** their local `pathFlavor`, `validPathString`, `isCanonicalPath`,
`isCanonicalPathFor`, `isInsidePath`, `isAbsolutePosixPath`. Their existing tests must
still pass unchanged; add `test/path-safety.test.js` cases for every row above including
the UNC and `//host/share` rejections and a Windows-vs-POSIX `isInsidePath` mismatch.
`tracker.js` / `replay-source.js` keep their `relativeInside` (frozen).

### 2.6 Scene dispose (task D)

In `disposeSettled(view)` (currently `app.js` ≈ line 631): keep the synchronous path
exactly as is (`settled()` true → `view.dispose()` immediately). For the pending case,
replace the 50 ms `setTimeout` chain with: `detachControl()` as today, then
`pending.onLoadObservable.addOnce(finish)` **and** one fallback `setTimeout(finish, 4000)`;
`finish` is idempotent (a `done` flag) and clears the fallback timer. If
`pending.onLoadObservable` is missing, fall back to the timer alone. Net effect: disposal
happens the moment the BRDF decode completes, never later than 4 s, never twice.

### 2.7 Launcher comment (task E)

`src/main/agent-launcher.js` ≈ lines 116–124 says the npm wrapper "is never executed".
True for npm's symlink/`codex.cmd` case, false for a regular executable named `codex`
on PATH (pnpm, volta, asdf shims): that file **is** spawned with `shell: false` and runs
through its shebang. Rewrite the comment to say exactly that. No code change.

## 3. Order of work and the kill switch

1. **Task A** (`kit/repin.mjs` + test). Commit `feat(kit): add repin helper`.
2. **Task 0 — kill switch.** Create `app-state.js` and `app-agent-focus.js` only; wire
   them in `index.html`; `node kit/repin.mjs --note "kit 13 task 0: app-state/app-agent-focus split"`;
   apply §2.3 to the three gates; run `node kit/todo/grade-structure.mjs --full`.
   **If the renderer gate or any archived gate fails for a reason attributable to the
   module mechanism, STOP. Revert to `main`, write `kit/BLOCKED.md` with the failure,
   and report. Do not try a different mechanism.** Otherwise commit
   `refactor(renderer): extract app-state and app-agent-focus`.
3. **Task B**, one module per commit in the §2.2 order, `--full` green before each commit.
4. **Task C**, **Task D**, **Task E**, one commit each, `--full` green before each.
5. **Task F**: update `CLAUDE.md` renderer-size bullet to `Renderer files stay under
   ~600 lines (scene-universe.js and scene-system.js are frozen at their current size).`
   and describe the `AUR.app` module rule in one sentence under Architecture → Renderer;
   tick 5.1, 5.2, 5.3, 5.5 in `docs/PUBLIC-RELEASE-TASKS.md`; move this file to
   `kit/done/structural-cleanup/CONTRACT.md` and the gate to
   `kit/done/structural-cleanup/grade-structure.mjs` (fix its relative paths); add the
   status-board rows in `kit/README.md` and `kit/todo/README.md`; write
   `kit/done/structural-cleanup/EXECUTOR-REPORT.md` (what moved where, line counts before
   and after, every gate's final output). Commit `chore(kit): archive kit 13`.
6. Push the branch and open a PR to `main` with the executor report as the body. Do not merge.

## 4. Rubric (what "done" means)

| Check | Mechanical? | How |
|---|---|---|
| Every `src/renderer/*.js` ≤ 600 lines; `scene-universe.js` ≤ 971 and `scene-system.js` ≤ 618 (frozen) | yes | gate T1 |
| `index.html` loads `app-state.js` first, all `app-*.js` before `app.js`; every module on disk is loaded and vice versa; no `type="module"`, no `import`/`export` | yes | gate T2 |
| Exactly one `AUR.app =` assignment, in `app-state.js`; every module IIFE throws if `AUR.app` is missing | yes | gate T3 |
| `path-safety.js` exports the eight names; launchers import it and define none of the six helpers locally | yes | gate T4 |
| `disposeSettled` uses `onLoadObservable`, no 50 ms poll remains | yes | gate T5 |
| `node kit/repin.mjs --check` exits 0 | yes | gate T6 |
| `npm test` green (existing + new tests) | yes | gate T7 |
| All ten archived gates green, `kit/grade.mjs` green ×3 | yes | gate `--full` |
| No frozen file changed except `index.html` script tags | yes | `git diff --stat main -- <§1 list>` empty; PR checklist |
| No behaviour change | partly | gates above + a human opens the app once: universe → system → planet → back, open a project's terminal button, toggle agent focus, drag the history slider |

Reject examples: a module that reads a DOM element at load time (breaks under `--shots`);
a `wire*` function moved but its `render*` counterpart left in `app.js` (split by feature,
not by verb); a regex in an archived gate loosened to make it pass; `relativeInside`
"deduplicated" out of `tracker.js`.

## 5. Offload map

Frontier work, done here: module mechanism, file map, classifier semantics, dispose
design, gate-maintenance rules, the gate script. Everything else, including every line
moved, is mechanical and belongs to the executor.

## 6. Objections, pre-answered

- *"Why not one big `app.js` refactor commit?"* Because the renderer gate is flaky and
  the archived gates grep source strings; per-module commits make a failure bisect itself.
- *"Why keep `relativeInside` duplicated in `tracker.js`?"* It is frozen and hash-pinned
  by two gates; removing four lines of duplication is not worth a frozen-file exception.
- *"Why `AUR.app.state` instead of passing a deps object?"* The code base already uses
  one global namespace (`AUR`) and classic script tags; a deps object would need a
  factory per module and a load-time call graph, which is the thing §2.1 forbids.
- *"600 lines is arbitrary."* It is the repo's existing rule in `CLAUDE.md`; the kit makes
  the rule true rather than relitigating it.

## 7. Executor prompt (paste verbatim into Codex, run from the `agent-orrery` checkout)

```
You are executing kit 13 in this repository. Read, in this order, before touching any file:
CLAUDE.md, kit/SPEC.md, kit/todo/13-structural-cleanup.md (the contract; it overrides
anything else you assume), kit/todo/grade-structure.mjs (the gate), kit/done/attention/README.md
and kit/done/project-search/CONTRACT.md (examples of how finished kits are archived).

Then execute kit/todo/13-structural-cleanup.md end to end, in the order of its section 3,
on a new branch kit/13-structural-cleanup created from main. Rules that are not negotiable:

1. Every decision in section 2 of the contract is already made. Do not redesign the module
   mechanism, the file map, the classifier semantics or the dispose approach. If a decision
   cannot be implemented as written, stop, write kit/BLOCKED.md explaining exactly why, and
   report; do not improvise an alternative.
2. Task 0 is a kill switch. If node kit/todo/grade-structure.mjs --full is not fully green
   after task 0 for a reason attributable to the module mechanism, revert to main, write
   kit/BLOCKED.md, and stop.
3. One commit per task (task B is one commit per extracted module). Before every commit run
   node kit/todo/grade-structure.mjs --full and paste its summary lines into the commit body.
   Never commit with a red gate.
4. Frozen files never change. The only pinned file you may edit is src/renderer/index.html,
   script tags only. Before every commit run
   git diff --stat main -- src/main/main.js src/main/tracker.js src/main/replay-source.js src/main/provider-adapters.js src/preload.js package.json package-lock.json src/renderer/util.js src/renderer/scene-universe.js src/renderer/scene-system.js src/renderer/scene-planet.js src/renderer/galaxy-layout.js src/renderer/polish-math.js
   and it must print nothing. If node kit/repin.mjs --check reports any stale path other
   than src/renderer/index.html, you edited a frozen file: revert it.
5. Behaviour is preserved exactly. Move code, do not rewrite it. No renames beyond the
   closure-variable to A.state / A.<fn> mapping described in section 2.1. No visual changes.
6. Plain JavaScript only: classic script tags, no import/export, no new dependencies, no
   TypeScript, no bundler. Use git add with explicit paths, never git add -A. Do not change
   git config. Do not merge the PR.
7. Finish with task F: archive the kit under kit/done/structural-cleanup/ with an
   EXECUTOR-REPORT.md that lists every file created or moved with line counts before and
   after, the final output of node kit/done/structural-cleanup/grade-structure.mjs --full,
   and anything you could not do. Push the branch and open a pull request to main with that
   report as the body.

Work autonomously; do not ask questions. When you are done, reply with the PR URL and the
final gate output, nothing else.
```

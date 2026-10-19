# Public release task list

Captured 2026-09-27 from a full code review (`src`, `scripts`, `test`), a
history leak scan, and the GitHub hygiene work merged in #26. The plan was to
go public through a **fresh repository with a single clean commit** and keep
the original repository as a private archive of the history.

This repository (`agent-orrery`) is that fresh snapshot, taken 2026-09-27.
PR numbers below (#24-#34) refer to the private archive `agent-universe-lite`,
not to this repository.

Effort figures are **agent-session time**: how long a Claude Code / Codex
session takes end to end, including running tests and gates. Human time is
the review of each PR, roughly 10–15 minutes per phase. Nothing here is
faster by hand.

Status legend: `[ ]` open · `[x]` done · `[~]` in progress · `[-]` skipped.

## Phase 0 — Already done

- [x] Security audit findings (UNC cwd, planet traversal, IPC frame checks,
      permission handler) fixed in #24.
- [x] Kit gates green on real Electron, frozen hashes re-pinned in #25.
- [x] LICENSE, SECURITY.md, SHA-pinned CI, Dependabot, CODEOWNERS, PR
      template, lab fixture scrub in #26.
- [x] GitHub: delete-branch-on-merge, auto-merge, update-branch, ruleset
      "main protection" (PR + both CI checks required, admin bypass).
- [x] Git author email switched to the GitHub noreply address.

## Phase 1 — Bug fixes (blocker for snapshot) · ~2–3 h · one PR

All four were introduced by the security hardening in #24 and verified by
running the code, not just reading it.

- [x] **1.1 Null project key crashes the main process.**
      `src/main/tracker.js:936` hashes `canonicalProjectPath(signal.cwd)`,
      which now returns `null` for UNC, relative, or backslash-bearing cwds.
      `fnv1a(null)` throws outside every try/catch in the poll loop and
      escapes into the `setInterval` tick. Trigger: a Codex session whose
      cwd is `\\wsl.localhost\...`. Fix: guard the null before hashing and
      skip the signal (or fall back to the raw cwd for the key only).
      Verify: unit test with a UNC cwd signal; `node kit/done/multi-provider/grade-providers.mjs`.
- [x] **1.2 Leading-space cwd crashes the main process.**
      `src/main/tracker.js:583` — `canonicalProjectPath` trims the path but
      `preferredProjectPath` validates the untrimmed string, returns `null`,
      and `path.basename(null)` throws. Fix: trim once at the entry of
      `ensureProjectForPath` and pass the trimmed value everywhere.
      Verify: unit test with `' /home/u/proj'`.
- [x] **1.3 Desktop notifications silently disabled.**
      `src/main/window-security.js:36-39` denies every permission including
      `notifications`, so `maybeNotifyAttention` in `src/renderer/app.js:585`
      never shows anything. `test/window-security.test.js:61` asserts the
      denial and must be updated. Fix: allow `notifications` only, only for
      the trusted main frame; keep everything else denied.
      Verify: `npm test`; `node kit/done/attention/grade-attention.mjs`;
      manual: trigger a permission prompt in a live session and see the toast.
- [x] **1.4 Planet lookup with inherited property names.**
      `src/main/tracker.js:1375` reads `project.buckets[planetName]` on a
      plain object, so `constructor` returns a function that fails structured
      clone over IPC. Fix: `Object.hasOwn` guard (or `Object.create(null)`
      buckets at both creation sites, lines 418 and 588).
      Verify: unit test calling `getPlanet(id, 'constructor')` returns a
      plain object with `builds: 0`.

Frozen-file note: 1.1, 1.2 and 1.4 touch `src/main/tracker.js`. That file is
frozen per `kit/SPEC.md`; the edits are authorized here as security follow-ups
and must be recorded in Phase 2.1.

## Phase 2 — Docs honesty · ~30 min · same PR as Phase 1

- [x] **2.1 Record the security unfreeze in `CLAUDE.md`.** Note that
      `main.js`, `tracker.js`, `replay-source.js`, `provider-adapters.js` were
      edited under #24 and this task list, and that security fixes are the
      one standing exception to the freeze.
- [x] **2.2 Fix the renderer size rule.** `CLAUDE.md` says "~600 lines";
      `src/renderer/app.js` is 3499, `scene-universe.js` 971,
      `scene-system.js` 618. Either state the real rule ("new renderer files
      stay under ~600; `app.js` is the known exception, see Phase 5") or make
      the rule true (Phase 5). Do not leave the doc lying.

## Phase 3 — Pre-snapshot leak cleanup · ~30 min · one PR

Everything the fresh repo's single commit must not contain.

- [x] **3.1 Delete `kit/done/attention/output/`.** Three state JSONs hold 27
      real paths under the user folder; three PNGs show real project names.
      No gate reads the folder (confirmed by grep across `kit/`).
- [x] **3.2 Scrub `kit/done/packaging/EXECUTOR-REPORT.md:47-48`.** Two
      shortcut paths under the user folder → `%USERPROFILE%\Desktop\...` and
      `%APPDATA%\...`.
- [x] **3.3 Commit or drop the parked installer todo.** The packaging gate
      scans `git status` and currently fails on the untracked
      `kit/todo/12-standalone-installer.md`.
- [x] **3.4 Re-run the full leak grep** after 3.1–3.3 and record the result
      here. Expected remaining hits are all benign: the fake `/home/alice`
      fixture in the galaxy gate, the `ai.digitalbyte` bundle id, and the
      public username in test fixtures, docs and CODEOWNERS.
      Result 2026-09-27: only those benign hits remain (see PR).

## Phase 4 — Fresh repository · ~1 h · manual + agent

Order matters. Steps 4.1–4.3 are the last window where history rewrites are
free.

- [x] **4.1 Merge Phases 1–3** into this repo so the archive matches the
      snapshot exactly.
- [x] **4.2 Decide Dependabot PRs #27 (Babylon group) and #30 (Electron
      43→44 major).** `package.json` is kit-frozen; either merge both now and
      re-run `node kit/grade.mjs` + all `kit/done/*/grade-*.mjs`, or close
      them and let Dependabot re-open on the new repo. Recommendation: merge
      the Babylon group, hold Electron 44 until after the snapshot.
      Done: both merged before the snapshot.
- [-] **4.3 Delete stale branches**: local `chore/public-readiness` and 23
      merged local branches; remote `feat/cross-platform-and-security-hardening`
      and `feat/point-of-view-improvements` (three gmail-authored commits).
      Moot: the fresh repository carries none of them.
- [-] **4.4 Archive this repo.** Move the local `.git` to a sibling folder
      (keeps all local branch history). On GitHub: rename to
      `agent-universe-lite-archive`, then mark archived (read-only).
      Skipped by choice: the old repository stays private and writable.
- [x] **4.5 Create the fresh repo.** Confirm `git config user.email` is the
      noreply address. `git init`, add exactly the tracked file set, one
      commit, push to a new **private** repository (created as `agent-orrery`).
- [x] **4.6 Verify in a clean clone**: `npm ci` (see
      `launch-shortcut-fragility` memory: needs `install-electron`),
      `npm test`, `node kit/grade.mjs`, every `kit/done/*/grade-*.mjs`.
- [x] **4.7 Re-apply GitHub settings** after the first CI run on the new
      repo: delete-branch-on-merge, auto-merge, update-branch, the
      "main protection" ruleset with both `test (…)` checks and admin bypass.
      Settings do not travel with the code; CI and Dependabot files do.
- [ ] **4.8 Flip to public.** Then enable secret scanning + push protection
      and private vulnerability reporting (both unavailable while private on
      this plan). Turn on "Block command line pushes that expose my email" in
      GitHub account settings.

## Phase 5 — Structural cleanup · after going public · separate PRs

None of these block release. Each is a kit-sized job.

- [x] **5.1 Split `src/renderer/app.js` (3499 lines).** Natural seams:
      command rail, playback/timeline, attention + notifications, project
      directory/search, view orchestration. Target ≤ 600 lines per file, plain
      `<script>` load order, `window.AUR` namespace. Gate: `node kit/grade.mjs`
      three consecutive green runs (it is the flaky one). ~4–6 h.
- [x] **5.2 One shared path classifier.** Four copies exist and already
      disagree on UNC roots: `terminal-launcher.js:160`,
      `agent-launcher.js:324`, `provider-adapters.js` (`isLocalProjectPath`),
      `tracker.js` (`relativeInside`) / `replay-source.js` (`safeRelative`).
      Export `classifyPath` / `isCanonicalPath` / `isInsidePath` from
      `provider-adapters.js` and delete the copies. ~2 h. Landed as
      `src/main/path-safety.js` (kit 13).
- [-] **5.3 Replace scene-dispose polling.** `src/renderer/app.js:640`
      polls every 50 ms for up to 4 s holding two scenes live. Use the BRDF
      texture's `onLoadObservable.addOnce` (or `scene.executeWhenReady`) with
      a single fallback timeout. ~1 h. Withdrawn 2026-09-28: Babylon exposes no decode-complete signal; poll kept and documented (kit 13).
- [ ] **5.4 Mapped network drives on Windows** (unverified).
      `src/main/ipc/terminal.js:24` (`liveProjectCwd`; `main.js:491` before
      kit 14) re-checks `isLocalProjectPath` after
      `realpathSync.native`, which resolves `Z:\` to UNC, so Open Terminal
      reports NOT_FOUND for a project the map shows as existing. Drop the
      post-realpath check; the pre-realpath one is the protective one. ~30 min
      plus a mapped-drive test machine.
- [x] **5.5 POSIX `codex` shims** (unverified). `src/main/agent-launcher.js:118`
      spawns any regular executable named `codex` (pnpm/volta shims), which
      the comments say never happens. Decide whether that is acceptable and
      fix either the code or the comment. ~30 min.

- [x] **5.6 Gate hashes depend on checkout line endings.** The agent-control
      and history-playback gates pin SHA-256 of frozen files as checked out:
      most are pinned as CRLF bytes but `src/renderer/galaxy-layout.js` and
      `src/renderer/polish-math.js` are pinned as LF, so a fresh Windows
      checkout with `autocrlf=true` fails both gates on unmodified `main`
      (found 2026-09-27 while landing PR #32). Fix: hash with line endings
      normalized to LF inside the gate scripts, then re-pin once. ~30 min.

## Phase 6 — Visual quality before public · ~6–8 h · three PRs

Added 2026-10-18 and rescoped the same day. Two investigations that day
(measurements, the planet design and the parked items are in
`kit/todo/15-visual-quality.md`) found that every view holds a vsync-locked
60 fps at every quality tier on the owner's machine, even at 40 projects and
an emulated 4K viewport, so what precedes the flip is narrow: repair the
gates, remove dead per-frame cost, and let viewers set quality. The
procedural-planet pipeline, the sun, the idle frame cap, glyph consolidation
and the Ultra tier are parked on the todo list; the owner decides whether any
of them precede the flip.

Effort is session time as defined above. Every item: one PR, a `/simplify`
pass before it is reported ready, `node kit/grade.mjs` and every done-kit gate
green on a committed tree, `npm test` and `npm run typecheck` green.

- [x] **6.0 Gate repair, gate runner, CI.** Done 2026-10-18, PR #54. Four of
      the thirteen gates were red on `main` and nobody had noticed, because CI
      ran only typecheck and unit tests. Polish P4 grepped all of `src/main`
      for `.click()` while the screenshot harness has folded panels that way
      since 2026-10-14; the check now covers the input harness only, with
      `harness/modes/shots.js` excluded by name. Agent-control C5: the test
      window shared the viewer's `localStorage`, so the folded-panel set the
      screenshot mode persists hid the project card in every later control
      run (button 0×0, card hidden). The harness now prints those rectangles
      in its timeout; #50 (carried by #49) already stops the leak with an
      in-memory partition for test runs, so C5 goes green on `main` when #49
      merges. The two `--full` gates were red only because they re-run those
      two. `kit/run-gates.mjs` runs all thirteen gates one line each
      (`--static` for the Electron-free set, which CI now runs on ubuntu), and
      `kit/README.md` states the policy: no file-hash pins, ever; frozen means
      review. The packaging gate fails W0 on any dirty tree by design, so run
      the sweep after committing.
- [ ] **6.1 Engine and compositor fixes, no setting.** Drop
      `preserveDrawingBuffer: true` and `stencil: true` from the engine
      options in `src/renderer/app.js` (nothing reads the canvas back; shots
      use `capturePage`). Reuse a scratch vector in the planet view's per-ship
      `lookAt`. Hide non-top-3 system labels with `isVisible` instead of
      alpha 0. Cache sampled stars per galaxy next to the cached atlas pixels.
      ~1 h. Gate: shots unchanged.
- [ ] **6.2 Quality settings.** The three tiers in `RENDER_QUALITIES` carry
      glow-layer texture ratio, panel backdrop blur and sphere segments as
      well as render scale, raymarch steps and star share; glow layers are
      rebuilt on a tier change with the blur kernel scaled to keep the same
      screen radius; panel blur is a class on `<body>`; `setQuality` in the
      system and planet views rebuilds the scene. A "Recommend for this
      machine" button in Settings reads the renderer string, cores and screen
      and moves the slider, instead of a silent first-run pick, so test runs
      stay at High. ~2–3 h. Gate: polish P2 backdrop luma unchanged at High.

| Knob | Low | Balanced | High |
|---|---|---|---|
| Render scale | 0.6 | 0.8 | 1.0 |
| Galaxy raymarch steps | 20 | 32 | 48 |
| Star share | 0.4 | 0.7 | 1.0 |
| Glow layer texture ratio | 0.25 | 0.5 | 0.5 |
| Panel backdrop blur | off | off | on |
| Sphere segments | 32 | 48 | 64 |

### Release tail

- [ ] **6.3 Merge PR #49** (universe cluster, carries #50) then **PR #51**
      (README screenshots), on the owner's word.
- [ ] **4.8** flip public and the four post-flip settings (above).
- [ ] **5.4** mapped drives stays optional and may follow public.

## Totals

| Phase | Agent time | Blocks snapshot |
|---|---|---|
| 1 Bug fixes | 2–3 h | yes |
| 2 Docs honesty | 30 min | yes |
| 3 Leak cleanup | 30 min | yes |
| 4 Fresh repo | ~1 h | is the snapshot |
| 5 Structural | 8–10 h | no |
| 6 Visual quality | 6–8 h | three PRs before the flip; the rest is parked (added 2026-10-18) |

Critical path to a public repo: **about 4–5 hours of agent time across three
PRs and one manual GitHub session.**

2026-10-18: Phase 6 precedes the flip, rescoped to gate repair, engine fixes and quality
settings (6–8 h, three PRs). The planet pipeline and the other visual work are parked in
`kit/todo/15-visual-quality.md`.

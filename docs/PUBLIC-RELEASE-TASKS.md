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

- [ ] **4.1 Merge Phases 1–3** into this repo so the archive matches the
      snapshot exactly.
- [ ] **4.2 Decide Dependabot PRs #27 (Babylon group) and #30 (Electron
      43→44 major).** `package.json` is kit-frozen; either merge both now and
      re-run `node kit/grade.mjs` + all `kit/done/*/grade-*.mjs`, or close
      them and let Dependabot re-open on the new repo. Recommendation: merge
      the Babylon group, hold Electron 44 until after the snapshot.
- [ ] **4.3 Delete stale branches**: local `chore/public-readiness` and 23
      merged local branches; remote `feat/cross-platform-and-security-hardening`
      and `feat/point-of-view-improvements` (three gmail-authored commits).
- [ ] **4.4 Archive this repo.** Move the local `.git` to a sibling folder
      (keeps all local branch history). On GitHub: rename to
      `agent-universe-lite-archive`, then mark archived (read-only).
- [ ] **4.5 Create the fresh repo.** Confirm `git config user.email` is the
      noreply address. `git init`, add exactly the tracked file set, one
      commit, push to a new **private** `agent-universe-lite`.
- [ ] **4.6 Verify in a clean clone**: `npm ci` (see
      `launch-shortcut-fragility` memory: needs `install-electron`),
      `npm test`, `node kit/grade.mjs`, every `kit/done/*/grade-*.mjs`.
- [ ] **4.7 Re-apply GitHub settings** after the first CI run on the new
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
      `provider-adapters.js` and delete the copies. ~2 h.
- [-] **5.3 Replace scene-dispose polling.** `src/renderer/app.js:640`
      polls every 50 ms for up to 4 s holding two scenes live. Use the BRDF
      texture's `onLoadObservable.addOnce` (or `scene.executeWhenReady`) with
      a single fallback timeout. ~1 h. Withdrawn 2026-09-28: Babylon exposes no decode-complete signal; poll kept and documented (kit 13).
- [ ] **5.4 Mapped network drives on Windows** (unverified).
      `src/main/main.js:491` re-checks `isLocalProjectPath` after
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

## Totals

| Phase | Agent time | Blocks snapshot |
|---|---|---|
| 1 Bug fixes | 2–3 h | yes |
| 2 Docs honesty | 30 min | yes |
| 3 Leak cleanup | 30 min | yes |
| 4 Fresh repo | ~1 h | is the snapshot |
| 5 Structural | 8–10 h | no |

Critical path to a public repo: **about 4–5 hours of agent time across three
PRs and one manual GitHub session.**

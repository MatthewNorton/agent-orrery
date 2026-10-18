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

## Phase 6 — Visual quality: the last leg before public · ~10–12 agent days · one PR per item

Added 2026-10-18. The owner chose to land this phase before flipping the repo
public. It comes from two investigations run that day on the owner's machine
(AMD Radeon 890M integrated GPU, 4K display at 125%, Babylon 9.30, Electron 44):

- **Performance.** Driven over the DevTools protocol on the synthetic profile
  padded to 40 projects, every view holds a vsync-locked 60 fps at every
  quality tier, even with an emulated 3840×2160 viewport. GPU frame time peaks
  at 6.4 ms (universe, 4K, High). Low vs High barely moves the GPU at window
  size, so the tier knobs are not the lever. What costs is per-object work
  (684 draw calls, 466 meshes, 396 materials at 40 projects) and idle power:
  sitting still on the universe view the app burns ~62% of one core and ~19%
  of the GPU at 557 MB.
- **Realism.** Planets are 33 authored tileable PNGs (`assets/planets`, frozen)
  tiled 2× over each sphere by `AUR.applyPlanetSurface`, which reads as a
  repeating cell pattern in close-up. The sun clips to white under the glow
  layer. There is no terminator drama, cloud layer or limb haze. The reference
  is the owner's sandbox-animations-v2 PR #31 (`experiments/sidereal-v2`):
  CPU-generated 2048×1024 equirectangular maps (albedo+height, emission+water
  mask, clouds) from seeded 3D noise sampled on the unit sphere, generated in
  a worker, cached, lit by a hand-written shader.

Standing rules for every item: one PR per item, `/simplify` pass before it is
reported ready, `node kit/grade.mjs` and every done-kit gate green,
`npm test` and `npm run typecheck` green, files ≤ 300 lines (400 with a
written reason), no new dependencies, frozen files untouched.

### Decisions the owner confirms before 6.6 starts

- [ ] **D1 Authored PNGs stop being the default planet surface.** Assets stay
      frozen on disk; nothing is deleted. SPEC §6/§7/§10, DESIGN-DIRECTION
      lines 78–79 and `test/planet-assets.test.js` change with 6.7.
      Recommended: yes.
- [ ] **D2 Look.** Keep the five world classes (rocky, gas, ice, volcanic,
      oceanic) keyed by today's seeds so existing planets keep their identity,
      with the oceanic class carrying clouds, ocean glint and night-side
      lights so the mockup's habitable look appears where it is drawn.
      Alternative: every project planet Earth-like. Recommended: keep classes.
- [ ] **D3 First-open latency.** A placeholder surface appears at once and the
      detail map lands within about a second on High (longer on Ultra).
      Recommended: accept; generation is split across workers if it drags.

### Quality tiers after this phase

The Graphics slider in Settings keeps one stop per tier and gains Ultra. Each
tier is a frozen object in `src/renderer/app-state.js`; views apply it through
`setQuality`. The first run picks a default from the renderer string, logical
cores and screen size (Balanced for an integrated GPU at 4K, High for a
discrete GPU, Low for a software renderer) and stores it under the existing key
so the slider shows it.

| Knob | Low | Balanced | High | Ultra |
|---|---|---|---|---|
| Render scale | 0.6 | 0.8 | 1.0 | 1.0 |
| Galaxy raymarch steps | 20 | 32 | 48 | 64 |
| Star share | 0.4 | 0.7 | 1.0 | 1.0 |
| Glow layer texture ratio | 0.25 | 0.5 | 0.5 | 1.0 |
| Panel backdrop blur | off | off | on | on |
| Planet-view map | 1024×512 | 2048×1024 | 2048×1024 | 4096×2048 (active planet only) |
| System planet map | 256×128 | 512×256 | 512×256 | 1024×512 |
| Cloud layer | off | on | on + shadows | on + shadows |
| Sphere segments | 32 | 48 | 64 | 96 |
| Sun granulation map | 256×128 | 512×256 | 512×256 | 1024×512 |

One toggle sits outside the tiers: **Reduce frame rate when idle**, default
on, because it is a preference about power, not looks.

### Items

- [ ] **6.1 Engine and compositor fixes, no setting.** Drop
      `preserveDrawingBuffer: true` and `stencil: true` from the engine
      options in `src/renderer/app.js` (nothing reads the canvas back; shots
      use `capturePage`). Reuse a scratch vector in the planet view's per-ship
      `lookAt` (`scene-planet.js`). Hide non-top-3 system labels with
      `isVisible` instead of alpha 0 (`scene-system.js`). Cache sampled stars
      per galaxy next to the cached atlas pixels (`scene-universe-stars.js`,
      key `key:arms:size:count`). ~2 h. Gate: shots unchanged.
- [ ] **6.2 Tiers carry the knobs; Ultra; auto default.** Add the table's
      fields to `RENDER_QUALITIES`; glow layer `mainTextureRatio` per tier with
      the blur kernel scaled to keep the same screen radius; panel blur as a
      class on `<body>`; `setQuality` in the system and planet views; the
      first-run pick; a fourth slider stop. ~4 h. Gate: grade at High (test
      partition) and polish P2 backdrop luma unchanged.
- [ ] **6.3 Idle frame cap toggle.** Full rate during pointer or wheel input,
      a 1 s grace and camera coasting; ~30 fps idle; ~15 fps unfocused. Each
      view keeps its own delta time from `performance.now()`, because
      `engine.getDeltaTime()` keeps ticking on skipped frames and would slow
      every orbit. Off in test mode. Stored under
      `agent-universe.idle-frame-cap.v1`. ~2–3 h.
- [ ] **6.4 Universe glyph consolidation** (scaling headroom; may follow
      public). Share the five dot materials (search dimming moves from
      `material.alpha` to `visibility`), merge each glyph's rings into one
      line system, dots as thin instances; clip the galaxy raymarch to the
      lit r ≤ 24 cylinder and cull front faces instead of discarding them.
      Expected ~40% fewer universe draws, identical image. ~half a day. Gate:
      galaxy-grouping gate and an A/B of `shot-galaxy-close`.
- [ ] **6.5 Sun.** Generated granulation `emissiveTexture` (3D cells, sized by
      tier, slow U drift), limb darkening via `emissiveFresnelParameters`, a
      soft billboard corona on its own material, glow lowered so the core no
      longer clips white. Keep the literal
      `sunMat.emissiveColor = sunCol.clone()` for grade-polish P3. ~1 day.
- [ ] **6.6 World generator and tests.** New `src/renderer/worlds/` folder
      (added to the renderer tsconfig), UMD files with `// @ts-check`:
      `world-noise.js` (seeded 3D Perlin, fbm, domain warp, Worley F2−F1,
      vortex, banded craters; its mulberry32 copy added to
      `test/shared-hash.test.js`), `world-classes.js` (one sampler per class
      per D2, airless variant from `atmosphereProfile`), `world-maps.js`
      (`generateWorldMaps(profile, {width, height, layers})` → surface
      albedo+height, material emission+specular/water, optional clouds; input
      validation). `test/world-maps.test.js`: determinism, distinct classes,
      seam and pole continuity, buffer sizes, bad-input rejection, emission
      rules, small-size checksum. No visual change. ~1–1.5 days.
- [ ] **6.7 Worker, cache and the planet view.** `world-worker.js` as a
      classic worker (`importScripts`; CSP already allows `worker-src 'self'
      blob:`), `world-textures.js` published as `AUR.worldTextures`: one job
      at a time with priorities, a view epoch that drops stale jobs, a
      disposed-scene guard, a per-job timeout, synchronous low-res fallback.
      CPU-buffer LRU with a byte budget on `AUR.app.state.worldMaps`, passed
      through `makeCtx` like `galaxyFields`. `RawTexture` upload per scene
      (wrapU WRAP, wrapV CLAMP). The planet view draws a 128×64 placeholder
      synchronously, then holds `scene.addPendingData` until the detail map
      lands or 6 s pass, inside the polish gate's 10 s wait. Normal map from
      height with the 1/sin(lat) correction, specular map, cloud sphere at
      ×1.006, moons on the airless class. `scene.metadata.surfaceStats`.
      SPEC §7/§10 and `test/planet-assets.test.js` updated per D1. ~2–3 days.
      Gate: every gate, no M4 console noise, a latitude/longitude marker map
      shows no seam at u = 0 and no pole pinch, return visits are cache hits.
- [ ] **6.8 System planets and distance LOD.** 64×32 placeholder, tier map
      sizes, top three planets first, hover prefetches the planet-view map,
      cached planet-view maps reused, segments from the tier, gas drift via
      `uOffset`. ~1–1.5 days. Gate: a system-to-planet round trip regenerates
      nothing.
- [ ] **6.9 Lighting shaders.** `worlds/world-shaders.js` and a new
      `scene-planet-surface.js` part (`AUR.sceneParts.planet` added in
      `scene-common.js`): relief from height taps, terminator, night-side
      emission, ocean glint from the water mask, cloud shadows, limb haze from
      `atmosphereProfile`. Sun direction from the key light in the planet view
      and from each planet's position in the system view. Verify GlowLayer
      with ShaderMaterial meshes and tonemap consistency with ships and GUI.
      ~2 days. Gate: polish P2 unchanged; visual check against
      `1.planet-view.png`.
- [ ] **6.10 Docs and media.** README screenshots re-shot with
      `node scripts/demo-shots.mjs`; SPEC, RUBRIC, DESIGN-DIRECTION and the
      kit status board updated; any art want (cloud atlas) logged in
      `kit/ASSET-REQUESTS.md`. ~1 h.

### Release tail

- [ ] **6.11 Merge PR #49** (universe cluster, carries #50) then **PR #51**
      (README screenshots), on the owner's word.
- [ ] **4.8** flip public and the four post-flip settings (above).
- [ ] **5.4** mapped drives stays optional and may follow public.

Order: 6.1 → 6.2 → 6.3 → 6.5 → 6.6 → 6.7 → 6.8 → 6.9 → 6.10, with 6.4
whenever a gap opens. Items 6.1–6.3 and 6.5–6.10 block the flip; 6.4 does not.

## Totals

| Phase | Agent time | Blocks snapshot |
|---|---|---|
| 1 Bug fixes | 2–3 h | yes |
| 2 Docs honesty | 30 min | yes |
| 3 Leak cleanup | 30 min | yes |
| 4 Fresh repo | ~1 h | is the snapshot |
| 5 Structural | 8–10 h | no |
| 6 Visual quality | 10–12 days | last leg before the flip (added 2026-10-18) |

Critical path to a public repo: **about 4–5 hours of agent time across three
PRs and one manual GitHub session.**

2026-10-18: the owner chose to land Phase 6 first. The critical path is now items
6.1–6.3 and 6.5–6.10, then 6.11 and 4.8.

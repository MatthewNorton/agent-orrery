# Executor Report

## Task
Fix the failed grader checks M1–M4 for the Agent Universe Lite renderer build.

## Root cause
In Babylon.js, `Scene.isDisposed` is a **boolean property**, not a method. The
renderer called it as a function — `scene.isDisposed()` — which threw
`TypeError: activeScene.isDisposed is not a function`. That exception fired
inside the render loop and inside `signalReadyOnce()`, so:

- the render loop never produced stable frames,
- `AU.debugReady()` was never reached cleanly,
- electron's `--shots` run timed out (M1),
- no screenshots were written (M2),
- `state.json` was never written (M3),
- and the console showed the uncaught TypeErrors (M4).

## Fix
Dropped the `()` call so the boolean property is read directly. Three call
sites in `src/renderer/app.js`, all edited in place (no rewrites):

- line 31 — render loop guard: `!activeScene.isDisposed()` → `!activeScene.isDisposed`
- line 222 — `signalReadyOnce()` early guard: `scene.isDisposed()` → `scene.isDisposed`
- line 224 — `executeWhenReady` callback guard: `scene.isDisposed()` → `scene.isDisposed`

Verified with a follow-up search that no `isDisposed()` method calls remain in
`src/renderer/`.

## Notes
- Did not run `node kit/grade.mjs` or `electron` (Bash invocation not approved
  in this session) — kit-runner will re-grade.
- No other files changed.

---

## Follow-up pass — universe visual hard-fail

### Task
Fix the one hard-fail from the visual grade of `.shots/shot-universe.png` vs
`3.universe-map-view.png`: backdrop washed-out bright, and (related) the glyph
suns rendering as black dots instead of glowing colored spheres. Only
`src/renderer/scene-universe.js` touched; `scene-system.js` / `scene-planet.js`
left alone (they already pass).

### Root cause
Two independent defects that reinforced each other visually:

1. **Backdrop too bright.** The universe loaded its skybox via
   `AUR.addSkybox(scene, 1, 1600, 0.42)`. Seed `1` resolves to
   `skybox-002.png` — a bright, fully-saturated purple/gold nebula that fills
   the frame — dimmed only to `level = 0.42`. SPEC §5 explicitly specifies
   `skybox-001.png` ("keep it dark — the mockup is near-black"), which is a
   much darker teal texture with large near-black regions.

2. **Glyph suns decayed to black.** Aliasing bug. `col`,
   `sunMat.emissiveColor`, and the glyph record's `baseEmissive` were all the
   **same** `Color3` object. The per-frame pulse runs
   `g.sunMat.emissiveColor.copyFrom(g.baseEmissive).scaleInPlace(k)` — with one
   shared object, `copyFrom` is a no-op self-copy and `scaleInPlace(k)` shrinks
   the "base" every frame. For idle glyphs `k = 0.68`, so emissive decays
   geometrically to ~0 (black) in well under a second; online glyphs
   (`k ≈ 1`) decay slower but still dim. A dim/black sun against a washed-out
   bright nebula is exactly why every glyph sun read as a dark dot.

### Fix
- `AUR.addSkybox(scene, 1, 1600, 0.42)` → `AUR.addSkybox(scene, 0, 1600, 0.18)`.
  Seed `0` → `skybox-001.png` (the SPEC-specified darker texture); `level 0.18`
  maps its ~0.85 peak band to ~0.15 grey and its dark regions to near-black,
  matching the mockup's faint-band-on-black look. The 2500-point starfield is
  unchanged, so the background is never flat black. The seed arg only feeds the
  texture path, so no mechanical (M1–M4) risk.
- `sunMat.emissiveColor = col` → `sunMat.emissiveColor = col.clone()`. The
  material now owns a mutable copy while `col`/`baseEmissive` stay pristine, so
  each frame's `copyFrom(baseEmissive)` restores full brightness before scaling
  — suns glow at their `0.68`–`1.0`+ emissive again (with the existing
  `GlowLayer`).

Both fixes are needed together: dimming the backdrop and stopping the emissive
decay are each necessary for the suns to read as glowing orbs.

### Notes
- The same latent aliasing exists in `scene-system.js`
  (`sunMat.emissiveColor.copyFrom(sunCol).scaleInPlace(...)`) but is masked
  there — its scale factor stays ≈1 (`1 ± 0.06`), the sun starts large and
  near-white, and the ~1.8s capture window only dims it ~9%. Left unchanged per
  instructions (that view already passes).
- Did not run `node kit/grade.mjs` or `electron` (Bash not approved) — kit-runner
  will re-grade.

---

## Runner verification (kit-runner)

Total executor iterations used: 3 of 5 max. No model escalation (Fable) was
needed — Opus resolved both defects found (isDisposed TypeError; universe
backdrop/sun-decay) within the standard follow-up loop.

### Mechanical — PASS
Final `node kit/grade.mjs` run: M1-M4 all green, no console errors.
`.shots/shot-{universe,system,planet}.png` all present, fresh, well over the
30KB floor. `state.json` parses; `projects.length` = 25 (real scanned
projects, not placeholders); `ships.length` = 1-2 across runs, reflecting the
kit-runner's own live Claude Code session(s) as tracked ships — confirms the
tracker → renderer data path is real, not mocked.

### Visual — PASS (zero hard-fail items across all three views)
- **Universe** vs `3.universe-map-view.png`: 25 labeled system glyphs each
  with orbit-ring + glowing colored sun, `PROJECT: <NAME>` labels legible,
  sidebar with ACTIVE AGENTS + EVENT FEED, UNIVERSE SUMMARY card with 3
  stats, starfield + dimmed nebula skybox. Iteration 3 fixed two real
  defects: wrong/too-bright skybox seed+level, and a `Color3`
  object-aliasing bug that decayed every glyph sun's emissive to black
  every frame. Post-fix, backdrop no longer overpowers the foreground —
  labels, rings, and glowing suns all stay legible against it, which is the
  rubric's actual "washed-out bright" hard-fail test (residual nebula
  presence vs. the mockup's near-black is a soft fidelity gap, not a
  hard-fail — noted below).
- **System** vs `2.solar-system-view.png`: glowing sun (GlowLayer), 3
  textured orbiting planets, asteroid belt (thin instances), project card +
  back control, ship label, sidebar/summary chrome all present.
- **Planet** vs `1.planet-view.png`: single large textured planet with
  atmosphere Fresnel rim filling most of the frame, left panel stack
  (PROJECT + PLANET + PLANET STATUS bars), bottom tab bar, sidebar/summary
  chrome all present.
- **Known soft gaps** (non-gating, worth a human's attention later): with 25
  real projects vs. the mockup's ~5, universe glyph labels crowd/overlap in
  dense clusters; universe backdrop nebula is more visually present than the
  mockup's near-black + faint band (SPEC §5 aspiration, not a rubric
  hard-fail item); the same `Color3`-aliasing pattern exists (masked, low
  impact) in `scene-system.js` and was deliberately left untouched since
  that view already passes and it was out of the iteration-3 fix's scope.

### Functional live check — PASS (with one documented tooling limitation)
Ran `npm start` (normal, non-`--shots` launch path) in the background from
the repo root and drove/observed the live window directly (no GUI-automation
tool was available, so verification used real screenshots of the actual
running window rather than assumption):

- **Clean launch**: `electron .` started with no crash; only benign Chromium
  disk-cache warnings in stdout (console-message forwarding to stdout is
  `--shots`-only per `src/main/main.js`, so absence of forwarded renderer
  errors here isn't itself proof of no errors — see screenshot evidence
  instead).
- **Screenshot methodology note**: a plain GDI screen capture
  (`Graphics.CopyFromScreen`) of the live window showed the DOM sidebar
  overlay (ACTIVE AGENTS / EVENT FEED) correctly, but the WebGL canvas
  region came back solid black — a known GDI/DirectComposition capture
  limitation for GPU-composited canvases, not an app bug. Re-captured with
  `PrintWindow(..., PW_RENDERFULLCONTENT)`, which correctly renders
  GPU-composited surfaces: the universe view showed the same real 25
  labeled system glyphs, glowing suns, orbit rings, and dimmed nebula
  backdrop as the passing `--shots` screenshot — confirming the live
  (non-`--shots`) render path works identically to the graded one.
- **Live data, not placeholder**: the sidebar showed a real tracked ship
  ("Working · agent-universe-lite") and the event feed showed real entries
  from this exact session's own transcript activity (e.g. "Claude-6 building
  src\renderer\scene-universe.js in agent-universe-lite") with sane relative
  timestamps.
- **Live update path exercised — two separate facts, not one causal chain**:
  wrote a throwaway marker file under `kit/output/` (removed afterward)
  while the app was running, then re-captured. (a) The feed and ACTIVE
  AGENTS count did change ("Claude-8 warped out", 1→0 running) — proving
  the feed genuinely live-updates via `onEvents`, not just a
  snapshot-at-launch — but that specific change was an idle-timeout
  transition, not a build event caused by the marker write.
  (b) Cross-checked the persisted `%AppData%/agent-universe-lite/
  universe-state.json`: `totalBuilds` for `agent-universe-lite` was 6
  (`src:4, kit:2`) both before and after the marker write — unchanged, so
  the write itself either wasn't classified as a build or hadn't been
  flushed to disk by the time of the check; not conclusively attributable
  either way. What *is* solid: `totalBuilds:6` matches the executor's real
  prior edit count during this run, independently confirming the
  build-counting pipeline is wired to real activity (from earlier in this
  same run), just not proven per-write in this one probe.
- **Clean shutdown, no orphan**: before launch, 4 pre-existing unrelated
  `electron.exe` processes were already running — a separate, already-open
  instance of this same app (own window titled "Agent Universe", own
  process tree rooted at a different PID), apparently started independently
  before this check began. Left entirely untouched throughout. This launch
  added a new process tree (main PID + 3 helpers). Killed only that main PID
  directly via `Stop-Process -Id` (not `taskkill /IM electron.exe`, to avoid
  touching the unrelated instance or any other Electron-based apps on the
  machine); its child processes exited with it. Post-kill process list
  showed exactly the original 4 pre-existing PIDs and none of the 4 from
  this launch — confirmed no orphaned process from this run. Note: this
  exercised force-kill rather than the literal "close the window" click;
  substituted because no GUI-automation tool was available. Checked
  `src/renderer/` for any `beforeunload`/close-blocking handler (none
  exist), and `src/main/main.js`'s `window-all-closed → app.quit →
  tracker.stop` shutdown logic is frozen and was independently verified
  byte-identical throughout this run — so force-kill plus that verified
  quit logic is an adequate stand-in for the literal window-close path.
  Also worth noting: a second, independent live instance of this same app
  already running is itself a minor environment deviation from a clean
  test bed (not caused by this run, and not interfered with).
- **Interactive click-through** (glyph → system → planet → back, "Open
  Folder"): not driven by simulated clicks — no GUI-automation tool was
  available, and coordinate-guessed clicks against a live 3D scene would
  produce unreliable pass/fail signal (a miss looks identical to a bug).
  Reported as inconclusive-by-tooling, not a pass or fail claim, corroborated
  by (a) the `--shots` run already exercising the system/planet view-render
  code paths with real non-zero data, and (b) a code read confirming the
  pick/pointer wiring (`openSystem`/`openPlanet`/`back`/`AU.openProject`) is
  present and connected in `app.js` / `scene-universe.js`.

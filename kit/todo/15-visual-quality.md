# Stub — visual quality: procedural worlds, lighting, sun, idle cap, glyph consolidation, Ultra

Parked 2026-10-18 by the owner. The parts that precede the public flip (gate
repair, engine fixes, quality settings) live in `docs/PUBLIC-RELEASE-TASKS.md`
Phase 6; everything below waits for the owner's word.

Goal: planets in the system and planet views rendered from procedurally
generated equirectangular maps instead of the 33 authored tileable PNGs tiled
2× over each sphere (`AUR.applyPlanetSurface` in
`src/renderer/procedural-worlds.js`), lit by a hand-written shader; a sun that
does not clip to white; an idle frame cap; fewer objects per universe glyph;
an Ultra tier for discrete GPUs.

## Measurements (2026-10-18, owner's machine: Radeon 890M iGPU, 4K at 125%)

Synthetic profile padded to 40 projects, driven over the DevTools protocol.
Every view holds a vsync-locked 60 fps at every tier, even with an emulated
3840×2160 viewport, so the cost is per-object work and idle power, not pixels.

| View | GPU ms at 2082×1180 | GPU ms at 4K, High | Draw calls | Meshes / materials |
|---|---|---|---|---|
| Universe, 40 projects | 3.6 | 6.4 | 684 | 466 / 396 |
| System | 1.5 | 3.3 | 56 | 28 / 46 |
| Planet | 1.5 | 4.7 | 30 | 15 / 19 |

Idle on the universe view: ~62% of one core, ~19% of the GPU, 557 MB.
Low vs High barely moves the GPU at window size.

## Reference

The owner's sandbox-animations-v2 PR #31 (`experiments/sidereal-v2`:
`world-generator.mjs`, `world-textures.js`, `shaders.js`, `alien-worlds.mjs`).
CPU-generated 2048×1024 RGBA8 maps (albedo+height, emission+water mask,
clouds) from seeded 3D Perlin fbm with domain warp, Worley cells and banded
craters, sampled on the unit sphere so there is no seam or pole pinch; a
worker generates, an LRU keeps four worlds on the GPU; a ShaderMaterial does
the terminator, ocean glint, night-side lights, cloud shadows and limb haze.
It is Babylon too, so the work is a port to classic scripts, not a design.

Feasibility verified: the CSP already allows `worker-src 'self' blob:`; a
classic Worker from file:// works in Electron 44 with the app's exact
webPreferences; ShaderMaterial and RawTexture are in the core bundle; no
package.json change.

## Lean plan (port, don't invent) — about 12–15 session hours in three PRs

Calibration: PR #49 (spiral galaxies, ~1000 lines, 24 files) went from first
commit to the finished raymarch in ~13 hours of wall clock on 2026-10-15;
PR #50 (quality slider and panning, 260 lines) took an afternoon.

1. **Sun + idle cap** (~4 h). Generated granulation `emissiveTexture` (3D
   cells, sized by tier, slow U drift), limb darkening via
   `emissiveFresnelParameters`, a soft billboard corona on its own material,
   glow lowered so the core stops clipping; keep the literal
   `sunMat.emissiveColor = sunCol.clone()` for grade-polish P3. The
   "Reduce frame rate when idle" toggle: full rate during input, a 1 s grace
   and camera coasting; ~30 fps idle; ~15 fps unfocused; each view keeps its
   own delta time from `performance.now()` because `engine.getDeltaTime()`
   keeps ticking on skipped frames; off in test mode.
2. **Procedural worlds** (~5–7 h). `src/renderer/worlds/` (UMD, `// @ts-check`;
   the renderer tsconfig and grade-structure already walk folders; per the
   AGENTS.md folder rule the files drop the `world-` prefix):
   `noise.js`, `classes.js` (rocky, gas, ice, volcanic, oceanic
   keyed by today's `AUR.worldProfile` seeds), `maps.js`,
   `worker.js` (classic worker, `importScripts`), `textures.js`
   as `AUR.worldTextures` (one job at a time with priorities, a view epoch,
   a disposed-scene guard, a timeout, synchronous low-res fallback; CPU
   LRU with a byte budget on `AUR.app.state.worldMaps` through `makeCtx`
   like `galaxyFields`; `RawTexture` upload per scene, wrapU WRAP, wrapV
   CLAMP). Planet view: 128×64 placeholder at once, `scene.addPendingData`
   until the detail map lands or 6 s pass; normal map from height with the
   1/sin(lat) correction; specular map; cloud sphere at ×1.006. System view:
   64×32 placeholder, tier map sizes, top three planets first, hover
   prefetch, cached planet-view maps reused. Node tests: determinism, seam
   and pole continuity, sizes, bad-input rejection, emission rules.
   SPEC §6/§7/§10, DESIGN-DIRECTION lines 78–79 and
   `test/planet-assets.test.js` change here (decision D1).
3. **Lighting shaders + docs** (~4 h). `worlds/shaders.js` and a
   `scene/planet/surface.js` part (add `planet` to `AUR.sceneParts` in
   `scene/common.js`): relief, terminator, night emission, ocean glint,
   cloud shadows, limb haze from `atmosphereProfile`; verify GlowLayer with
   ShaderMaterial meshes and tonemap consistency. README screenshots re-shot
   with `node scripts/demo-shots.mjs`; SPEC, RUBRIC, DESIGN-DIRECTION and the
   kit board updated.

Deferred further: universe glyph consolidation (shared dot materials, rings
as one line system, dots as thin instances, raymarch clipped to the r ≤ 24
cylinder, front faces culled instead of discarded; ~3 h, identical image,
~40% fewer universe draws) and the Ultra tier (steps 64, glow ratio 1.0,
4096×2048 active-planet map, 1024×512 system maps, 96 segments; ~130 MB VRAM
per 4096 world with mips, generation 4× slower).

## Decisions the owner confirms before PR 2

- **D1** The authored PNGs stop being the default planet surface (assets stay
  frozen on disk). Recommended: yes.
- **D2** Keep the five world classes keyed by today's seeds, oceanic carrying
  clouds, glint and night lights; or every project planet Earth-like.
  Recommended: keep classes.
- **D3** Accept a placeholder-then-detail swap of about a second on first open
  at High. Recommended: yes.

## Gates that constrain the port

`kit/grade.mjs` M2 (each shot ≥ 30 KB) and M4 (any output line matching
`Uncaught|ReferenceError|TypeError|SyntaxError|is not defined|Failed to load
resource` fails, so worker failures log a fixed message through `AUR.log`);
the shots harness waits for `au:debug-ready`, which fires after
`scene.executeWhenReady`, so pending data holds the shot; the polish gate's
`waitForView` allows 10 s and needs planets pickable at once; test runs use
an in-memory partition and therefore always render High.

Status: not distilled. Run /distill on this file when the owner un-parks it;
PR 1 can start without D1–D3.

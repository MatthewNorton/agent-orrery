# Contract — procedural worlds and a photosphere sun (kit 15)

Replace the authored planet PNGs (1024² tileable albedos tiled 2× over each sphere by
`AUR.applyPlanetSurface`) with generated equirectangular maps lit by ported shaders, and give
the system sun a live photosphere that keeps its colour instead of clipping to white. This is a
**port of an approved preview, not a design task**: the look, the generator and the shaders exist
in `reference/`. Where this contract and the preview disagree, the contract wins; where the
contract is silent, match the preview.

## Approval and decisions (owner, 2026-11-01)

The owner reviewed the published preview (private claude.ai artifact
https://claude.ai/artifact/VgGLyQcnXEHDbMiiWybsfH; the same page is `reference/procedural-worlds.html`)
and wrote: "To proceed it looks pretty good". The preview demonstrated each decision parked in
the old stub, so they are recorded as approved. A one-word veto from the owner reopens only that
decision; anything else needing the owner goes to `kit/BLOCKED.md`.

- **D1** Generated maps replace the PNGs as the planet surface everywhere. `assets/planets/*` and
  `assets/manifest.json` stay on disk, frozen, unused by planets. Asteroids keep their PNGs.
- **D2** Five world classes, today's seeds: `AUR.worldProfile(projectId, name)` keeps returning
  the same `key`, `seed`, `hueShift` and `colors` (the grader pins ten planets) and stays defined
  in `src/renderer/procedural-worlds.js`. Oceanic carries clouds, glint and night lights.
- **D3** First open shows a placeholder at once and swaps in the detail map when it lands
  (preview: 1.1–4.7 s for 2048×1024 with 4 workers, oceanic slowest).
- **D4** Gas giants with `((seed >>> 7) & 1) === 1` get rings (about half), and planet-view moons
  get rocky generated maps, as in the preview.

## Committed architecture (do not re-decide)

1. **Port, change one thing.** The generator is `reference/world-generator.cjs` split into files.
   Every class except ice must match it within the W2.2 tolerance. Ice is the one change: lineae
   instead of noise iso-lines (W2.4). *Why:* the preview is the approved look, and drift is the
   main risk of a port.
2. **Classic worker from a file, main-thread fallback.** `new Worker('worlds/worker.js')` (resolved
   against `index.html`), `importScripts` for the generator files, buffers transferred. When
   construction throws, a worker fires `error`, or a job runs past 15 s, that worker is retired
   and its jobs run on the main thread at no more than 1024×512 (the preview's `createPool`).
   *Why:* the CSP already has `worker-src 'self' blob:`. The kill-switch proved a file worker under
   the app's CSP and webPreferences (2048 oceanic in 2.2 s on Electron 44.7).
3. **Planets: `ShaderMaterial` with in-shader ACES.** Port `TONE` (`displayColor`, exposure 1.0),
   `NOISE`, `WORLD_VERTEX`, `SURFACE_FRAGMENT`, `CLOUD_FRAGMENT`, `ATMO_FRAGMENT` and
   `RING_FRAGMENT`. The scene's image-processing configuration stays exactly as today. *Why:*
   scene-level tone mapping would restyle ships, glyphs and every gold sample, and a PBR plugin
   would re-derive a look that is already approved.
4. **Sun: keep `sunMat`, add a material plugin.** The system sun stays the `StandardMaterial`
   `sunMat`. A `BABYLON.MaterialPluginBase` subclass injects the preview's `SUN_FRAGMENT`
   photosphere into it: granulation, sunspot belts, faculae, limb darkening 0.47/0.23, limb
   reddening, and an ACES soft clip, multiplied by `emissiveColor`. The sun leaves the glow pass
   (`glow.addExcludedMesh(sun)`), and its halo becomes the preview's corona and glow billboards
   (`CORONA_FRAGMENT` 0.45, `GLOW_FRAGMENT` 0.24), also excluded from the glow pass.
   *Why:* polish P3, `polishStats()` and `POLISH.applySunPulse` all act on `sunMat.emissiveColor`.
   The white core comes from glow stacked on emissive.
5. **Caches.** CPU: generated buffers live in an LRU on `AUR.app.state.worldMaps` (handed to views
   by `makeCtx`, like `galaxyFields`), keyed `cls:seed:width:rings`, budget 160 MB. GPU:
   `RawTexture`s are made per scene from those buffers and die with the scene. *Why:* every view
   switch disposes its scene; buffers survive and uploads are cheap.
6. **Sizes by tier** (`ctx.quality.key`), placeholders made synchronously on the main thread:

   | tier | system map | planet detail | cloud shell | placeholder (system / planet) |
   |---|---|---|---|---|
   | low | 256×128 | 1024×512 | no | 64×32 / 128×64 |
   | balanced | 512×256 | 2048×1024 | no | 64×32 / 128×64 |
   | high | 512×256 | 2048×1024 | yes | 64×32 / 128×64 |

## Reference (read before writing code)

- `reference/procedural-worlds.html` is the approved page. Port these parts of it:
  - `worldGenerator()`, the generator
  - `createPool`, `ensureMaps`, `bestMaps` and `placeholder`, the map pipeline
  - the GLSL constants named above
  - `createWorld`: the globe, a cloud shell at ×1.006, the atmosphere shell, rings, and their uniforms
  - `CLASS_LOOK`, `ATMOSPHERES` and `planetSpec`: per-class relief, glowDay, flattening, haze and shell
  - `buildPlanetView` and `placeSun`, the planet view

  Skip the page chrome, the nebula sky, the star points, the camera framings and the CDN script tag.
- `reference/world-generator.cjs` is the generator alone. It is UMD, frozen, and serves as the W2 parity oracle.
- `reference/shots/` holds the approved look, rendered at 1600×900 in Electron: `system.png`,
  `sun.png`, `rocky.png`, `gas-rings.png`, `volcanic-night.png`, `oceanic.png`, plus
  `ice-before.png`, which shows the contour-loop cracks that W2.4 replaces.
- Provenance: everything ports the owner's MIT `sandbox-animations-v2` PR #31
  (`experiments/sidereal-v2`). Copy nothing from CosmosJourneyer (AGPL).

## Editable scope

- `src/renderer/worlds/**` (new)
- `src/renderer/procedural-worlds.js`: remove the PNG and planet-map path, keep `worldProfile` and the asteroid helpers
- `src/renderer/util.js`: remove `planetTexPath` and `planetBumpPath` only; `planetTextureIndex` keys the class (D2)
- `src/renderer/scene/system/**`, `src/renderer/scene/planet/**`, and `src/renderer/scene/common.js`
  (only to add `planet` to `AUR.sceneParts` if you split the planet view into parts)
- `src/renderer/index.html`: script tags only; the CSP meta stays byte-identical
- `src/renderer/app/state.js` and `src/renderer/app/boot.js`: `worldMaps` state and `makeCtx` only
- `src/main/harness/driver.js`, `src/main/harness/metrics.js` and `src/main/harness/modes/polish.js`:
  additive `worldMetrics` plumbing only (W6)
- `test/planet-assets.test.js` and new `test/worlds-*.test.js`
- `kit/SPEC.md`, `kit/RUBRIC.md`, `docs/DESIGN-DIRECTION.md`, `README.md` screenshots (via
  `node scripts/demo-shots.mjs`), `kit/README.md` and `kit/todo/README.md`

Everything else is frozen, in particular `package.json`, the lockfile, `assets/**`, the mockup PNGs,
`src/preload.js`, `src/main/window.js`, `src/main/window-security.js`, `kit/grade.mjs`, `kit/done/**`,
and this kit's `grade-worlds.mjs` and `reference/`. Add no dependency, network request or asset.

## W0 — pre-flight and kill-switch (first, before any app code)

1. `npm ci`. Today `node_modules` holds Electron 44.7 and Babylon 9.30, while `package.json` and
   the lockfile pin 45.0.0 and 9.32.0; the grader fails W0 until they match. `npm ci` installs
   exactly from the frozen lockfile and never rewrites it. Its `postinstall` (`install-electron`)
   fetches the Electron binary; if `node_modules/electron/dist` is still empty afterwards, run
   `npx install-electron`. Run nothing else first.
2. `node kit/todo/15-procedural-worlds/grade-worlds.mjs --killswitch`. It loads a page two levels
   below the repo root, with the app's CSP and webPreferences, and checks four things:
   - a classic worker builds and transfers the 2048×1024 oceanic map in ≤ 8 s
   - `RawTexture` uploads it
   - `BABYLON.MaterialPluginBase` exists
   - whether blob workers are allowed (recorded, not graded)

   If it fails on the new Electron, write `kit/BLOCKED.md` with its output and stop. Do not invent another transport.

## W1 — layout

`src/renderer/worlds/` holds at least `noise.js`, `classes.js`, `maps.js`, `worker.js`,
`textures.js`, `shaders.js`, `material.js` and `sun.js`.
- Each file starts with `// @ts-check`, runs to 400 lines at most (aim for 300), and is a classic
  script with no `import`/`export`. Follow the renderer pattern of one IIFE that publishes on
  `AUR`, with no module-level mutable state.
- `noise.js`, `classes.js` and `maps.js` are pure. They extend `self.AUR.worlds`, creating
  `self.AUR` when it is absent, as in the worker. They never touch Babylon, `window` or `document`,
  so the worker, the page and Node load the same three files.
- `index.html` loads every worlds file except `worker.js` after `util.js` and before `scene/system/` and `scene/planet/`.

## W2 — generator (`AUR.worlds.generate(job)`)

`job = { cls, seed, hue, palette, width, height, rings }`, the same shape the preview's `jobFor`
builds. The palette comes from `worldProfile(...).colors` and the hue from `.hueShift`.

It returns `{ width, height, surface, emission, clouds, rings }`, as in the reference:
- `surface`: RGBA, hue-shifted albedo with height in alpha
- `emission`: RGBA, night or lava light, with the water/specular mask in alpha
- `clouds`: RGBA for oceanic, else `null`
- `rings`: 1024×1 RGBA when `job.rings`, else `null`

Width must be an integer from 2 to 2048 and height from 2 to 1024. Anything else throws a `RangeError`.

1. **Determinism.** The same job gives byte-identical buffers.
2. **Parity.** Rocky, gas with rings, volcanic and oceanic at 256×128 match the reference: mean absolute
   byte difference ≤ 0.5, and ≥ 99.5 % of bytes within ±2. That leaves room for refactoring and
   reordered float maths, but not for a different look.
3. **Sphere sampling.** Every class at 512×256 must meet two limits. The seam ratio (column 0
   against the last column, relative to a typical neighbour step) must be ≤ 1.6; the reference
   scores 0.96–1.15. The pole ratio (neighbour steps on the pole rows relative to the equator) must
   be ≤ 0.08; the reference scores ≤ 0.007, while flat UV noise scores about 1.0. Bounds are
   enforced as described above.
4. **Ice lineae.** Replace the iso-line cracks of `fbm` with Europa-style lineae:
   - Use 5–8 seeded small circles, each an axis plus an angular radius. Warp them with
     low-frequency noise and use line widths of 0.004–0.012 rad.
   - Take a pixel's line strength as `1 − smoothstep(w0, w1, |angle(p, axis) − radius + 0.04·warp|)`,
     combined over the circles with `max`. Add a ridged double band (`1 − |fbm|`, sharpened) along
     the same arcs.
   - Tint the lineae reddish-brown, with `[0.56, 0.43, 0.34]` margins and a darker core. Keep the
     preview's plates, dust and polar frost.

   The cracks must read as long arcs crossing much of the globe, never as closed loops
   (`reference/shots/ice-before.png` shows the failure). The grader only checks that ice changed;
   spot check S3 judges the look.
5. **Class rules** at 512×256:
   - Rocky, gas and ice have no emission.
   - Volcanic emission covers 2–35 % of pixels (reference 18.6 %).
   - Oceanic's water mask (emission alpha > 128) covers 35–85 % (reference 52 %), and its night
     lights cover 0.2–10 % (reference 2.2 %).
   - Clouds appear exactly for oceanic, and rings exactly for `job.rings`.
   - Rings have a gap (some texel alpha < 10) between 30 % and 70 % of their width.
6. **Budget** on one Node thread: 512×256 in ≤ 600 ms per class (reference 126–245 ms), and the
   2048×1024 oceanic map in ≤ 8 s (reference 2.5 s).

## W3 — map pipeline (`worlds/textures.js` as `AUR.worlds.textures`)

- **API:**
  - `request(spec, width, priority, epoch)` returns a Promise of buffers.
  - `best(spec)` synchronously returns the largest cached buffers, or else a placeholder.
  - `upload(scene, maps)` creates the textures: wrapU WRAP, wrapV CLAMP, trilinear, anisotropy
    ≤ 8, rings clamped both ways.
  - `stats()`.
- **Pool:** `max(1, min(3, hardwareConcurrency − 2))` classic workers, a priority queue and a 15 s
  timeout. A job for a disposed epoch is dropped before it runs. A result for a disposed scene is
  cached but never uploaded.
- **Fallback:** as in architecture point 2. Log through `AUR.log('[worlds] …')` with fixed messages
  that never contain the words `kit/grade.mjs` M4 rejects: `Uncaught`, `ReferenceError`,
  `TypeError`, `SyntaxError`, `is not defined`, `Failed to load resource`.
- **LRU:** as in architecture point 5. Evict oldest first and never evict a map that is in use.

## W4 — worlds in the system and planet views

- **System view.**
  - Each planet mesh keeps its name `pl_<name>`, `metadata = { planetName, isPlanet: true,
    worldType }` and its pickability, because the polish harness clicks it. Its material becomes
    the world `ShaderMaterial`, lit from the sun's world position.
  - Maps go placeholder, then system size. The biggest three planets go first, and the hovered
    planet's detail map is prefetched at low priority.
  - Ringed gas giants get their rings. There is no cloud shell in this view.
- **Planet view.**
  - The globe `planet` (PDIA 12, 64 segments) gets the world material with per-class flattening.
  - The cloud shell (×1.006) appears for oceanic on high only.
  - The atmosphere shell uses `AUR.atmosphereProfile` colour, scale and alpha, with haze as in `planetSpec`.
  - Rings for ringed gas giants. Moons get rocky 512 maps.
  - The shader's sun direction is `-key.direction`, so it agrees with the existing `key` light the ships use.
  - D3 sequence: show the best cached map; request 512 at high priority if nothing is cached; then
    request the detail map. Hold `scene.addPendingData(token)` until the detail map is bound or
    6 s pass, then call `removePendingData`. The shots and polish harnesses wait on that readiness.
- **Glow pass.** The globe stays in it, as an occluder of glow behind it. Cloud, atmosphere and ring meshes are excluded.
- **Remove:**
  - `applyPlanetSurface`, `proceduralPlanetData`, `planetTexPath` and `planetBumpPath`
  - every `assets/planets` reference under `src/renderer`

  The universe view's suns and glyphs are untouched.

## W5 — sun (`worlds/sun.js`)

Implement architecture point 4. The plugin takes two uniforms:
- `time`: seconds from the view's own clock
- `detail`: 0 on low (no fine granulation), else 1

Keep `polishStats()` fields and their meaning, and keep the literal `sunMat.emissiveColor = sunCol.clone()` (polish P3).

## W6 — observable proof

Both views expose `scene.metadata.worldStats()`, which returns:

```js
{ view: 'system' | 'planet', tier: 'low' | 'balanced' | 'high',
  pending,               // map jobs in flight for this scene
  workers,               // live workers (0 = main-thread fallback)
  pngPlanetTextures,     // scene textures whose url contains 'assets/planets/' (must be 0)
  planets: [{ name, cls, expectedCls, mapWidth, source }],  // system view; expectedCls = worldProfile(...).key
  sun: { plugin, excludedFromGlow, color: '#rrggbb', screen: { x, y } } | null,     // system view
  detail: { name, mapWidth, swapMs, heldReady, source } | null }                    // planet view
// source: 'worker' | 'main' | 'cache' | 'placeholder'
```

In `--polish-test`, add `worldMetrics` to `result.json`:
- After `waitForView('system')`, wait up to 8 s for `pending === 0` and store `worldMetrics.system`.
  Take the existing `system.png` capture, then store `worldMetrics.sunCore`: the mean RGB of the
  7×7 image-pixel patch at `sun.screen`, with CSS pixels scaled to the capture.
- After `waitForView('planet')`, wait up to 8 s for `pending === 0` with the detail map bound, store
  `worldMetrics.planet`, then take the existing `planet.png` capture.

Nothing else in the polish run changes.

The grader runs this against the synthetic profile and requires:
- zero planet PNGs
- at least one live worker
- system maps at tier size from a worker or the cache, with `cls === expectedCls`
- a detail map at tier size within 6 s, with readiness held
- sun plugin on and the sun out of the glow pass
- a sun core with its brightest channel ≤ 250 that keeps ≥ 25 % of the sun colour's tint in the
  same direction (cosine ≥ 0.8)
- no renderer errors

For calibration, today's app core reads [255, 255, 255] and the preview's reads [229, 220, 180].

## W7 — docs and tests (no grader check; the runner reviews them)

- `kit/SPEC.md`:
  - Rewrite the planet texture rule (around line 398, `planet-XXX.png` … `uScale=vScale=2`) for generated maps from `src/renderer/worlds/`.
  - Add `worlds/` to the shared-libraries row.
  - Note in the asset inventory that `assets/planets` no longer feeds planets.
- `kit/RUBRIC.md`: planet expectations follow the new look.
- `docs/DESIGN-DIRECTION.md` lines 78–79: realistic, generated surfaces.
- `test/planet-assets.test.js`: drop the `planetTexPath`/`planetBumpPath` test, and keep the asset
  and class-coverage tests.
- New `test/worlds-*.test.js`: determinism, bounds, seams, classes.
- Re-shoot the README screenshots with `node scripts/demo-shots.mjs`.

## Human spot checks (runner, after the gates pass)

- **S1** `.shots/worlds/system.png` reads like `reference/shots/system.png`: realistic small worlds,
  rings on ringed giants, a warm star with soft corona and no white core.
- **S2** `.shots/worlds/planet.png` against the matching reference class shot: relief and terminator,
  oceanic glint, clouds and city lights, volcanic lava that glows on the night side without neon, no seam.
- **S3** Ice (open a project with an ice planet, such as the synthetic `orion-api/docs`): long arcs, not loops.
- **S4** Sun close-up: granulation visible, limb darker and redder, halo soft.
- **S5** Live app (`npm start`):
  - open three systems and their planets, flip all three quality tiers, and switch views quickly ten times
  - no main-thread stall over 250 ms (DevTools performance panel)
  - no console errors

## Out of scope

- **Moved to `kit/todo/16-idle-cap-and-glyphs.md`:** idle frame cap, universe glyph consolidation and the Ultra tier.
- **Later, each an owner call:**
  - single-scattering atmosphere post-process
  - biome colouring by height, slope, temperature and moisture
  - live 4D-noise gas giants
  - blackbody sun colours (would change every project's sun)

## Gates

```powershell
node kit/todo/15-procedural-worlds/grade-worlds.mjs
node kit/grade.mjs
node kit/run-gates.mjs     # every done kit's gate (polish-pass, structure, …) and npm test, ~6 min
npm run typecheck
```

During a PR, `node kit/run-gates.mjs --static` is the quick loop; the full sweep runs before each PR is reported.

## Execution

- **Feeding.** Feed the kit with the prompt in `kit/EXECUTOR-HANDOFF.md`, using
  `<KIT_CONTRACT_PATH>` = `kit/todo/15-procedural-worlds/CONTRACT.md`.
- **Executor.** Claude Opus 5.5 at high effort throughout: kit-runner, the executor session
  (`claude --model claude-opus-5-5 --effort high …`) and every subagent, including review passes.
  Owner, 2026-11-01: "why not use opus 5.5?" and "set the subagents to opus high". Fallback: no model switch.
  - A stalled run gets a fresh Opus 5.5 session, given only the failing check IDs and the grader output.
  - If Opus 5.5 is unavailable, stop and write `kit/BLOCKED.md`.
- **PRs.** Three stacked PRs, each leaving every existing gate green. `grade-worlds.mjs` passes in
  full only after the third.
  1. W0–W2: generator, worker file and tests. No visual change.
  2. W3, W4 and W6: worlds in both views and the harness metrics.
  3. W5 and W7: the sun, docs and screenshots.

## Pre-answered objections

- **"PBR plus a plugin for planets, as CosmosJourneyer does?"** The approved look is a
  `ShaderMaterial` port. Re-deriving it in PBR risks drift for no visible gain. The sun uses a
  plugin only because its existing contracts need `sunMat`.
- **"The parity tolerance blocks improvements."** It is meant to. Changing a class's look is an
  owner decision. Write it in `kit/BLOCKED.md` rather than in the code.
- **"Workers might fail in the real app."** W0 proves the transport under the app's CSP, W6 proves
  at least one live worker inside the app, and the main-thread fallback was verified in the preview
  for both failure modes (constructor throws; worker errors after creation).
- **"Screenshot gates will capture placeholders."** `addPendingData` holds readiness for the shots
  harness, and the polish harness waits for `pending === 0`.
- **"Memory?"** The CPU budget is 160 MB. On the GPU, one oceanic 2048 set is about 24 MB, or about
  32 MB with mips, and only the open scene's maps are resident.

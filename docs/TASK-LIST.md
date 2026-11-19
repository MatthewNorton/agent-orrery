# Task list

Work a review found and its pull request could not finish: a fix that reaches across the codebase,
or one outside what the pull request set out to change. Everything else a review finds is fixed in
the pull request that raised it, so this list stays short.

Each entry says what is wrong, where (file and line when it was written), why the pull request that
found it left it, and how to check a fix. Take an entry as its own pull request, and delete the
entry in that pull request.

## Open

### A ship model is rebuilt from nothing in every scene

- **What.** A view builds its own copy of a ship model the first time a ship needs it: the
  geometry and its merge into one mesh, nineteen painted canvas textures (six of them 1024 pixels square) and a 128 pixel
  reflection cube, all on the renderer's main thread. For Petrel that is 80 to 100 ms per scene,
  measured in the app on an integrated GPU (the ship about 46 ms, the cube about 27, the merge
  about 7), so universe → system → planet pays it three times, and the universe map pays it for
  hulls a dozen pixels long. Hulls still arrive sooner than the GLB they replaced (about 200 ms
  after a system opens against about 340 ms), but for those five or six frames nothing else
  draws.
- **Where.** `container` in `src/renderer/ships/models.js:65`, called per scene by
  `ensureContainer` in `src/renderer/ship-assets.js:197`. The work is inside the generated
  modules: `createSurfaces` in `src/renderer/ships/petrel/source/surfaces.js:147` paints the
  canvases and `createInspectionProbe` in `src/renderer/ships/petrel/source/light-probe.js:38`
  fills the cube faces.
- **Why not in the pull request that added ship models.** The parts that do not depend on a scene
  (vertex data, painted canvases, probe faces) are made inside generated files, which are never
  edited here: the ship's source has to offer them separately from the GPU objects (for example
  `createSurfaces(scene, painted)` taking canvases it painted earlier) before the renderer can
  keep them for the app's lifetime. That is a change to the ship's source and a second import.
- **How to verify.** Time `AUR.shipModels.container(scene, model)` in the app (DevTools,
  `performance.now()` around the call): the second and later scenes build Petrel in a few
  milliseconds, the first is no slower than today, and `scene.textures` holds the same count as
  before. `test/ships-source.test.js` still matches the recorded geometry, and a WebGL context
  loss followed by a view switch still shows a lit ship.

### Ship models are copied, not instanced, in the system and planet views

- **What.** In the system and planet views every ship of a model is its own mesh with a sub-mesh
  per finish: Petrel is 24 draws per ship, and the glow pass draws them again. A system with
  fifty Petrels took about 14 ms a frame on an integrated GPU, which is why the hull budget stops
  there and later ships stay darts; before ship models the budget held seventy ships of the first
  rank. The universe map instances one template per provider and draws any number of ships in 24
  draws per provider. The budget itself counts triangles (`TRIANGLE_BUDGET`, 900k), though what
  it guards is CPU time per ship and per draw. The number fits the hulls that fly today: it admits
  fifty Petrels (24 draws each, measured), or 92 of the smallest later-rank hull file (9.7k
  triangles in 6 draws), which by the 0.13 ms a ship the old Scout file measured comes to about
  the same frame; that second case is an estimate, not a measurement. It has to be set again for
  each model that takes a rank.
- **Where.** `placeClones` in `src/renderer/ship-assets-hulls.js:244` copies the container's
  mesh for each ship; `placeInstances` (`:231`) is what the map uses, on `providerTemplate`
  (`:210`). The copy exists because focus mode fades the other ships by mesh visibility
  (`applyShipFocusVisual` in `src/renderer/scene/system/focus.js:45`), and an instance shares
  its source's visibility. The budget is `TRIANGLE_BUDGET` and `fitsBudget` in
  `src/renderer/ship-assets.js:49` and `:230`.
- **Why not in the pull request that added ship models.** Instancing in those views changes how
  focus mode fades and restores a ship (a second, faded template per provider that a ship's
  instance moves to, in place of a visibility set on its meshes), which reaches the system view's
  focus code, the planet view and `AUR.ships.refresh`, which waits while a ship is faded.
- **How to verify.** In a system with fifty ships of one provider the hulls take about 50 draws
  in total, not about 2,500 (`BABYLON.SceneInstrumentation`, `drawCallsCounter`). Following one
  ship still fades the others to 0.16 and hides the followed one from inside, leaving focus
  restores every ship, and a ship promoted while faded takes its new hull once focus ends. Once
  ships are instances a hull's cost is its triangles again, so then set `TRIANGLE_BUDGET` to what
  the same measurement supports with each rank's hull filling a system.

# Executor report — ship assets pack

Status: **PASS** on 2026-07-26.

## Delivered

- Curated ten CC0 Kenney Space Kit GLBs into `assets/ships/`: three complete small/medium/large provider families plus one shared drone hull, all referenced through schema-version-1 `manifest.json`.
- Measured each GLB with Babylon.js under a `NullEngine`; the manifest corrections recenter the imported source offset, rotate the rear-facing source hulls to +Z while preserving +Y up, and normalize hull length to approximately one world unit.
- Added `babylonjs-loaders` at the exact `9.17.0` pin; `package.json` changes by one added line, with the install recorded in `package-lock.json`.
- Added `ship-assets.js`, which loads the local manifest through fetch with an XHR fallback, selects hulls deterministically by normalized provider and role, caches one `AssetContainer` per hull per scene, caches at most one accent material per provider per hull, and instantiates corrected clones beneath stable ship roots.
- Added a safe asynchronous upgrade path: ships created before the manifest or container is ready retain their marked procedural root, then hide only the dart geometry and receive the real hull without disturbing labels, trails, attention suffixes, beams, animation, parentage, or provider evidence.
- Added a measured scene-local triangle budget that keeps instantiated hull geometry strictly below 100,000 triangles and uses the procedural fallback if the remaining budget is insufficient.
- Integrated the loader into universe, system, and planet ship builders and added scene-local container/material disposal before each Babylon scene is destroyed.

## Files changed

- `package.json`, `package-lock.json`.
- `src/renderer/index.html`, `src/renderer/ship-assets.js`, `src/renderer/scene-universe.js`, `src/renderer/scene-system.js`, `src/renderer/scene-planet.js`.
- `assets/ships/manifest.json` plus ten selected `.glb` hulls.
- `kit/README.md`, `kit/todo/README.md`, `kit/EXECUTOR-REPORT.md`, and the archived Kit 08 contract, grader, and report under `kit/done/ship-assets-pack/`.

The current `src/main/main.js` worktree change was supplied outside this executor to repair the pre-existing archived-polish baseline failure; the executor preserved it and made no main-process change. The human-sourced `assets/staging/ships-inbox/` and `kit/prompts/` content were read but not modified or packaged as executor output.

## Hull selection rationale

- Claude maps to the `kenney-industrial` family: Cargo A, Cargo B, and Miner provide increasingly substantial hauler silhouettes.
- Codex maps to the `kenney-interceptor` family: Speeder B, Speeder A, and Speeder C provide compact, swept, and broad-wing variants.
- Signal maps to the `kenney-scout` family: Racer, Signal Pod, and Speeder D provide compact courier, pod, and wide scout silhouettes.
- The Kenney double turret becomes the shared drone hull because its compact mechanical silhouette remains readable at drone scale.
- The selected files are 17–50 KB and total 3,590 triangles for one instance of every hull; the largest single hull is 876 triangles.
- Quaternius hulls were not selected because every supplied embedded `.gltf` is approximately 2.6–4.6 MB and therefore exceeds the contract's 2 MB per-file limit; shrinking or splitting them would violate the no-re-export/no-geometry-mutation rule.

## Frozen kit

- `CONTRACT.md`: `0b223cc8564c17f8c41765a96c7143f22c31f68986fc0c9f1eefb8979324958f`.
- `grade-ships.mjs`: `de741cd196f77a51babd8998b2ecd123a2cae4b1de94898c50906232080e9c8b`.

## Verification

- `node kit/done/ship-assets-pack/grade-ships.mjs` — PASS S0–S5 after archival, including the permanent `node kit/grade.mjs` Electron regression.
- `node kit/done/multi-provider/grade-providers.mjs` — PASS V1–V5 with Claude, Codex, and Signal represented once each, three distinct provider colors, and zero tint mismatches.
- `node kit/done/polish-pass/grade-polish.mjs` — PASS P1–P4 with rendered label, backdrop, and real pointer-input checks.
- `node --check` on `ship-assets.js` and all three edited scene files — PASS.
- `git diff --check` — PASS; `git diff --numstat -- package.json` confirms exactly one added line and no removed lines.
- Fresh `.shots/shot-system.png` and the provider-gate universe capture show multi-part colored hull silhouettes rather than procedural darts; labels, trails, and the attention presentation remain intact.

## Known gaps

The Quaternius source pack remains available only in the human staging inbox because none of its supplied files meet the size cap without forbidden conversion. Runtime manifest, hull, loader, or triangle-budget unavailability intentionally falls back to the existing procedural dart with one diagnostic log; no missing selected asset required an entry in `kit/ASSET-REQUESTS.md`.

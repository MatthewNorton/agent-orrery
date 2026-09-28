# Kit 08 — Realistic agent ships from CC0 3D packs (contract)

Replace the procedural dart ships with real low-poly 3D hulls from
public-domain packs, assigned per provider (Claude / Codex / Signal), with a
manifest indirection so a later kit (09) can swap in locally generated hulls
without touching code again.

PREREQUISITE: the 02–07 feature-branch work must be merged into main first —
this contract's invariants reference gates that live in `kit/done/` after that
consolidation (grade-providers, grade-polish).

Gate: `node kit/todo/08-ship-assets-pack/grade-ships.mjs`
(FAILs cleanly until each phase lands; run `node kit/grade.mjs` regression too).

## Phase 0 — Sourcing (HUMAN/RUNNER step, not the executor)

Download these packs (both **CC0 / public domain** — no attribution required,
verify the license page still says so at download time) and place the archives
or extracted folders into `assets/staging/ships-inbox/`:

- Kenney "Space Kit" — https://kenney.nl/assets/space-kit (glTF included)
- Quaternius "Ultimate Spaceships" — https://quaternius.com (glTF/GLB included)

The executor never downloads anything. If the inbox is empty, the grader FAILs
at S0 with "awaiting Phase 0 sourcing" — that is the signal to do this step.

## Phase 1 — Curation + manifest (executor)

1. From the inbox, select **8–12 hulls**: three visually distinct families
   (one per provider: claude / codex / signal), each family with small/medium/
   large variants where the pack allows, plus 1–2 tiny hulls for drones
   (shared across families).
2. Copy selected models into `assets/ships/` as `.glb` (if a model is only
   .gltf+bin+textures, copying the trio into a subfolder is acceptable;
   prefer single-file .glb). Each file ≤ 2 MB. Do NOT re-export through
   external tools.
3. Do not mutate geometry on disk. Orientation/scale normalization happens at
   load time via per-hull correction data you measure once (bounding-box
   inspection in a scratch script is fine): target facing **+Z**, up **+Y**,
   hull length ≈ **1 world unit** after correction.
4. Write `assets/ships/manifest.json`:

```json
{
  "schemaVersion": 1,
  "providerFamilies": { "claude": "<family-id>", "codex": "<family-id>",
                        "signal": "<family-id>" },
  "hulls": [
    { "id": "kenney-cruiser", "file": "kenney-cruiser.glb",
      "family": "<family-id>", "role": "main-m",
      "correction": { "rotateY": 0, "scale": 0.42 },
      "source": "Kenney Space Kit", "license": "CC0" }
  ]
}
```
Roles: `main-s | main-m | main-l | drone`. Every hull entry carries
`license: "CC0"` and a `source`. All three providers must map to a family;
at least one `drone` role must exist.

## Phase 2 — Integration (executor)

1. `package.json` is **unfrozen for exactly one line**: add
   `"babylonjs-loaders": "9.17.0"` (exact pin, matches babylonjs) to
   dependencies and install it. Nothing else changes in package.json.
2. `src/renderer/index.html`: add
   `<script src="../../node_modules/babylonjs-loaders/babylonjs.loaders.min.js"></script>`
   immediately after the babylon.gui script tag, before `util.js`.
3. New file `src/renderer/ship-assets.js` (script tag after `util.js`, before
   the scene files). Responsibilities:
   - Load `../../assets/ships/manifest.json` via fetch, falling back to XHR;
     if both fail, log once and use procedural darts.
   - Per scene: lazily load each needed hull ONCE into a
     `BABYLON.AssetContainer`; instantiate per ship via
     `instantiateModelsToScene` under a root `TransformNode`.
   - `AUR.ships.instantiate(scene, ship) -> TransformNode | null`:
     hull = provider family (via the provider helper in util.js) + role
     (`drone` for drones, else size by `fnv1a(ship.id) % 3`), correction
     applied on a wrapper node. Returns `null` if assets unavailable (caller
     falls back).
   - `AUR.ships.dispose(scene)` to drop containers with the scene.
4. Update the `buildShip` sites in `scene-universe.js`, `scene-system.js`,
   `scene-planet.js`: try `AUR.ships.instantiate` first, fall back to the
   existing procedural dart when it returns null. Ships that spawn before a
   container finishes loading use the dart and MAY be hull-swapped when
   loading completes; no crashes, no unhandled rejections.
5. **Preserve every existing invariant** — read `src/renderer/util.js` first:
   the returned root node must go through the ship-marking helper exactly like
   the dart did, provider tint must remain observable where the provider gate
   expects it (tint an accent part/material clone; do not repaint the whole
   hull flat), and labels / trails / attention badges / beams keep attaching
   to the ship root as before.
6. Offline rule stands: no `http(s)://` anywhere in renderer code or manifest.
7. Perf guardrails: one AssetContainer per hull per scene; material clones
   capped at one per provider per hull; total added triangles per scene
   < 100k; no per-frame allocations.

## Phase 3 — Optional, non-gating

If a multi-resolution `.ico` appears in `assets/staging/ships-inbox/`, install
it per the open `agent-universe-windows-icon` entry in
`kit/ASSET-REQUESTS.md` and mark that entry resolved. Skip silently otherwise.

## Acceptance

| # | Check |
|---|---|
| S0 | Sourcing present: `assets/staging/ships-inbox/` non-empty OR `assets/ships/manifest.json` already valid |
| S1 | `babylonjs-loaders` pinned exactly to the installed `babylonjs` core version (`9.17.0` at kit time) in package.json AND its UMD file exists in node_modules |
| S2 | index.html loads loaders bundle after GUI, before util.js; `ship-assets.js` tag present before scene files |
| S3 | Manifest valid: schemaVersion 1, ≥ 8 hulls, all files exist ≤ 2 MB, every hull `license: "CC0"` + `source`, all 3 providers mapped, ≥ 1 drone role |
| S4 | `ship-assets.js` exists, no `http(s)://` in it or the manifest |
| S5 | Regression: `node kit/grade.mjs` PASSes |

Runner additionally: the provider and polish gates archived under `kit/done/`
must stay green, and the system-view screenshot must show recognizable ship
hull silhouettes rather than darts. Done → `kit/EXECUTOR-REPORT.md`; stuck →
`kit/BLOCKED.md` and stop.

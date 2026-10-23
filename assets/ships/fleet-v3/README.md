# AUR Fleet v3

Four original hulls built from the owner's reference sheet (`_shared/references/fleet-reference-sheet.png`;
each hull's `references/` holds the per-view crops the toolkit's visual comparison reads): a white-and-charcoal kitbash fleet with a single accent color. A session climbs the
ladder by its build count; rank shows as silhouette with a gentle size step, never as a ship the
size of a planet.

| Slot | Hull | Unlocks at builds | Display length vs Scout | Real scale | Triangles |
| --- | --- | --- | --- | --- | --- |
| Scout | `aur-lance-interceptor` | 0 | 1.0 | 14 m delta interceptor | 5.7k |
| Workhorse | `aur-bastion-corvette` | 5 | 1.25 | 90 m twin-pod corvette | 9.8k |
| Capital | `aur-helix-destroyer` | 20 | 1.55 | 450 m spinal destroyer | 26k |
| Flagship | `aur-ark-carrier` | 60 | 1.9 | 2.5 km wheel carrier | 58k |

`assets/ships/manifest.json` lists them as the `aur-fleet-v3` family for both Claude and Codex; each
entry's `correction.scale` normalizes the hull to its display length (Scout = 1 unit before the
views' own ship scale). A subagent (drone) flies the first rank at `AUR.DRONE_SCALE` (0.6) of its
size in its parent's provider colors; only the metadata-only Signal provider is still a flat marker.

## How a hull is built

The sheet's ships are kitbash: stepped stacks of chamfered blocks with dark joints, inset plates,
window dashes, antenna forests and layered engine pods. `_shared/kitbash.py` is that vocabulary:

- `slab`, `cbox`, `plate`: chamfered blocks in world space or standing on a surface `Frame`;
  `segments` lays a row of hull segments with dark joints; `arc_car` sweeps a chamfered section
  along a ring; `tube`, `disc`, `drum`, `spike`, `rod` cover everything round.
- `window_run` places window dashes along `line_frames` or `arc_frames`; `greebles` and
  `arc_greebles` scatter seeded blocks, plates, drums, rods and vents over a patch; `antenna_cluster`
  raises a stepped mast with collars, arms, rods and a dish; `engine_pod` builds a nacelle with an
  intake, bands, shroud, nozzle, glow disc, fins, pipes, stripe and windows; `turret` is a
  twin-barrel turret.
- Every piece is a closed pydata mesh with an identity transform, so `join_by_material` can fold
  the thousand-odd pieces of a hull into one object per material (`Hull_White`, `Hull_Dark`,
  `Hull_Grey`, `Livery`, `Glow`, `Glass`, `Windows`): five to seven draw calls per ship. Those are
  object names; the materials they carry keep the names the app matches on (`hull_white`, ...).

Each hull's `build_<hull>.py` composes its parts from these and documents them in `REQUIRED_PARTS`.

## Who owns what

- **Blender owns the surface.** `_shared/fleet_v3.py` authors panel-line maps (base color, normal,
  roughness, metallic) for `hull_white`, `hull_grey` and `hull_dark` on a world-tiled cube projection
  and bakes them into the GLB through the image-to-blender-asset toolkit. The maps tile every 2.4 m
  (Scout), 6 m (Workhorse), 20 m (Capital) and 60 m (Flagship); the geometry above carries the
  visible detail, the maps add close-range texture.
- **The app owns the livery.** `src/renderer/ship-assets-hulls.js` keeps the three hull tones as
  baked and makes the ship color the hull's trim lighting: `accent_livery` (stripes, chevrons,
  collars) and `engine_glow` (nozzles, intakes) emit it (Claude terracotta, Codex pearl, a local
  model red) over a dark surface at 1.5x, so a line outshines the lit hull, and the glow pass blooms
  them; `window_light` is a cool lit pane
  on every provider and `canopy_glass` keeps its
  smoke. The system view trails a plume from each stern glow disc. On the lightless universe map
  the hull maps light themselves.
- **The app owns the lighting and size.** Every fleet material gets a procedural studio
  environment for reflections, its normal map boosted 1.6x and specular anti-aliasing; the
  system and planet views add a viewer-relative key and rim that only ship meshes see
  (`AUR.shipLights`). Ship size is one policy, `AUR.SHIP_SIZE` per view with the pixel floor
  `AUR.fitShip` keeps; `kit/SPEC.md` §4 is the contract. Ships patrol outside the last orbit and the belt, arc over the
  ecliptic to a standoff above the planet they work on, and fly back instead of snapping.

## Rebuild

Every hull folder has a `build_<hull>.py` next to its outputs. Run it through Blender 4.4 with
the toolkit on the path:

```powershell
$env:IMAGE_TO_BLENDER_SKILL_SCRIPTS = '<image-to-blender-asset skill>\scripts'
& $env:BLENDER_EXECUTABLE --background --factory-startup --python .\aur-helix-destroyer\build_aur-helix-destroyer.py
```

The script writes the `.blend` (already joined per material; the build script is the editable
source), `.glb`, `.fbx`, `babylon_viewer.html`, the four transparent QA renders, the textures, the
build metrics and the quality manifest into the hull's folder. Geometry is generated from first
principles; no third-party models are imported. The GLBs are single files (no far/near LOD split).
`qa/` holds the material and real-time audits (web-desktop profile, all PASS); the visual
comparison against the sheet scores 45 to 61 of the toolkit's 75 because the references are
generated concept art on white, which each quality manifest records.

## Materials the app expects

`hull_white`, `hull_grey`, `hull_dark` (textured, never repainted), `accent_livery` (trim light in
the ship color), `engine_glow` (the same; its stern discs anchor the plumes), `window_light` (cool
lit pane), `canopy_glass` (untinted smoke). Keep these names when
adding a hull.

# Asset requests

Wants discovered during the build that `assets/` doesn't cover. The build never
blocks on these — code uses a procedural fallback and the want is logged here
for a later asset pass.

Format per entry:

```
## <short-name>
- Purpose: what it's for, which view
- Suggested spec: format, dimensions, style notes
- Plugs in at: file/function where the fallback lives
```

## agent-universe-windows-icon
- Purpose: Branded icon for the Agent Orrery Desktop and Start-menu
  shortcuts.
- Suggested spec: Transparent multi-resolution Windows `.ico` with 16, 24,
  32, 48, 64, 128, and 256 px 32-bit RGBA frames, matching the dark
  navy/purple/cyan/gold universe UI.
- Plugs in at: `scripts/windows-shortcuts.ps1` in
  `New-AgentOrreryIcon`; until supplied, that function generates the
  deterministic orbit-glyph fallback outside the repository.

## fleet-nozzle-markers
- Purpose: Where each fleet hull's exhaust leaves it, for the system view's
  engine plumes.
- Suggested spec: In `assets/ships/fleet-v3/_shared/kitbash.py`, give intake
  glow its own material (`intake_glow`) or have `nozzle()` / `engine_pod()`
  leave a named empty (`Nozzle_*`) at each glow disc that survives
  `join_by_material` and loads as a TransformNode with position, direction
  and radius. Needs a rebuild of the four fleet-v3 hulls (frozen assets).
- Plugs in at: `src/renderer/scene/system/exhaust.js` (`glowIslands`,
  `nozzles`); until supplied, the part finds the discs as islands of the
  `engine_glow` mesh and keeps those within a quarter of the hull's length
  of the stern (`AUR.sternIslands`).

## fleet-trim-lines
- Purpose: Denser trim lighting on the fleet hulls, edge-traced light lines
  in the provider color, for the chase camera.
- Suggested spec: In each `assets/ships/fleet-v3/*/build_*.py`, add thin
  `accent_livery` strips along the panel edges, wing leading edges, fin
  edges and pod collars (a few centimetres wide, proud of the surface as the
  chevrons are) so `join_by_material` folds them into the `Livery` object.
  Needs a rebuild of the four fleet-v3 hulls (frozen assets).
- Plugs in at: `src/renderer/ship-assets-hulls.js` (`roleLook`, the
  `accent` role); until supplied, the stripes, chevrons, tip accents and
  collars Blender already authored are the trim lights.

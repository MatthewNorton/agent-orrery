# Executor report — galaxy grouping

Item 04 is complete. The universe remains one directly interactive map, now
with deterministic workspace-derived galaxy regions around every solar-system
glyph and a separate muted Graveyard for deleted projects.

## Product changes

- `src/main/tracker.js`
  - exports a pure cross-platform `deriveGalaxy(projectPath, projectId,
    exists)` helper;
  - adds the always-present `galaxy: { key, label }` field to the centralized
    public project serializer;
  - re-checks known paths during scans and emits one ordinary project update
    when deletion/revival moves a system into or out of Graveyard.
- `src/renderer/galaxy-layout.js`
  - provides order-independent, collision-separated galaxy/member layout and
    deterministic colors as a pure browser/Node UMD helper.
- `src/renderer/index.html`
  - loads the galaxy helper before the universe scene.
- `src/renderer/scene-universe.js`
  - renders one faint, non-pickable colored disc/outline and one label per
    galaxy;
  - moves every existing reusable glyph root into its galaxy, frames complete
    region extents, and coalesces structural reflow to once per event batch;
  - integrates galaxy and project labels into one dirty-driven declutter pass,
    with a deterministic galaxy-candidate cap for very fragmented maps;
  - exposes actual mesh/control/assignment metrics through `galaxyStats()`.
- `src/main/main.js`
  - records additive galaxy metrics in the existing isolated pointer harness
    and prefers an existing project when the fixture also contains derelicts.

No dependency, bridge API, navigation state, asset, lower-level scene, or
archived grader changed.

## Verification

- Frozen item gate: **PASS G1–G4** with 30 systems in four galaxies.
- Archived renderer polish: **PASS P1–P4**; 3/30 project labels visible in its
  30-singleton-galaxy stress profile; backdrop median 22.2, p90 42.4.
- Permanent renderer regression: **PASS**, with only the expected no-live-ship
  soft warning.
- Final isolated screenshots were visually reviewed: four separated regions,
  all four galaxy labels readable, muted Graveyard, visible project labels,
  no chrome collision, and intact return navigation.
- Actual profile passed three complete pointer-flow launches in succession: 27
  systems, six galaxies, eight Graveyard systems, zero renderer errors, and
  byte-identical cluster keys/counts/positions/radii/colors across restarts.
  The final wider camera fit keeps every actual-profile region fully on canvas.

## Known gaps

None against the contract. A map with more than 12 galaxies keeps every
region and label control but offers only the top three galaxy labels to the
screen-space selector at once; this preserves project readability and labels
can change naturally as the camera moves or the map structure changes. The
live spec records a narrow `scene-universe.js` size exception while its Babylon
region lifecycle, cross-class GUI declutter, and mesh-derived proof remain
co-located; further feature growth requires an explicitly unfrozen helper.

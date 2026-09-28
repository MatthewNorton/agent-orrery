# Contract — galaxy grouping

Add the missing galaxy layer to the universe map without adding a fourth
navigation scene. Projects remain directly clickable from the universe, but
their solar-system glyphs must be spatially grouped inside deterministic,
labelled galaxy regions derived from project paths.

## Editable scope

- `src/main/tracker.js`
- `src/main/main.js` — only additive isolated test-harness plumbing
- `src/renderer/index.html`
- `src/renderer/galaxy-layout.js` (new pure browser/Node helper)
- `src/renderer/scene-universe.js`
- `kit/todo/04-galaxy-grouping/**`
- status and live-contract documentation under `kit/`

Everything else is frozen. In particular, do not change `package.json`, the
lockfile, `src/preload.js`, `src/renderer/app.js`, `src/renderer/util.js`,
`src/renderer/polish-math.js`, either lower-level scene, any asset or mockup,
or any archived/current grader. Add no dependency, network request, or asset.

## G1 — portable project-to-galaxy contract

Export the pure helper `deriveGalaxy(projectPath, projectId, exists)` from
`src/main/tracker.js`. It must not read the filesystem, current directory,
environment, or host path flavor. Every serialized project returned by the
existing `publicProject` path must gain the always-present additive field:

```js
galaxy: { key: 'workspace:experimental', label: 'Experimental' }
```

Keep every existing project field and event type unchanged. Consequently the
same galaxy value must appear in snapshots, `project-added` and
`project-updated` events, `SystemData.project`, and `PlanetData.project`.

Derivation is deterministic and case-insensitive where Windows is:

- a non-empty project path with `exists === false` belongs to
  `{ key: 'graveyard', label: 'Graveyard' }`;
- recognize Windows and POSIX paths independently of the running OS;
- under `workspace` or `workspaces`, skip one or more generic containers
  (`code`, `src`, `source`, `repos`, `repositories`, `projects`, `dev`,
  `development`, `git`, `github`) and use the next segment, producing
  `workspace:<normalized-segment>`;
- under Windows, macOS, or Linux user homes, group `Documents`, `Desktop`,
  and `Downloads` subtrees as `home:<folder>`; a home root or hidden home
  subtree is `home`;
- under another root-level generic repository container, use its following
  segment as `container:<normalized-segment>`;
- otherwise group by the immediate parent using a collision-resistant
  canonical key: `path:win:<case-folded-parent>` or
  `path:posix:<case-preserved-parent>`;
- when the path is absent, apply the same structural recognition to a Claude
  project slug when possible; a truly opaque id uses `slug:<eight-hex-fnv1a>`
  and a bounded deterministic display label.

Labels humanize the selected segment and keys use lower-case kebab segments.
Trailing separators and mixed Windows slash styles cannot change the result.
The grouping directory itself must remain in its own galaxy (for example,
`C:\workspace\code\experimental` is Experimental, not Code).

During each existing tracker scan, re-check the existence of known project
paths. A deletion or revival must update `exists` and emit exactly one normal
`project-updated` payload, allowing a live move into or out of Graveyard.

## G2 — deterministic, separated layout

`src/renderer/galaxy-layout.js` must be a pure CommonJS/UMD helper exposing:

```js
layoutGalaxyProjects(projects)
galaxyColor(key)
```

The layout returns canonical sorted arrays:

```js
{
  galaxies: [{ key, label, x, z, radius }],
  projects: [{ id, galaxyKey, x, z }]
}
```

For an identical project set the result is byte-for-byte independent of input
order. Every project appears exactly once inside its galaxy radius, and every
pair of galaxy discs has a positive gap. Members within a multi-project galaxy
must not share one position. Normal galaxy color is a deterministic hash of
its key; Graveyard uses a fixed muted color and is placed farther from the
layout origin than every live galaxy.

Layout work occurs only during scene construction or a structural
`project-added` / galaxy-changing `project-updated` batch, at most once per
batch. Reuse existing glyph roots so parented ships move with their systems.
No layout allocation or rebuild is permitted in the idle render loop.

## G3 — galaxy regions in the existing universe

Keep the existing universe → system → planet navigation and all current sun
picking, hover reveal, attention, ship, build-pulse, and camera controls.
There is no galaxy route, click action, bridge method, or fourth scene.

For every represented galaxy render exactly one procedural region and one GUI
label. The region must be a very faint tinted XZ disc/nebula with a readable
outline, placed below the systems, and all of its meshes and anchors must be
non-pickable. Normal hues come from `galaxyColor`; Graveyard is visibly muted.
Labels read `GALAXY: <LABEL> · N SYSTEM(S)` and Graveyard reads
`GRAVEYARD · N DERELICT(S)`.

Feed galaxy-label rectangles through the same screen-space declutter decision
as project labels. Preserve the archived polish metrics as project-only while
also measuring combined label overlap and chrome occlusion. Hovered project,
question/permission, galaxy, online project, and recent-idle project priority
must remain deterministic in that order. At the default camera at least three
galaxy labels must be visible for the isolated four-galaxy fixture, with zero
measured overlap or DOM-chrome intersection.

Frame the camera from complete galaxy-region extents, never an 80th-percentile
subset. Live add/migration removes empty regions, creates new ones, updates
counts and labels, and never rebuilds the scene or drops a project glyph.
Keep the near-black backdrop within the archived polish luma limits.

## G4 — observable rendered proof

Expose `scene.metadata.galaxyStats()` and include its result as
`galaxyMetrics` in the existing isolated `--polish-test` result. Metrics must
be derived from actual scene meshes, GUI controls, glyph world positions, and
current store assignments. They must cover project/galaxy counts, keys and
member counts, Graveyard members, region and label counts, region pickability,
member containment, inter-region gap, deterministic colors, visible galaxy
labels, and combined measured label/chrome collisions.

The item grader creates 30 transcript projects: 8 Personal, 8 Experimental,
8 Documents, and 6 missing paths in Graveyard. The real Electron renderer must
prove exactly 30 pickable suns and project-label controls, four non-pickable
regions and galaxy-label controls, correct assignments/counts, all members
contained, separated regions, at least three visible galaxy labels, no label
or chrome collisions, no renderer error, and fresh universe/hover/camera/
return screenshots. The pre-existing real pointer path must still reach a
system and return to the universe.

## Gates

From the repository root, all commands must pass:

```powershell
node kit/todo/04-galaxy-grouping/grade-galaxies.mjs
node kit/done/polish-pass/grade-polish.mjs
node kit/grade.mjs
```

Visually inspect the item grader's universe, hover, camera, and returned
universe screenshots. Archive this unchanged kit under
`kit/done/galaxy-grouping/` with its executor report, validation log, JSON
metrics, and screenshots only after every gate and visual check passes.

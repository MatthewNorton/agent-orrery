# Agent Orrery — live app and renderer spec

The Electron main process passively watches Claude Code and Codex transcript
JSONL files plus explicitly configured metadata-only Signal directories, then
streams one normalized event vocabulary to three Babylon.js views over a
context-isolated bridge. An independent read-only replay source can reconstruct
that same vocabulary from bounded historical ranges. Passive observation does
not launch or own agent processes. Two explicit LIVE-only controls sit outside
that boundary: Open Terminal opens the host terminal (Windows Terminal on
Windows, Terminal.app on macOS) without starting an agent,
while the global IDEAS queue can assign a tagged goal to a trusted project and
start Codex for that exact task.

Gold samples (visual ground truth, in repo root):

- `3.universe-map-view.png` — universe map: project solar systems on a starfield
- `2.solar-system-view.png` — one project: sun, orbits, planets, asteroid belt, ships
- `1.planet-view.png` — one planet close-up with status panels

Frozen files: the **Frozen files** bullet in `AGENTS.md` is the one authoritative list. The main-process layout is described in
`.docs/architecture.md`.

## 1. Hard constraints

1. Plain JavaScript only: no `.ts` files (types are JSDoc, checked by `npm run typecheck`),
   no JSX, no bundler, no `npm install`.
2. Classic `<script>` tags only — **no ES modules** (`file://` module loading is
   blocked by CORS in Electron). Load order gives you globals; attach your own
   code to a single `window.AUR` namespace object.
3. Babylon is loaded from local UMD bundles (globals `BABYLON` and
   `BABYLON.GUI`). Script paths relative to `src/renderer/index.html`:
   - `../../node_modules/babylonjs/babylon.js`
   - `../../node_modules/babylonjs-gui/babylon.gui.min.js`
4. The renderer is fully offline. Zero network requests, no CDN, no fonts from
   the web. The two UI faces (Archivo, IBM Plex Mono; OFL) ship as WOFF2 under
   `src/renderer/fonts/` with their licences and are declared in
   `styles/tokens.css`; Babylon GUI labels keep the
   `system-ui, 'Segoe UI', sans-serif` stack until their width estimates are retuned.
5. `contextIsolation` is on. The ONLY way to reach the main process is
   `window.AU` (documented below). No `require`, no `process`.
6. New renderer files live flat in `src/renderer/` (the gates scan only the top level).
   Keep each file at about 300 lines, 400 at most; `grade-structure.mjs` fails any
   renderer file over 400. Growth means extracting a part or a helper.
7. One `BABYLON.Engine` for the whole app lifetime. Views may each build their
   own `BABYLON.Scene`; dispose the old scene on view switch.

## 2. Renderer files

Stylesheets live in `src/renderer/styles/`, one per concern (`tokens`, `base`, `modules`, `topbar`, `settings`,
`directory`, `rail`, `focus`, `focus-rooms`, `cards`, `hud`, `history`), linked from `index.html`
in that order, each under the same 300–400 line guideline as the JS. Gates that grep
styling read every file in that folder.

`index.html` loads, in order: the three Babylon UMD bundles (core, GUI,
loaders), then:

| Layer | Files |
|---|---|
| Shared libraries | `util.js` (creates `window.AUR`; `fnv1a`/`mulberry32` copied from `src/main/shared/hash.js` so seeds agree), `util-scene.js` (Babylon helpers), `procedural-worlds.js`, `ship-assets.js` + `ship-assets-hulls.js` + `ship-assets-api.js` (`AUR.ships`), `polish-math.js`, `galaxy-layout.js` and `galaxy-field.js` (pure UMD; the field is a galaxy's emission/dust atlas and the stars drawn from it), `search-core.js`, `components/project-vcs-status.js` |
| Views | `scene/common.js` (`AUR.sceneParts`), then for each view in `scene/<view>/` (universe, system, planet) its parts before its `view.js` |
| App state | `app/state.js` — the only file that assigns `AUR.app` (`state`, `const`) |
| App modules | every other file in `app/` and `app/project/`, in `index.html` order |
| Boot | `app/boot.js` — boot, event routing, view switching, debug hooks |

View contract: each `scene/<view>/view.js` registers
`AUR.views.<name> = (engine, data, ctx) => ({ scene, update(eventBatch), dispose() })`
where `ctx` provides `openSystem(projectId)`, `openPlanet(projectId, name)`, the
shared `store` and the graphics `quality` tier. Views may expose extras the app layer
probes for (`setSearchMatches`, `setQuality`, `focusShip`, `planetData`).

## 3. The `window.AU` bridge (matches `src/preload.js`)

`src/types/contract.d.ts` is the type-checked version of this section; where they differ, it wins.

```js
AU.snapshot()  -> Promise<{ projects: Project[], ships: Ship[], feed: FeedEntry[],
                            eventSequence: number, streamEpoch: number,
                            playback: PlaybackStatus,
                            buildHistogram?: { day: number, bins: number[] } }>  // LIVE: builds per half hour today
AU.getSystem(projectId)          -> Promise<SystemData | null>
AU.getPlanet(projectId, name)    -> Promise<PlanetData | null>
AU.openProject(projectId)        -> Promise<void>   // opens folder in Explorer
AU.openExternal(url)             -> Promise          // only https://github.com/<owner>/<repo>
AU.openTerminal(projectId)       -> Promise<{ok:Boolean, code?:String}>
                                   // LIVE-only host terminal request (win32/darwin)
AU.onEvents(cb)                  // cb(eventBatch: Event[], {streamEpoch, mode})
AU.replay({ action, ts?, speed? }) -> Promise<{playback, streamEpoch, snapshot?}>
AU.onReplayState(cb)             // bounded playback progress/status updates
AU.onProjectVcsStatusChanged(cb) // cb(status, {streamEpoch, mode}) — LIVE only
AU.onDebugView(cb)               // cb('universe'|'system'|'planet') — shots mode
AU.debugReady()                  // call after requested view has rendered a frame

// Per-project GOALS.md checklist (TASKS panel), LIVE only
AU.tasksGet(projectId)                 -> Promise<{exists, path, items} | null>
AU.taskAdd(projectId, text)            -> Promise<{ok, items}>
AU.taskSetDone(projectId, request)     -> Promise<{ok, items}>
AU.taskRemove(projectId, request)      -> Promise<{ok, items}>
AU.onTasksChanged(cb)                  // cb({projectId, taskId, phase})

// Global IDEAS queue; assign/retry start Codex on a tagged GOALS.md item
AU.rootTasksGet()                      -> Promise<{items}>
AU.rootTaskCreate(text)                -> Promise<{ok, …} | {ok:false, code}>
AU.rootTaskRemove(taskId)              -> Promise<…>
AU.rootTaskAssign(taskId, projectId)   -> Promise<…>
AU.rootTaskRetry(taskId)               -> Promise<…>
AU.onRootTasksChanged(cb)              // cb({taskId, phase})

// Moved-project recovery (settings dialog), LIVE only
AU.projectPathsScan()                  -> Promise<{ok, root, matches, truncated, …}>
AU.projectPathLocate(projectId)        -> Promise<…>
AU.projectPathApply(projectId, token)  -> Promise<…>   // token from scan/locate
```

```js
PlaybackStatus = {
  mode: 'live'|'replay', available, indexing, minTs, maxTs, cursorTs,
  playing, speed: 1|10|100|1000, sourceCount, truncated
}
// replay actions: index, seek, play, pause, speed, live
```

Shapes (all fields always present unless marked `?`):

```js
Project = { id, path, name, exists, firstSeen, lastActivity, totalBytes, totalBuilds,
            seed, galaxy: { key, label }, vcs? }   // vcs: LIVE snapshot/system only
// id: slug string; path: absolute dir or null; exists: bool (false = deleted/temp
// project -> render as dim "derelict" system); lastActivity: ms epoch;
// totalBytes: transcript bytes (proxy for historical activity); seed: uint32;
// galaxy is derived portably from cwd (workspace/home/container/path) and
// deleted paths use key `graveyard` with label `Graveyard`.

Ship = { id, name, provider, project, kind, status, detail, lastEvent,
         attention, attentionSince, builds, local, model, taskId?, turnOutcome? }   // ?: LIVE only
// provider: 'claude'|'codex'|'generic'; names use Claude-/Codex-/Signal-.
// kind: 'main' | 'drone' (drone = subagent, render smaller);
// status: 'Building'|'Exploring'|'Gathering Resources'|'Scanning'|'Delegating'|
//         'Planning'|'Working'; detail: string|null (e.g. relative file path).
// attention: 'question'|'permission'|'stalled'|'done'|null;
// attentionSince: ms epoch|null.
// builds: build events attributed to this ship since its source first read it
//   (catch-up included). LIVE tails transcripts already on disk at startup from
//   EOF, so a session running before launch restarts at 0. A ship-updated can
//   precede the build it reports; the renderer also counts `build` events.
// local: the session runs a local model. Codex: session_meta.model_provider is a
//   local server (oss, ollama, lmstudio, llama.cpp, vllm, localai). Claude: the
//   latest assistant message.model is not a Claude model. Drones inherit it from
//   their parent; a change arrives as ship-updated. The provider stays claude/codex.
// model: the model name the transcript last reported, as written (Claude
//   message.model; Codex session_meta.model and each turn_context.model, which the
//   adapter emits as a `turn-context` signal), control characters dropped, cut to 64
//   chars, null until known. Any model, any provider; the renderer prints it and never
//   interprets it. Drones inherit it; a change is a ship-updated.

FeedEntry = { kind, text, project, ts }
// kind: 'discover'|'form'|'build'|'info'|'spawn'|'depart'|'attention'|'done'

SystemData = { project: Project, planets: Planet[], beltDensity: number }
Planet     = { name, files, builds, procedural? }   // name '(root)' possible

PlanetData = { name, project: Project, builds, files, sizeKb, subdirs,
               resources: string[], procedural? }   // resources = top file exts
```

Event batch entries (from `AU.onEvents`):

```js
{ type: 'project-added',  project }        // new system discovered
{ type: 'project-updated', project }
{ type: 'ship-spawned',   ship }
{ type: 'ship-updated',   ship }           // status/detail changed
{ type: 'ship-departed',  shipId, ts }
{ type: 'build', project, bucket, file, shipId, isNew, ts }
   // project is the ID string; bucket = planet name; isNew => planet formation
{ type: 'activity', project, shipId, tool, status, detail, ts }
{ type: 'feed', entry: FeedEntry }
```

Every event entry also carries additive `seq: number`, monotonically increasing
within its source stream. The renderer reconciles `(streamEpoch, seq)` with the
snapshot boundary so live/replay transitions and events racing an invoke are
neither mixed, lost, nor applied twice.

The renderer-side store lives in `AUR.app.state.store` (`app/state.js`):
`projects` Map, `ships` Map, feed array (cap 60). `app/boot.js` applies every batch to
the store first, then hands the batch to the active view's `update()`, then
re-renders the affected overlay DOM. The renderer also synthesizes one event of
its own, `{ type: 'project-vcs-status' }`, when a git status push arrives.

## 4. Shared chrome (all three views — copy the mockups)

Design tokens (put in `:root`):

```css
--bg: #04050a;            --panel: rgba(13, 17, 28, 0.82);
--panel-border: rgba(120, 140, 190, 0.14);
--text: #e8ecf6;          --muted: #8b93a8;
--accent: #6c8cff;        --radius: 10px;
```

- **Top bar** (full width, ~56px): purple glowing dot logo, `AGENT ORRERY`
  (letter-spaced, semibold), pill badge `MULTI-PROVIDER` (purple-tinted
  border). Window controls are native — do not draw min/max/close.
  Universe view only: a `RECENT` strip after the badge — up to 5 pills, the
  most recently active projects sorted by `lastActivity`, each showing the
  project name (ellipsized), a green dot when the project has live ships, and
  jumping to that project's system view on click.
  A `SEARCH` glass field follows the strip: case-insensitive ranked project
  matches appear in a keyboard-accessible dropdown and Enter/click opens the
  existing guarded system route. It is present in every view; a view switch clears the
  query, and the GitHub filter also narrows the PROJECTS directory.
  A persistent gear opens `SETTINGS · GRAPHICS · PROJECT PATHS`. Graphics quality is a
  stepped slider over `AUR.app.const.RENDER_QUALITIES` (Low · Balanced · High), kept per
  viewer in localStorage; High is the default and the look every gate grades (§9). Missing project folders
  can be recovered with a bounded scan beneath a user-chosen parent or a
  native `Locate…` picker. Scan matches require explicit confirmation, remaps
  keep the original project ID/history, and path changes are LIVE-only.
- **Right sidebar** (fixed ~330px, full height under top bar, panel style):
  - `ACTIVE AGENTS` header with right-aligned `N Running`.
    Rows: small ship glyph (inline SVG, tinted from the provider palette), name
    (`Claude-3`, `Codex-2`, or `Signal-1`), colored status dot, compact
    `CLAUDE`/`CODEX`/`SIGNAL` tag, and `Status · ProjectName` in muted. Drones:
    slightly smaller row, dimmer. Empty state: `No agents in flight`.
  - `EVENT FEED` header with exact `LIVE` + green dot or `REPLAY` while history
    is visible. Rows: colored dot, text
    (wrap 2 lines max), right-aligned relative time (`12s ago`). Newest on top,
    cap 30 rows. Kind colors: build `#4da3ff`, form `#ffb454`, spawn `#34d399`,
    depart/info `#8b93a8`, discover `#a78bfa`.
- Agent rows and feed rows are clickable: clicking one opens the system view
  of that entry's project (no-op if already viewing that system; pointer
  cursor + hover tint signal it).
- **Bottom-left summary card** (panel): 3–4 big-number stats per view (below).
- Every module on either rail (project card, needs-you, tasks, planet card, summary, fleet,
  galaxies, event feed, ideas) folds to its header from the chevron at the right of the header,
  and each rail folds from the chevron at its top: the left rail to a strip, the right rail to
  its compact section buttons. The top bar's panels button folds or opens both rails at once.
  One mechanism (`app/modules.js`, `[data-module]` + `.is-collapsed`); the set of folded
  keys persists in localStorage.
- **Back control** (system + planet views, top-left under the project card or
  above it): `← Universe` / `← Orion System` style button.
- **History bar** (all views, fixed bottom): Play/Pause, `1x`/`10x`/`100x`/
  `1000x`, historical clock, scrubber, and exact `LIVE`. Existing sidebar,
  summaries, and planet tabs remain above it at 1200×720. Seeking atomically
  reseeds the store; returning LIVE installs a fresh tracker snapshot.
- Status dot colors: Building `#4da3ff`, Exploring `#a78bfa`,
  Gathering Resources `#ffb454`, Scanning `#34d399`, Delegating `#f472b6`,
  Planning `#facc15`, Working `#94a3b8`.
- Provider colors (`AUR.PROVIDERS`): Claude neon purple `#b026ff`, Codex blue
  `#2f7dff`, generic Signal `#94a3b8`; a `local` ship of either provider is red
  `#ff3344` (`AUR.LOCAL_MODEL`). `AUR.shipColor(ship)` and `AUR.shipTint(id,
  provider)` both resolve local, so hulls, agent rows and focus mode agree. The
  chrome says it too: a fleet row ends with the ship's `model` (`.agent-model-tag`,
  "Local · <model>" in `--local` red when local), the focus telemetry appends it to
  the provider, and the universe legend lists "Local model".
  Missing provider values in legacy fixtures normalize to Claude; raw/unknown
  values normalize to Signal.
- Fleet hulls wear a livery: graphite hull and armor, the structure (ivory)
  parts in the ship color, accents emitting exactly the ship color.
- Main Claude/Codex ships fly the `aur-fleet-v2` rank ladder in
  `assets/ships/manifest.json`: the hull is the highest rank whose `minBuilds`
  the ship's `builds` has reached (interceptor 0 → carrier 200); display size
  grows ~1.8× over the ladder. `AUR.ships` loads the hull's far file (`lods.far`,
  instanced from a per-provider template) on the universe map and its near
  `file` (clones, so focus mode can fade ships one by one) in system and planet
  views; a near view steps down to far, then to the dart, at 100k hull
  triangles per scene. `AUR.ships.refresh(scene, ship)` swaps the hull inside
  the asset root the scene already holds; `app/boot.js` calls it after `ship-updated`
  and `build` events, and it waits while focus mode has the ship faded.

## 5. Universe view (`3.universe-map-view.png`)

- Backdrop: `assets/skyboxes/skybox-001.png` (2048×1024 equirectangular) via
  `BABYLON.PhotoDome` (size ~1200), universe-only texture level `0.04`, plus a
  ~2500-point starfield (PointsCloudSystem or small billboards). Keep it dark —
  the mockup is near-black. The galaxy gate measures it over the clear centre of
  the frame: median luma ≤ 24 and p90 ≤ 48 (of 255).
- Each project = a **mini solar-system glyph**:
  - Emissive sun sphere; diameter ~ `1.2 + log10(totalBytes+1) * 0.35`.
    Sun color from seed: pick from `#ffb454, #ff7a59, #dfe6ff, #ffd27d, #9db8ff`.
  - Soft corona behind the sun in its colour: a billboard on the shared soft disc,
    excluded from the glow layer.
  - 2–3 thin elliptical orbit rings (LinesMesh circles, alpha ~0.25, tilted
    slightly toward camera like the mockup).
  - 3–5 tiny planet dots on the rings (deterministic from seed).
  - Label above: `PROJECT: <NAME uppercased>` — GUI TextBlock linked to the sun.
- Render every project glyph; never hide systems to solve label crowding.
  Labels use a deterministic, 6px-padded screen-space collision pass. Priority
  is hovered project → question/permission → galaxy → online project → recent
  idle project. The pass clips to the canvas area outside fixed DOM chrome,
  reveals a hidden project label on hover, allows more recent idle labels as
  the camera zooms in, and reruns only when camera/viewport, hover, project,
  galaxy, or ship state becomes dirty.
- **Deterministic galaxy layout** (persistent universe — same every launch):
  group projects by their additive `galaxy.key`. A galaxy is a spiral: two to four
  arms (by member count) twisting out from a core, and its systems sit on those arms
  by recency, the most recently active nearest the core, each on the next arm outward,
  with a per-project nudge off the arm and a lift that follows the disc's thickness
  (a bulge at the core, thin at the rim). The same layout for the same activity
  history; a project moves inward when it is worked on. The largest galaxy anchors the
  cluster and each other one touches a placed galaxy at the free slot nearest the
  cluster's centre, with a positive gap; every galaxy is lifted and tilted on its own
  pivot, which everything of its rides: the glyphs (and so their ships, pulses and
  labels) and the body.
- **Galaxy body**: a spiral galaxy, after the Sidereal observatory. `galaxy-field.js`
  computes an emission/dust atlas over the disc (cloudy logarithmic arms from the
  galaxy's spiral phase, a warm core, star-forming knots, dust lanes inside the arms,
  the arms leaning toward the galaxy's colour) and draws the resolved stars from it; the
  systems sit on their own, looser placement spiral, so the light winds as a galaxy's
  does while neighbouring systems stay a step apart. The renderer gives each galaxy a
  non-pickable volume box (the region mesh) that raymarches the atlas with a luminous
  bulge and dust extinction, and one point cloud of stars dimmed by the dust column in
  front of them; both are children of the pivot in the field's local frame scaled to the
  radius, rebuilt only when the radius or the graphics quality changes (the atlas pixels persist across view
  switches in `AUR.app.state.galaxyFields`), added to the scene (so glyphs inside stay
  legible) and outside the glow layer. No star is larger than the smallest sun
  (`AUR.SUN_DIAMETER_MIN`) or 12px. The pivot carries the label anchor, the camera
  bounds and the colour proof; a faint outline and a `GALAXY: <LABEL> · N SYSTEMS`
  label sit on it. Exposure is a design value; the backdrop luma budget above is a
  ceiling it clears. Graveyard is muted and peripheral.
  Galaxy and project labels share the 6px screen-space
  declutter pass. Camera framing uses the world-space bounds of every outline, lift
  and tilt included. ArcRotateCamera keeps
  wheel zoom + drag rotation and a dynamically sufficient radius clamp. Right-drag pans
  along the ground (`mapPanning`), the ground following the pointer at any zoom, and the
  target stays within the galaxies' footprint; only a left-click opens a system, and a
  double-click on open space re-fits every galaxy. A layout change re-fits only while
  the viewer has not moved the camera.
- States: system with ≥1 ship = "online" (brighter, sun pulse, label full
  opacity). Idle = normal dim. `exists: false` = derelict (very dim, ~40%
  opacity, no pulse).
- While project search is active, matching system glyphs and labels brighten
  through those same state materials and nonmatches dim; clearing or leaving
  the universe restores the ordinary online/idle/derelict appearance.
- Ships: every live ship = small dart mesh cruising near its project's system
  (slow orbit at radius ~6 around the glyph, gentle bob). Optional short
  `TrailMesh` (≤30 length). Drones smaller. On `ship-spawned`: warp-in flash;
  `ship-departed`: fade out.
- Events: `build`/`activity` → that system's sun does a quick pulse.
  `project-added` → glyph grows in from zero.
- Interaction: hover glyph → highlight + pointer cursor; click → zoom/fade
  transition into system view.
- Summary card: `UNIVERSE SUMMARY` — Projects / Active Agents / Systems Online
  (systems online = distinct projects with ≥1 ship).

## 6. Solar system view (`2.solar-system-view.png`)

Data: `AU.getSystem(projectId)`.

- Backdrop: skybox `assets/skyboxes/skybox-XXX.png` where
  `XXX = String(1 + seed % 12).padStart(3, '0')`, plus starfield.
- Central sun: emissive sphere + `BABYLON.GlowLayer`, subtle pulse.
- Planets: one per `planets[]` entry, on concentric orbit rings
  (LinesMesh circles, like the mockup's grid rings). Orbit radius by index
  (e.g. `10 + i*6`); diameter `1.1 + sqrt(files + builds*5) * 0.18` clamped
  [1.1, 4.5]. Texture: `assets/planets/planet-XXX.png` where
  `XXX = String(1 + fnv1a(project.id + ':' + name) % 31).padStart(3,'0')` —
  tileable albedo, set `uScale=vScale=2`. Slow orbital motion, varied speeds
  (0.02–0.08 rad/s, deterministic per planet). Planet label (name) appears on
  hover; keep labels for 2–3 largest planets always on, like the mockup.
- Asteroid belt: ring of instanced small rocks (one low-poly mesh +
  `thinInstance` transforms), count `min(beltDensity*4, 300)`, placed in an
  annulus between two middle orbits, slow rotation.
- Ships (only ships where `ship.project === projectId`): dart mesh + name label
  (GUI, always visible, like `Claude-1` callouts in the mockup) + short trail.
  Idle behavior: patrol orbit. On `build` event: fly to the `bucket` planet
  (~1.5s ease), fire a thin emissive beam at it for ~1s, planet pulses
  (scale 1 → 1.15 → 1). On `build` with `isNew: true`: re-fetch
  `AU.getSystem`, grow the new planet in from zero, feed shows planet formation.
  On `activity`: brief thruster flash.
- Project card (top-left, panel): `PROJECT: <NAME>`; rows: `STATE` (any ship
  Building → `Building` in accent blue; else the busiest ship status; no ships →
  `Dormant`), `BUILDS <totalBuilds>`, `LAST SIGNAL <relative time>`; plus an
  `Open Folder` button → `AU.openProject(id)` and a LIVE-only `Open Terminal`
  button → `AU.openTerminal(id)` (both hidden when `exists` is false). History
  replay keeps the terminal action visible but disabled. The renderer supplies
  only the project ID; main resolves and revalidates the live working directory.
  (The mockup shows a fake progress %; we deliberately show honest metrics in
  the same visual style.)
- TASKS panel (system view only, below the project card): reads the trusted
  project's root `GOALS.md`, shows open/total checklist progress, and supports
  adding, toggling, or removing manual goals. Removal is confirmed and uses an
  exact line/text check so stale views cannot delete a different entry;
  internally tagged agent goals remain protected. It refreshes every 10
  seconds so external agent edits appear without reopening the view; prose and
  source line endings in the file are preserved.
- IDEAS panel (global command rail): captures root-level to-do ideas before a
  project is selected. In LIVE mode the user can assign one to an existing
  project, which idempotently adds an internally tagged `GOALS.md` item and
  starts Codex. Any idea that is not mid-start or mid-run can be removed after
  confirmation; removing an assigned one also drops its unfinished tagged
  `GOALS.md` line when the project is reachable. The task shows Agent working while correlated work
  is active and Ready for review after successful agent completion marks it
  checked.
- Summary card: `PROJECT SUMMARY` — Active Agents / Building / Gathering /
  Exploring (counts of this project's ships by status; Scanning counts as
  Exploring).
- Interaction: hover planet → highlight + label; click planet → planet view.
  Back button → universe.

## 7. Planet view (`1.planet-view.png`)

Data: `AU.getPlanet(projectId, name)`.

- Large textured planet (same texture-pick rule) filling ~60% of view height,
  slow rotation, subtle atmosphere rim (Fresnel emissive or a slightly larger
  additive-alpha shell). 1–2 small moons orbiting. Skybox + starfield backdrop.
- This project's ships orbit the planet with name labels.
- Left panels (stacked, like the mockup):
  1. `PROJECT: <NAME>` mini-card (state + builds and the same folder/terminal
     actions as in system view).
  2. `PLANET: <NAME uppercased>` card — status dot `Active` (ships present) or
     `Dormant`; rows: `TYPE` `Terrestrial` (or `Unknown` when `procedural`),
     `RESOURCES` top file extensions joined (`TS, JSON, PNG`), `MASS`
     `<files> files`, `DIAMETER` `<sizeKb> KB`, `STRUCTURES` `<subdirs>`.
  3. `PLANET STATUS` card with labeled progress bars (clamped 0–100%):
     Infrastructure `subdirs/10`, Resources `files/500`, Build Energy
     `builds/50`.
- Bottom-center tab bar like the mockup: `Overview · Surface · Orbit ·
  Resources · Structures · Scans` — `Overview` active; all others rendered but
  disabled (muted, no-op). This is deliberate visual parity without scope creep.
- Summary card: `PLANET SUMMARY` — Active Agents / Structures / Resources /
  Builds.
- Back button → system view.

## 8. Debug / shots contract (grading depends on this — get it exact)

`npm run shots` launches with `--shots`. Main will send view names via
`AU.onDebugView(cb)`. On each:

- `'universe'` → show universe view.
- `'system'` → open the system for the best demo project: `exists === true`
  with the most recent `lastActivity`.
- `'planet'` → open that same system's largest planet.
- When the requested view has actually rendered (first frame after scene ready —
  e.g. `scene.executeWhenReady` then one `onAfterRenderObservable` tick), call
  `AU.debugReady()`. Main then waits ~1.8s (animations settle) and captures.

Also: `app/boot.js` must catch and `console.error` any async boot failure — renderer
console is forwarded to stdout in shots mode and scanned by the grader.

Item-02 adds a second test-only main-process mode:
`electron . --polish-test --polish-output=<dir>`. It reads renderer state only
to locate projected pick targets, then uses real Electron pointer input for
sun → system, Open Folder, planet → planet view, and both Back transitions.
Open Folder is recorded instead of launching Explorer in this mode. It writes
seven screenshots plus `result.json`; normal launch and `--shots` behavior stay
unchanged.

Item-06 adds `electron . --history-test --history-output=<dir>`. It owns
isolated Claude/Codex fixtures, drives the real history DOM controls at
1200×720, proves epoch isolation and background live catch-up, and writes four
screenshots plus bounded `result.json`. It never reads the real profile.

Item-07 adds `electron . --control-test --control-output=<dir>`. It owns an
isolated live/history fixture and an injected recording launcher, drives the
real project/history controls at 1200×720, proves LIVE-only behavior and safe
fixed Windows Terminal arguments, and writes two screenshots plus a bounded
`result.json`. It never reads the real profile or opens a real terminal.

## 9. Performance guardrails

- Target 60fps idle on integrated graphics: ≤3000 starfield points, belt via
  thin instances only, one GlowLayer per scene max, no per-frame allocations in
  observables (reuse Vector3s), dispose scenes fully on view switch
  (`scene.dispose()` and drop references).
- Graphics tiers trade frame rate for detail: each sets the share of the display's
  pixels the engine renders (`setHardwareScalingLevel`), the galaxy volume's raymarch
  steps (a `STEPS` define) and the share of resolved stars. GUI labels keep their size and
  layout at every tier (`AUR.guiLayer` sets `renderScale`) and soften with the scene below
  High; star points stay capped at 12 display pixels. Test-mode runs keep their
  storage in an in-memory partition, so they render the default tier and default panels
  whatever the viewer saved.
- Textures are 1–5MB PNGs; load per scene, never re-fetch in a loop.
- The event stream can burst (a batch per second per active session). `update()`
  must be O(batch) for ordinary ship/activity events and never rebuild the
  scene. A project add or galaxy-changing project update may trigger one
  coalesced pure layout/region reflow after the whole batch while reusing every
  existing glyph root. Overlay DOM re-renders only affected sections.
- Dense-universe label layout is dirty-driven. Do not allocate/reflow label
  candidates on idle frames; camera movement, resize, hover, and relevant
  store updates are the only invalidators.
- History indexing uses at most 256 KiB each from a candidate's head and tail,
  retains at most 50,000 newest effective sources, and captures immutable byte
  lengths. Replay streams only to the selected cursor, caps lines at 1 MiB,
  yields after bounded I/O, emits batches of at most 256, and never writes a
  transcript or persistent universe state. Generic Signal content is never
  read and is therefore not replayable.

## 10. Assets manifest

- `assets/planets/planet-001.png` … `planet-031.png` — 1024×1024 seamless
  tileable albedo (flat texture, not equirect; tile it on spheres).
- `assets/planets/planet-031-bump.png` — optional 1024×1024 grayscale height map
  used as a bump texture by the Testbed Delta surface.
- Authored planet albedo remains the default. Deterministic runtime height maps
  supply bump variation, while explicitly procedural `Sector-*` worlds generate
  both albedo and height data for rocky, gas, ice, volcanic, and oceanic classes.
  Generated maps are square and use the same `uScale=vScale=2` contract as the
  authored library; a bounded 48-surface cache keeps revisits fast.
- `assets/asteroids/asteroid-001.png` … `asteroid-003.png` with matching
  grayscale `-bump.png` source heights and Babylon-ready `-normal.png` maps —
  dedicated 512×512 cratered rock surfaces for the three deformed asteroid
  archetypes. Babylon materials consume the RGB normal maps, not raw grayscale.
- `assets/skyboxes/skybox-001.png` … `skybox-012.png` — 2048×1024 true
  equirectangular, for PhotoDome.
- `assets/palettes/palette-001.json` … `palette-012.json` — named color trios:
  `{ name, descriptor, colors: [hex, hex, hex], loreSentence, kind }` with
  `kind` one of `ship | station | system` (4 of each). OPTIONAL, not graded:
  you may pick one by `fnv1a(id) % 12` to tint suns/ships or flavor tooltips;
  the §4 palettes remain the default.
- `assets/manifest.json` — index of the library (id/file/type/tags per asset);
  use it if you want to enumerate assets instead of hardcoding counts.
- Paths from `index.html` are `../../assets/...`.
- Missing something (ship sprite, icon, texture variant)? Do NOT generate,
  download, or inline large data-URI art — use a procedural/geometric fallback
  and log the want in `kit/ASSET-REQUESTS.md`.

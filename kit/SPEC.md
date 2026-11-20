# Agent Orrery — live app and renderer spec

The Electron main process passively watches Claude Code and Codex transcript
JSONL files plus explicitly configured metadata-only Signal directories, then
streams one normalized event vocabulary to three Babylon.js views over a
context-isolated bridge. An independent read-only replay source can reconstruct
that same vocabulary from bounded historical ranges. Passive observation does
not launch or own agent processes. Two explicit LIVE-only controls sit outside
that boundary: Open Terminal focuses the selected live agent's existing terminal
(Windows Terminal/classic console on Windows, Terminal.app on macOS). Only dormant
projects open a fresh shell; no agent is started by this action,
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
| Shared libraries | `util.js` (creates `window.AUR`; `fnv1a`/`mulberry32` copied from `src/main/shared/hash.js` so seeds agree), `util-scene.js` (Babylon helpers), `procedural-worlds.js` (world profiles: class, palette, hue, seed; asteroids), `worlds/` (kit 15: the pure map generator `noise.js` + `classes.js` + `maps.js`, run by `worker.js`, a worker file and not a page script; `textures.js`, the map service on `AUR.app.state.worldMaps`; `shaders.js`; `material.js`, a world's globe and shells; `sun.js`, the system sun's photosphere plugin and billboards), `ship-assets.js` + `ship-assets-hulls.js` + `ship-assets-api.js` (`AUR.ships`), `polish-math.js`, `galaxy-layout.js` and `galaxy-field.js` (pure UMD; the field is a galaxy's emission/dust atlas and the stars drawn from it), `search-core.js`, `components/project-vcs-status.js` |
| Views | `scene/common.js` (`AUR.sceneParts`), `scene/sky.js` (`AUR.addSky`, the system and planet views' baked sky), then for each view in `scene/<view>/` (universe, system, planet) its parts before its `view.js` |
| App state | `app/state.js` — the only file that assigns `AUR.app` (`state`, `const`) |
| App modules | every other file in `app/`, `app/project/` and `app/panels/`, in `index.html` order; the last of them is `app/route.js`, the routes (universe, system, planet, the back button, the debug views of §8) |
| Boot | `app/boot.js` — boot, event routing, view switching (`A.setView`) |

View contract: each `scene/<view>/view.js` registers
`AUR.views.<name> = (engine, data, ctx) => ({ scene, update(eventBatch), dispose() })`
where `ctx` provides `openSystem(projectId)`, `openPlanet(projectId, name, system?)`,
`shown(scene)` (the stream the app shows that scene in, `null` once another view has its place:
a view compares it around a call of its own that it awaits, and drops an answer that comes after
a change), the
shared `store`, the graphics `quality` tier, the `galaxyFields` cache and `worldMaps`, the generated
planet maps (`worlds/textures.js`: a view opens an epoch on its scene and requests maps in it; disposing the scene closes the epoch),
and the Settings `skyLook` and `orbitRings` (§4). The app builds every view through
`AUR.buildView` (`scene/common.js`): a factory that throws leaves no scene behind, since any scene it
had made is disposed before the error is passed on. What a view keeps outside its scene (an element
on the page, a timer) it ties to the scene's `onDisposeObservable`, so it goes with the scene
whether the build failed or the view was disposed; `AUR.disposeView` disposes the scene even when a
step before it throws. `A.setView` makes the route (`AUR.app.state.current`: the view, and the
project and planet its data names, `A.viewRoute` in `app/route.js`) the new view's only once the
view is built; a view that cannot be built leaves the one shown, and its route, as they were.
Views may also implement `resize`,
`setQuality`, `setSkyLook`, `setOrbitRings`, `setSearchMatches`, `setShipFocus`, `focusShip` and `shipFocusState`;
the app fills in a no-op default for any they leave out (`VIEW_DEFAULTS` in `app/boot.js`).
Agent focus (`focusShip(id, settings)`, `setShipFocus(settings)`) takes `{ vantage, exterior }`:
`exterior` (the default environment, a chase camera outside the hull that stands off by the hull's
own span; a left drag orbits it and the wheel zooms, as in the system view, and a chosen vantage or
environment re-seats it) or one of the first-person rooms, each a `camera: 'room'` entry in
`C.AGENT_FOCUS_ENVIRONMENTS`. The overlay never takes the pointer itself (its button groups do):
the scene gets it, and the view spends it on the chase camera's orbit or, in a room, ignores it.
Three more members are optional and have no default: the `planetData` field, read through
`A.activePlanetData()`, and the `systemData` field and `clearShipFocus()` method, which
`app/agent-focus.js` checks for before using them. The system view carries `systemData`, its
system as it stands, and hands it to a planet it opens.

## 3. The `window.AU` bridge (matches `src/preload.js`)

`src/types/contract.d.ts` (with `calls.d.ts`, which it exports again) is the type-checked version of
this section; where they differ, it wins.

```js
AU.snapshot()  -> Promise<{ projects: Project[], ships: Ship[], feed: FeedEntry[],
                            eventSequence: number, streamEpoch: number,
                            playback: PlaybackStatus,
                            buildHistogram?: { day: number, bins: number[] },  // LIVE: builds per half hour today
                            warnings?: string[] }>  // LIVE: provider problems this run (format drift, providers.json)
AU.getSystem(projectId)          -> Promise<SystemData | null>
AU.getPlanet(projectId, name)    -> Promise<PlanetData | null>
AU.openProject(projectId)        -> Promise<void>   // opens folder in Explorer
AU.openExternal(url)             -> Promise          // only https://github.com/<owner>/<repo>
AU.openTerminal(targetId)        -> Promise<{ok:Boolean, code?:String}>
                                   // LIVE-only project or ship ID (win32/darwin)
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

// Forgetting a project (settings dialog, system-view project card), LIVE only
AU.projectForget(projectId)            -> Promise<{ok, canceled, playback, streamEpoch, snapshot}
                                                  | {ok:false, code}>
   // main confirms with a native dialog; refused with ACTIVE while a ship is in the project.
   // Success starts a new LIVE stream epoch: the renderer reseeds from `snapshot` and rebuilds
   // its route (no project-removed event exists). The project is recorded as forgotten in
   // universe-state.json and stays off the map while its transcripts only hold older work;
   // newer activity brings it back as a new system. History playback still shows it.

// Universe backup (settings dialog)
AU.universeExport()                    -> Promise<{ok, canceled, path, projects, ideas}>
AU.universeImport()                    -> Promise<{ok, canceled, added, merged, ideas}>  // LIVE only
   // One JSON file: universe-state.json as the model stands plus the IDEAS queue's texts.
   // Import merges (larger build counts, earlier firstSeen, later lastActivity) and never
   // removes; new projects arrive as project-added events, imported ideas as new items.
   // A bucket is kept under any name a build can start one under (`isBucketName`), `__proto__`
   // and `constructor` too. A project is kept under its id when the id is plain text, not blank
   // and 256 characters at most (`validProjectId`), those two names included. A folder keeps one
   // bucket, by the rule of the path the project ends with (its own, else the one the file gives
   // it): under a Windows path each side's counts for `docs` and `Docs` are made one, and the
   // larger of the two sides is kept. How one side's casings are made one follows whether its
   // builds were counted under a path, which a project keeps with its buckets (`bucketsCounted`,
   // saved in the state file and the backup) for every later path; `foldBuckets` in
   // `src/main/build-buckets.js` says how. A folder never has more builds than its project.
   // Every build count (a folder's, a project's total, a ship's), here, in the state file and
   // as builds add to it, is a whole number up to Number.MAX_SAFE_INTEGER: anything else in a
   // file counts as none, and a build adds nothing to a count that is already the largest.
   // A saved project's name, path, buckets and counts have one reader (`live/saved-project.js`)
   // for both files: an entry that is not a record is passed over; a name is kept only as plain
   // text (no control character, 4,096 characters at most, and not `__proto__`, `constructor`
   // or `prototype`) and otherwise the project goes by its folder or its id; a bucket is a name
   // a build can start one under (`isBucketName`, below) with a whole count above none, 10,000 of
   // them at most, and a project's total is at least its largest bucket. The path alone has a
   // rule per file: the state file's is used when it is local, a backup's only when it is also
   // absolute, and normalized.
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
// provider: 'claude'|'codex'|'generic'|'local'; names use Claude-/Codex-/Signal-,
//   and a local server's own label (Ollama-).
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
//   The 'local' provider is the server itself: a model loaded in Ollama, read from
//   its loopback /api/ps, is a ship named Ollama-<n> in the Ollama system (the
//   server's home folder), always local: true with model set; detail is its size
//   and CPU/GPU split, and an activity (tool 'ollama') marks each request it serves.
// model: the model name the transcript last reported, as written (Claude
//   message.model; Codex session_meta.model and each turn_context.model, which the
//   adapter emits as a `turn-context` signal), control characters dropped, cut to 64
//   chars, null until known. Any model, any provider; the renderer prints it and never
//   interprets it. Drones inherit it; a change is a ship-updated.

FeedEntry = { kind, text, project, ts }
// kind: 'discover'|'form'|'build'|'info'|'spawn'|'depart'|'attention'|'done'|'warning'

SystemData = { project: Project, planets: Planet[], beltDensity: number, planetTotal? }
// planets: the project's biggest, at most 8, which the system view draws; planetTotal: how many
//   it has, present only when that is more
Planet     = { name, key, files, builds, procedural? }   // name '(root)' possible
// key: which planet this is, decided by main (`planetKey` in `src/main/build-buckets.js`): one
//   key for every casing main counts as the folder. A Planet, a PlanetData and a `build` event
//   are of one planet when their keys are equal; the renderer compares them and never reads them.
//   Names are unique in a system and keys almost always are: a case-sensitive folder under a
//   Windows path (WSL) can hold `Docs` and `docs`, two planets with one key and one build count.
//   A build then goes to the one it spelled (`bucket`), else the first (`AUR.planetOfBuild`).
// A planet folder, live: an entry the project folder's listing types as a folder (`planetFolders`
//   in `src/main/live/system-view.js`); a link or junction is typed a link, so it is never one. A
//   planet's file is every other entry, a link or junction too, which counts as the one file it is
//   and is never followed (`isPlanetFile`): a planet's `files` and `beltDensity` in the system view
//   and the planet card's `files` count alike. getSystem draws the planet folders that are not
//   ignored (a name starting with `.`, or one of `IGNORE_DIRS` such as `node_modules`), and
//   `(root)` when the top-level files have builds. getPlanet reads any planet folder. So a folder
//   with builds that the system view does not draw (`.github`) stays in `Project.planets` (every
//   bucket's key), which Go to lists, and opens as a planet that reads its folder. Every bucket
//   opens: a bucket's name is one a planet can have (one plain path segment) with no control
//   character (`isBucketName` in `src/main/build-buckets.js`), and a project keeps 10,000 at most.
//   One rule for both models' counting and both files' reader, so a bucket reads back after a
//   restart as it was.

PlanetData = { name, key, project: Project, builds, files, sizeKb, subdirs,
               resources: string[], procedural?, folderRead? }   // resources = top file exts;
// name: the planet as the system view draws it, which seeds its globe: live, the folder as the
//   disk spells it; in history, its bucket's key. Under a Windows path it can differ in case from
//   the name asked for, and the renderer takes it as the planet's name.
// procedural: a stand-in with invented folder numbers. Live: the project has no folder on disk,
//   or the planet has a stand-in's name (`Sector-N`), no builds, and by the project folder's
//   listing nothing or a file at that name, or the listing could not be had (the rule is
//   `planetFolders`'; getSystem draws stand-ins when it has no planet to draw). A folder the
//   listing had that is gone by its read is 'gone', not a stand-in. History: no builds at the cursor.
// folderRead: live only. 'full'; 'partial' (the read stopped short, so files and size are
//   floors); 'gone' (the folder is not there); 'none' (it is there and could not be read: locked,
//   a passing error, a link, or a project folder that cannot be listed). A planet read never
//   descends into a link: the planet's folder is a planet folder (above) and every folder below is
//   typed by its parent's listing, which types every link and junction as a link, never as a
//   folder. A link inside a planet counts as a file of the link's own size, and a file named
//   `*.asar` as the plain file it is: main turns Electron's asar handling off before anything
//   else loads (`process.noAsar` in `main.js`), which would otherwise open and parse it. A folder swapped
//   for a link between its parent's listing and its own read can still be followed (that needs a
//   process already writing inside the project).
//   Absent when there was no folder to read (procedural, or history).
// builds, project: as they stand when the answer is made, after the folder was read. A project
//   forgotten meanwhile answers null. A project whose folder changed during the read is read once
//   more; if it changed again the answer is null, so counts and project are never of two folders.
// A name that is not one plain path segment (a separator, `.`, `..`, a NUL, over 255 characters;
//   `(root)` is one) answers null, LIVE and replay alike, whatever folder the project has: main
//   checks it before either is asked (`au:planet`), so nothing is read for it and no stand-in made.
```

Event batch entries (from `AU.onEvents`):

```js
{ type: 'project-added',  project }        // new system discovered
{ type: 'project-updated', project }
{ type: 'ship-spawned',   ship }
{ type: 'ship-updated',   ship }           // status/detail changed
{ type: 'ship-departed',  shipId, ts }
{ type: 'build', project, bucket, key, file, shipId, isNew, ts }
   // project is the ID string; bucket = the edit's top-level folder as the edit wrote it, or
   // '(root)'; isNew => planet formation. A folder whose name can be no bucket (`isBucketName`),
   // or a new one in a project that has 10,000, starts none: the build counts in the project's
   // and the ship's builds only, with isNew false. Under a Windows path main keeps one bucket for
   // a folder's casings, so the planet is found by `key` (the Planet's and PlanetData's), not by
   // the bucket's spelling. An edit's path is checked once, trimmed, where its transcript is read
   // (`safePath`): one that holds a NUL, CR or LF, or is over 4096 characters, names no file, and one
   // that is relative, or not in its project path's syntax (a Windows path with no drive), is in no
   // project. Either is no build, live and in history alike; its tool still shows.
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

- **Top bar** (full width, `--bar-h`): ring-and-star logo, `AGENT ORRERY`
  (letter-spaced, semibold), mono badge `MULTI-PROVIDER`. Window controls are
  native — do not draw min/max/close.
  The controls sit on the right, led by a square search button and the GitHub filter. The button
  (or `/`, or Ctrl K) opens the Go to palette (`app/project/search.js`, rows by
  `app/project/search-rows.js`, `styles/search.css`): a modal dialog near the top centre, up to
  800 px wide, with its field first and the results below. The query ranks up to 6 projects, 4
  agents and 4 folders (`search-core.js`): prefix, then substring, then a project's path,
  repository or branch (an agent's status) holding the query, then fuzzy matches, the query's
  characters in order (3 or more), scored by how close they sit and whether they start words; a
  word counts the same wherever it sits in the name (`dsb` finds `web-dashboard` as it finds
  `dashboard`), and how far along the match starts only orders the matches.
  PROJECTS ranks its query the same way, whole matches only (`rankProjects` with `fuzzy: false`
  runs no fuzzy pass). Both rank and mark the name they show (`A.projectLabel`, so a project
  without a name is found by its id) and match real values only:
  the `Unnamed project`, `Branch unavailable` and `Detached HEAD` labels match nothing, and case
  folds letter by letter (`İ` as `i`, `ς` as `σ`; the VCS component's own search folds the same
  way). Each row shows the live dot (an agent's is its
  provider colour), the name with the characters its match found marked (none when the path,
  repository, branch or status found it), the full path, the repository and branch (an agent's
  status) and its kind. Short of room the repository gives way first, then the start of the
  path; the path's last two folders stay, or as many as tell it from a result of the same name (a
  folder of a project at a drive or filesystem root reads `D:\src`, with one separator).
  Arrows, Enter and click pick a result through the existing guarded routes. The arrows move the
  selection on the rows as they stand, and a refresh from the store keeps the elements of every
  row whose entry is still listed, also when a row comes in or goes above it (`A.renderListbox`),
  and the list stays scrolled where it was. A row is its entry's key, and every entry has one of
  its own: a project `p:<id>`, an agent `a:<id>`, a folder `f:` + the JSON of
  `[<project id>, <folder>]`. The kinds differ in the first letter, and no two id and folder pairs
  are written as the same JSON, whatever they hold (a folder name, one main counts builds under,
  may hold a quote; a project id from a state file may hold anything). `A.renderListbox` logs,
  once for a key, two entries that share one: a click on either row would open the first. A click opens the entry that was
  pressed (`A.wireListbox`): when the rows moved under a pointer that stayed put, the release
  lands on another row and the pressed entry, found by its key, still opens while it is listed.
  PROJECTS shares all of it (its key is the project id). While an input method
  composes text (`AUR.composing`), Enter, Escape and the arrows are its own. Escape, a click
  outside (pressed and released outside the dialog's own box with the main button, so a drag out
  of the field selecting text keeps it; Settings follows the same rule, `AUR.closeOnBackdrop`), a
  pick or a view switch closes the palette and clears the query; focus goes back where it was,
  except after a pick, which leaves it on the page (a field the palette was opened from would
  take the next keys as text), and stays in the dialog while it is open. The
  backdrop is a light shade, so the universe's matching systems show behind. The GitHub filter
  narrows the results (and their agents and folders), the map and the PROJECTS directory, and is
  wired apart from the palette; the
  palette's footer says so while it is on. A bar under 1100 layout px (text size counts) keeps
  PROJECTS to its mark and count; a bar still short of room takes it from the brand (the badge
  gives way to an ellipsis, then the name), so the controls on the right stay on screen. The
  chrome's other width rules count the text size too: PROJECTS opens at the window's edge, not
  beside the right rail, once the chrome has 1040 layout px or fewer across.
  A persistent gear opens Settings, one tab at a time: Graphics · Panels · Shortcuts · Projects · Backup
  (`app/settings-tabs.js`; arrow keys, Home and End move between the tabs, the last tab chosen
  stays chosen while the app runs, and Settings opens on Projects while a project folder is
  missing). On Graphics, quality is a
  stepped slider over `AUR.app.const.RENDER_QUALITIES` (Low · Balanced · High), kept per
  viewer in localStorage; High is the default and the look every gate grades (§9). Below it,
  Space backdrop picks the look of the system and planet views' sky from `AUR.app.const.SKY_LOOKS`
  (Vivid · Soft · Distant · Faint; Distant is the default), and Orbit rings turns the system
  view's orbit rings on or off (on by default). Both are kept per viewer in localStorage
  (`app/scenery.js`) and change the open view at once. On Panels (`app/panels/look.js`, both
  kept per viewer), Panel opacity sets the fill of the rail modules, the compact rail buttons and
  the timeline from 20% to solid through one token, `--panel-fill`; 86%, the alpha of `--paper`, is
  the default, text and controls stay, and at 100% the panels drop their blur. Text size zooms the
  chrome around the star chart (top bar, rails, view title and hint, timeline,
  directory, Go to palette, panels menu, toast and Settings) by 100 · 110 · 125 · 150%
  with CSS `zoom`; the star chart keeps its size. The zoom stops where the window would leave the
  chrome less than 1024 × 576 CSS px, the least room it was checked to lay out in without its parts
  overlapping (`C.TEXT_SIZE_ROOM`), and Settings says so under the sizes when it does. While a
  control for those two has focus, the dimming behind Settings lifts so the panels show as they
  change. Panels also holds the At launch layout (see Panels below). On Projects, missing project folders
  can be recovered with a bounded scan beneath a user-chosen parent or a
  native `Locate…` picker. Scan matches require explicit confirmation, remaps
  keep the original project ID/history, and path changes are LIVE-only. Backup exports the
  universe to one file and merges one back in (`app/project/backup.js`).
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
    depart/info `#8b93a8`, discover `#a78bfa`, warning `#ff5d5d`. The run's provider warnings
    (`snapshot.warnings`, plus every `warning` entry since) stay pinned above the list in both modes:
    a transcript format this version does not recognise, or a `providers.json` error.
  - **Expanded feed** (`app/panels/feed.js`). The feed header's expand button, or *Expand the event feed* in the panels menu, widens the right rail to 46% of the window, up to 640 px and never narrower than the rail was. A width dragged while expanded is kept apart (`rightExpanded`). The feed takes the rail's height and lists every event it keeps (60):
    - each event's time of day and its whole sentence
    - a search by agent, project or file, and filter chips with counts: All, Builds, Ships, Attention, Systems (`AUR.feedGroup`: build and form are Builds, attention, done and warning Attention, discover Systems, the rest Ships)
    - "{n} of {total} shown" below
    - a "{n} new events" jump back to the top when events arrive while the list is scrolled; a scrolled list keeps its place (rows are kept per event, and `overflow-anchor` holds the view), and a text selection survives new events
    - a click that ends a selection of a row's text does not open the row's system
    - The rail's other panels show folded without changing their own state. Folding or hiding the feed, folding the right rail (Fold every panel too), or opening one of the rail's other panels puts the feed back.
- Agent rows and feed rows are clickable: clicking one opens the system view
  of that entry's project (no-op if already viewing that system; pointer
  cursor + hover tint signal it).
- **Summary card** (left rail, hidden at launch by default): 3–4 big-number stats per view (below).
- **Panels.** Every panel is open, folded to its header, or hidden.
  - **Which panels.** The panels are Needs you, Summary, Project, Tasks and Planet on the left rail; Fleet, Galaxies, Event feed and Ideas on the right; and the Timeline at the bottom. The tables of rails and panels are `panel-layout.js`, a UMD helper the Node tests share; the menu, Settings, folding and the compact rail read them.
  - **Folding.** A panel folds from the chevron at the right of its header. Each rail folds from the chevron at its top: the left rail to a strip, the right rail to its compact section buttons. The top bar's panels button folds or opens both rails at once. Folding is one mechanism: `app/modules.js`, `[data-module]` plus `.is-collapsed`.
  - **Hiding.** A panel hides from the panels menu (the caret beside the panels button, `app/panels/menu.js`). The menu lists the panels the view shows, with a tick each, and actions to fold every panel, start every run with this layout, and open Settings › Panels.
    - A hidden panel takes `.is-dismissed`, apart from the `.hidden` a view sets, and keeps its fold for when it comes back.
    - Hiding shows a toast with Undo (`app/toast.js`), centred under the top bar.
    - A hidden Galaxies list skips its renders and renders as it comes back.
    - Needs you never hides and the timeline never folds.
    - A rail with no panel on screen takes no room, and the view's name or hint moves into it (CSS `:has()` in `hud.css`). With the timeline hidden, `--dock-h` is 0, so the chrome above it reaches down.
  - **Resizing** (`app/panels/resize.js`). Sizes are CSS px, so they grow with the text size, and are stored per viewer (`agent-universe.panel-sizes.v1`).
    - **Rail width.** A rail's inner edge is a `role=separator` grip. It drags the rail's width (`--rail-l`, `--rail-r`), down to 240 px, with no other limit than stopping 24 px short of the other rail (`fitRails` in `panel-layout.js`). When the two do not fit, the side being dragged or put back gives way, otherwise the left rail. The view title and hint, the directory and the camera's clear area follow.
    - **Panel height.** The gap under Needs you, Summary, Fleet, Galaxies, the Event feed or Ideas drags that panel's height (`--panel-h` with `.is-sized`). A sized panel keeps its height and gives it up last when its rail runs short, so it never pushes the rail past its end. It folds as usual.
    - **Keys and reset.** Arrow keys step 16 px, Shift 64; Home and End go to the least and greatest size; Enter or a double-click puts one size back; the panels menu's *Reset panel sizes* puts them all back. A hairline shows on hover and turns orange with a size badge while dragged or focused.
  - **Each run.** Every run starts from the At launch layout in Settings › Panels (`app/panels/launch.js`, stored in localStorage). By default Summary and Galaxies are hidden, Tasks and Ideas folded, and the rest open. The menu, the chevrons and the keys change only the run in progress. The first run with launch layouts carries over the panels folded before.
- **Keyboard shortcuts** (`shortcuts.js`, a UMD table the Node tests share, run by `app/keys.js`). Settings › Shortcuts lists them and turns single keys on or off (`agent-universe.single-keys.v1`, on by default).
  - **Go to and views.** `/` or Ctrl K opens the Go to palette (or returns to its field); Backspace goes back one level; N opens the first agent that needs you; Ctrl , opens Settings and ? opens it on Shortcuts. On macOS ⌘ stands in for Ctrl.
  - **Timeline.** Space plays or pauses history; L returns to live.
  - **Panels.** `[` and `]` fold or open the left and the right rail, `\` every panel, and Shift E expands the event feed or puts it back. A panel's `letter` in `panel-layout.js` hides or shows it: F Fleet, G Galaxies, E Event feed, I Ideas, S Summary, P Project, T Tasks. In a view without that panel, a toast says where it shows.
  - **When a key is not a shortcut.** Single keys wait while a text field has focus, while Settings is open, with Alt held, and while they are off; Space on a focused button presses the button. Ctrl shortcuts always work, except behind the Go to palette: while it is open only `/` and Ctrl K act, putting the caret back in its field. Escape closes the panels menu, then Settings, then the expanded feed, then the toast, unless the Go to palette, the agent view or the directory took it first (the palette closes and nothing else does), or a text field with text has focus. While Settings is open, or agent focus has made the top bar inert, `/` and Ctrl K leave the palette shut.
  - **Hints.** The panels menu and the At launch rows show each panel's key, the menu's actions theirs, the hiding toast says which key shows the panel again, the view hint ends with `? shortcuts`, and the search button, the panels button and the feed's expand button give theirs in their titles and `aria-keyshortcuts` (the title names the first key that works, `aria-keyshortcuts` every one: the search button says `/` and Ctrl K, or Ctrl K alone). Single-key hints go while single keys are off.
- **Back control** (system + planet views, top-left under the project card or
  above it): `← Universe` / `← Orion System` style button.
- **History bar** (all views, fixed bottom): Play/Pause, `1x`/`10x`/`100x`/
  `1000x`, historical clock, scrubber, and exact `LIVE`. Existing sidebar,
  summaries, and planet tabs remain above it at 1200×720. The bar of a window 1280 px wide or
  less at 100% text, or as narrow in layout px at a larger text size (a container query on its own
  width), closes up: less room between its parts, narrower buttons, no `PROJECT STARTS` caption. Seeking atomically
  reseeds the store; returning LIVE installs a fresh tracker snapshot.
- Status dot colors: Building `#4da3ff`, Exploring `#a78bfa`,
  Gathering Resources `#ffb454`, Scanning `#34d399`, Delegating `#f472b6`,
  Planning `#facc15`, Working `#94a3b8`.
- Provider colors (`AUR.PROVIDERS`): Claude terracotta `#d97757`, Codex pearl
  `#f2f0ea`, generic Signal `#94a3b8`; a `local` ship of either provider is red
  `#ff3344` (`AUR.LOCAL_MODEL`). `AUR.shipColor(ship)` and `AUR.shipTint(id,
  provider)` both resolve local, so hulls, agent rows and focus mode agree. The
  chrome says it too: a fleet row ends with the ship's `model` (`.agent-model-tag`,
  "Local · <model>" in `--local` red when local), the focus telemetry appends it to
  the provider, and the universe legend lists "Local model".
  Missing provider values in legacy fixtures normalize to Claude; raw/unknown
  values normalize to Signal.
- Fleet hulls (`assets/ships/fleet-v3`) carry authored hull maps the app keeps
  as baked (`hull_white`, `hull_grey`, `hull_dark`). The ship color is the
  hull's trim lighting: `accent_livery` (stripes, chevrons, collars) and
  `engine_glow` emit it over a dark surface (Claude terracotta, Codex pearl, a
  local model red; linearized for the PBR slot, at 1.5x so a line outshines the
  lit hull) and the system view's glow pass blooms them. The root's unlit
  evidence material carries the exact hex. `window_light` is a cool lit pane
  and `canopy_glass` keeps its authored smoke with stronger reflections
  (`materialRole` in `ship-assets-hulls.js`). Every fleet material gets a
  procedural studio environment for reflections; the system and planet views
  add a viewer-relative key and rim that only ship meshes see
  (`AUR.shipLights`).
- Main Claude/Codex ships fly the `aur-fleet-v3` rank ladder in
  `assets/ships/manifest.json`: the hull is the highest rank whose `minBuilds`
  the ship's `builds` has reached (Scout 0, Workhorse 5, Capital 20, Flagship
  60); display length grows 1.9× over the ladder. A drone flies the first rank
  at `AUR.DRONE_SCALE` of its size. Each hull is one file: the universe map
  instances it from a per-provider template, the system and planet views clone
  it (so focus mode can fade ships one by one); a view steps down to the dart at
  400k hull triangles per scene. Ship size is one policy (`AUR.SHIP_SIZE` per
  view, `AUR.fitShip` with a pixel floor so a hull sized to its planets still
  reads from the default orbit). `AUR.ships.refresh(scene, ship)` swaps the hull
  inside the asset root the scene already holds; `app/boot.js` calls it after
  `ship-updated` and `build` events, and it waits while focus mode has the ship
  faded.

## 5. Universe view (`3.universe-map-view.png`)

- Backdrop: `assets/skyboxes/skybox-001.png` (2048×1024 equirectangular) via
  `BABYLON.PhotoDome` (size 1600), universe-only texture level `0.028`, plus a
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
  arms (by member count) twisting out from a core, sized as if its systems sat a step
  apart along them. The systems scatter through that disc instead of lining the arms:
  core to rim loosely by recency (the most recently active lean toward the core, with
  neighbours in the ranking mixing freely), each at the first of its own seeded spots
  that clears the systems placed before it (a roomy spacing first, then a minimum,
  else the clearest spot), and lifted within the
  disc's thickness (a bulge at the core, thicker in wider galaxies). A lone system sits
  at the centre. The same layout for the same activity history; a project drifts
  inward when it is worked on. The largest galaxy anchors the
  cluster and each other one touches a placed galaxy at the free slot nearest the
  cluster's centre, with a positive gap; every galaxy is lifted and tilted on its own
  pivot, which everything of its rides: the glyphs (and so their ships, pulses and
  labels) and the body.
- **Galaxy body**: a spiral galaxy, after the Sidereal observatory. `galaxy-field.js`
  computes an emission/dust atlas over the disc (cloudy logarithmic arms from the
  galaxy's spiral phase, a warm core, star-forming knots, dust lanes inside the arms,
  the arms leaning toward the galaxy's colour) and draws the resolved stars from it; the
  systems scatter through the disc on their own, so the light winds as a galaxy's does
  while neighbouring systems stay a spacing apart. The renderer gives each galaxy a
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
- While the Go to palette has a query (or the directory has one, or the GitHub
  filter is on), matching system glyphs and labels brighten through those same
  state materials and nonmatches dim, in view behind the palette's light
  backdrop; closing the palette, clearing or leaving the universe restores the
  ordinary online/idle/derelict appearance. Behind the backdrop a label still
  keeps clear of the chrome, as it does with the palette shut, and of the
  palette's own box: a hit test skips the page a modal dialog makes inert, so
  `scene/universe/labels.js` tests the boxes of the elements that take the pointer (measured
  when the dialog opens or closes or the window changes size, and again every 300 ms it stays open).
- Ships: every live ship = its hull (a dart until it loads) cruising outside
  its project's glyph rings (slow orbit, gentle bob), instanced per provider.
  Drones smaller. On `ship-spawned`: warp-in grow; `ship-departed`: removed.
- Events: `build`/`activity` → that system's sun does a quick pulse.
  `project-added` → glyph grows in from zero.
- Interaction: hover glyph → highlight + pointer cursor; click → zoom/fade
  transition into system view.
- Summary card: `UNIVERSE SUMMARY` — Systems / Agents / Online
  (online = distinct projects with ≥1 ship). The view title's line reads
  `<n> solar systems · <m> online`.

## 6. Solar system view (`2.solar-system-view.png`)

Data: `AU.getSystem(projectId)`, through `AUR.fetchSystem` (`util.js`): `null` when main has no
such system, its answer has no `planets` list, or the call throws, which it logs. For `null` the
route logs that and shows the universe instead (`app/route.js`).

- Backdrop: `AUR.addSky` (`scene/sky.js`), a cube baked offline by `scripts/bake-sky.js` from the
  author's Sidereal Deep Field shader (region The Veil): nebula gas, dust and stars in one
  `assets/skies/<look>/<size>/` set of six WebP faces, in the Settings look at the graphics tier's
  face size (`RENDER_QUALITIES[].sky`: 1024 · 1536 · 2048). A new look or size loads beside the
  one shown and replaces it once ready, one load at a time: a change asked for mid-load starts
  when that load ends. The stars are baked in, so the view adds no runtime
  starfield, unless no faces load at all; then `AUR.addStarfield` stands in.
- Orbit rings: one `AUR.orbitRing` per planet, all under one node that is disabled while
  Settings has them off.
- Central sun: the emissive `StandardMaterial` sphere `sunMat`, with the
  photosphere from `worlds/sun.js` injected by a material plugin: granulation
  (fading in as the sun grows past 60 px on screen; none on the low tier),
  sunspot belts, faculae, limb darkening and reddening, and a soft ACES clip
  that keeps the star's colour (30 % of the way to a hue-preserving clip, so pale
  suns keep their tint). It is tinted by `sunMat.emissiveColor`, which the subtle
  pulse drives. In the glow layer the sun is dark: the view's
  `customEmissiveColorSelector` gives it the neutral colour, so it adds no glow
  but hides the glow of ships behind it. A corona and a wider glow billboard
  (additive, sorted by distance with the planets' shells) surround it.
- Planets: one per `planets[]` entry, on concentric orbit rings
  (LinesMesh circles, like the mockup's grid rings). Orbit radius by index
  (e.g. `10 + i*6`); diameter `1.1 + sqrt(files + builds*5) * 0.18` clamped
  [1.1, 4.5]. Surface: a generated world (`worlds/material.js`) whose class,
  seed, palette and hue come from `AUR.worldProfile` (the class by
  `1 + fnv1a(project.id + ':' + name) % 31`, the index that once picked a PNG).
  Its equirectangular maps come from the `worlds/` workers: a placeholder at
  once, then 256 (low) or 512 wide, the three biggest planets first. Lit from
  the sun; rings on about half the gas giants; no cloud shell here. The hovered
  planet's detail map is prefetched for the planet view. Slow orbital motion, varied speeds
  (0.02–0.08 rad/s, deterministic per planet). Planet label (name) appears on
  hover; keep labels for 2–3 largest planets always on, like the mockup.
- Asteroid belt: ring of instanced small rocks (one low-poly mesh +
  `thinInstance` transforms), count `min(beltDensity*4, 300)`, placed in an
  annulus between two middle orbits, slow rotation.
- Ships (only ships where `ship.project === projectId`): the hull of §4 (a dart
  until it loads) + name label (GUI, always visible, like `Claude-1` callouts in
  the mockup) + an exhaust plume from each stern nozzle (the `exhaust` part
  reads them off the hull's `engine_glow` islands; a dart trails from its
  tail). Modes: `patrol` outside the last orbit and the
  belt; on `build` → `flyto` (`AUR.MOTION.flyToSeconds`, arcing over the belt
  and the largest planet) to a standoff beside the `bucket` planet → `hold`
  (~2.4s, a thin emissive beam, planet pulses 1 → 1.15 → 1) → `return` to the
  ring (`AUR.MOTION.returnSeconds`). The `bucket` planet is the one whose `key` the build
  carries (`AUR.planetOfBuild`; the view keeps its planets by name). On `build` with
  `isNew: true` and no such planet: re-fetch `AU.getSystem` (the view's `systemData` follows),
  one request at a time and once more for a planet that started while one was out, grow the new
  planet in from zero, feed shows planet formation. An answer is drawn only while the app still
  shows the view in the stream it was asked in (`ctx.shown`). A fetch that fails is not tried
  again, unless a planet started while it was out, which is a new reason to ask once more. Until
  an answer is drawn or the view is built again the view stays behind: its system is not handed
  to a planet, which fetches its own. A planet that cannot be built, when
  the view opens or later, leaves no ring, globe, shell, material or label behind and gives its
  maps back to the map service (a world's own `dispose()`, `worlds/material.js`, which never
  disposes the blank texture its scene shares); it is logged once and does not stop the others,
  and the next re-fetch builds it again. A folder is one planet whatever its casing:
  one renamed in case only keeps the globe it has, under the name it was drawn with, until the
  view is built again; a key gets a second globe only when the answer lists it twice.
  On `activity`: brief thruster flash.
- Project card (top-left, panel): `PROJECT: <NAME>`; rows: `STATE` (any ship
  Building → `Building` in accent blue; else the busiest ship status; no ships →
  `Dormant`), `BUILDS <totalBuilds>`, `LAST SIGNAL <relative time>`; plus an
  `Open Folder` button → `AU.openProject(id)` and a LIVE-only `Open Terminal`
  button → `AU.openTerminal(id)` (both hidden when `exists` is false). History
  replay keeps the terminal action visible but disabled. The renderer supplies
  only the project ID, or the exact ship ID from the agent-focus overlay; main
  resolves and revalidates the live working directory and session. A project with
  one live agent focuses that session, several agents require selecting a ship,
  and a dormant project opens a new shell. Unavailable session terminals report
  failure without opening a substitute shell. Drones use their known parent.
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
  project (the picker's lines are `A.projectSubtitles`: name, then galaxy, repository,
  branch and path; projects that share a name lead with the end of the path that tells
  them apart), which idempotently adds an internally tagged `GOALS.md` item and
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

Data: `AU.getPlanet(projectId, name)`, and the project's system alongside it for the planet
card's solar-system totals: the system view hands over its own when the planet is clicked there
(`ctx.openPlanet(projectId, name, system)`), and any other way in fetches it
(`AUR.fetchSystem`, which the system view's refetch uses too: `AU.getSystem`, or `null`). The system view hands over none while its own is
behind a planet that has just started. The app holds it in `S.planetSystem`; when there is
none, those rows show `—`; a `build` with `isNew: true` in the open planet's project fetches it
again, one request at a time (`A.refreshPlanetSystem`), and one that arrives while the planet
is still opening does so as soon as it has opened (`A.requestPlanetSystem`,
`A.planetSystemOpened`). An answer is drawn only if no route was asked for and no stream adopted
since it was asked for (`S.routeRequestGeneration` counts both, so a seek into history never
shows the live system on the planet it reopens) and the card still shows that project. A fetch
that fails follows the system view's rule: not tried again, unless a planet started while it was
out. The view and the route take the planet's name from the answer
(`PlanetData.name`), not from the name asked for.

- Large generated world (same class rule) filling ~60% of view height, slow
  rotation about a tilted axis, the atmosphere shell, clouds on oceanic worlds on
  the high tier, rings on ringed giants. Its detail map (1024 or 2048 wide by
  tier) lands after the view opens; the scene stays unready until it is bound or
  6 s pass. 1–2 small rocky moons with their own maps. The system view's baked sky (`AUR.addSky`)
  as backdrop.
- This project's ships orbit the planet with name labels.
- Left panels (stacked):
  1. `PROJECT: <NAME>` mini-card (state + builds and the same folder/terminal
     actions as in system view).
  2. `PLANET: <NAME uppercased>` card, in plain words — status dot `Active` (ships present) or
     `Dormant`; a line saying what the globe is drawn as (its class from `AUR.worldProfile`:
     Rocky world, Gas giant, Ice world, Volcanic world, Oceanic world) and what the planet stands
     for (`a folder in <project>`, `the top-level files of <project>` for `(root)`, or, when
     `procedural`, `no folder on disk` for a project without one and `no builds here yet` for a
     stand-in of a project whose folder is there); rows `FILES`, `SIZE` (KB, MB or GB),
     `SUBFOLDERS`, `FILE TYPES` (top extensions, `MISC` shown as `other`), each `—` where main read
     no folder (`A.planetFolderCounts`), and the line says why from the planet's own data: the
     `procedural` lines above (its numbers invented), `· no longer on disk` (`folderRead: 'gone'`:
     a build bucket outlives its folder), `· could not be read` (`folderRead: 'none'`: there, and
     locked or failing just now), or `· history keeps no file counts` (`folderRead` absent: REPLAY
     never reads the disk); `FILES` and `SIZE` end in `+` when the read stopped short
     (`folderRead: 'partial'`: past 600 files, 300 folders or five levels, where a folder left
     unread counts only if it or a folder below it holds a file, at most 100 of them looked into;
     or a folder below the planet's, or a file's size, that could not be read), and a floor is
     rounded down (`0 KB+`, never `< 1 KB+`); then `BUILDS (FILE EDITS)`:
     `THIS PLANET`, `WHOLE SOLAR SYSTEM` (the project's `totalBuilds`) and a bar of the planet's
     share, a whole percent that is never `0%` of a planet with builds (`< 1%`) nor `100%` of one
     without them all (`> 99%`); then `SOLAR SYSTEM`: `PLANETS` (the planets the system view
     draws, `8 of <planetTotal>` when the project has more, from `S.planetSystem`) and `AGENTS`. A
     `build` event with the open planet's `key` raises its count in place.
- No tab bar: the mockup's `Overview … Scans` row was dropped because its tabs did nothing.
- Summary card: `PLANET SUMMARY` — Agents / Files / Subfolders / Builds.
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
real project/history controls at 1200×720, proves LIVE-only behavior, exact session
targeting and safe Windows Terminal fallback arguments, and writes two screenshots plus a bounded
`result.json`. It never reads the real profile or opens a real terminal.

## 9. Performance guardrails

- Target 60fps idle on integrated graphics: ≤3000 starfield points (the universe map; the
  system and planet views draw one baked sky cube instead, about 34, 75 or 134 MB of GPU memory
  with mipmaps at 1024, 1536 or 2048, and two of them while a new look or size replaces the
  one shown), belt via
  thin instances only, one GlowLayer per scene max, no per-frame allocations in
  observables (reuse Vector3s), dispose scenes fully on view switch
  (`scene.dispose()` and drop references).
- Graphics tiers trade frame rate for detail: each sets the share of the display's
  pixels the engine renders (`setHardwareScalingLevel`), the galaxy volume's raymarch
  steps (a `STEPS` define), the share of resolved stars and the face size of the system and
  planet views' sky. GUI labels keep their size and
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

- `assets/planets/planet-001.png` … `planet-031.png` and `planet-031-bump.png` —
  the authored planet library. It no longer feeds the renderer: since kit 15
  every planet and moon is generated by `src/renderer/worlds/` (equirectangular
  surface, emission, cloud and ring maps for the rocky, gas, ice, volcanic and
  oceanic classes, in a 160 MB LRU that outlives scenes), and no renderer source
  names `assets/planets`.
- `assets/asteroids/asteroid-001.png` … `asteroid-003.png` with matching
  grayscale `-bump.png` source heights and Babylon-ready `-normal.png` maps —
  dedicated 512×512 cratered rock surfaces for the three deformed asteroid
  archetypes. Babylon materials consume the RGB normal maps, not raw grayscale.
- `assets/skyboxes/skybox-001.png` … `skybox-012.png` — 2048×1024 true
  equirectangular, for PhotoDome. Only skybox-001 is drawn, by the universe map.
- `assets/skies/<look>/<size>/<face>.webp` — the system and planet views' sky: six cube faces
  (px py pz nx ny nz) per look (vivid · soft · distant · faint) and tier size
  (1024 · 1536 · 2048), WebP at quality 0.95, baked by `npx electron scripts/bake-sky.js`.
  `assets/skies/manifest.json` records the bake settings and every face's bytes and SHA-256;
  `test/scene-sky.test.js` holds the folder to it and to a 20 MB budget.
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

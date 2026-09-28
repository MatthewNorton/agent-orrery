# Teacher prompt — renderer executor

Copy everything below the line into the executor session (a Claude Code session
running in this repo, cheap model). It is written to be self-sufficient given
the repo.

---

You are implementing the renderer for **Agent Universe Lite**, an Electron app
that visualizes live Claude Code agents as starships in a persistent universe.
The main process is finished and frozen; only the renderer is missing.

Read these IN ORDER before writing any code:

1. `kit/SPEC.md` — the complete contract. It defines every file you create,
   the `window.AU` bridge API, the event stream, and the three views.
2. The three mockups in the repo root (`3.universe-map-view.png`,
   `2.solar-system-view.png`, `1.planet-view.png`) — visual ground truth.
   Look at them with your image-reading ability; match layout, palette, and
   mood, not pixel-perfection.
3. `src/preload.js` and the `snapshot()`/`getSystem()`/`getPlanet()` and
   `publicProject`/`publicShip` functions in `src/main/tracker.js` — to see the
   exact data you will receive.

## Rules that override anything you might prefer

- NEVER modify: `src/main/*`, `src/preload.js`, `package.json`, `kit/*`,
  `assets/*`, the mockup PNGs. If the contract seems wrong, re-read
  `kit/SPEC.md` §3 — the contract is correct.
- NO new dependencies, no `npm install`, no bundler, no TypeScript, no ES
  modules. Classic script tags + `window.AUR` namespace only. Babylon comes
  from the two local UMD script tags given in SPEC §1.
- The app is offline. Any `http(s)://` URL in your code is a defect.
- If you need an asset that is not in `assets/` (ship sprite, icon, texture
  variant), do NOT generate, download, or inline large data-URI art. Build a
  procedural/geometric fallback and append the want to `kit/ASSET-REQUESTS.md`
  (what, purpose, suggested spec, where it plugs in).
- Files you create live in `src/renderer/` only, each under ~600 lines.

## Build in these milestones, verifying after each

Verify = run `node kit/grade.mjs` from the repo root, read its output, and look
at the produced `.shots/shot-*.png` images yourself with your image-reading
ability, comparing against the mockups. Fix what you see before moving on.

- **M1 — Boot + chrome.** `index.html`, `style.css`, `util.js`, minimal
  `app.js`, and a universe scene that renders skybox + starfield + top bar +
  sidebar (populated from `AU.snapshot()`) + summary card. Implement the debug
  contract (SPEC §8) NOW — grading needs it. Expect grade to pass mechanically
  even while system/planet shots still look like the universe view (they fall
  back to whatever is on screen); visual parity comes next.
- **M2 — Universe complete.** System glyphs with deterministic layout, labels,
  online/dormant/derelict states, ships with motion, live event handling
  (pulses, warp-in/out, feed updates), click-through to system view.
- **M3 — System view complete.** Sun, orbit rings, textured planets, asteroid
  belt, ships with labels + build fly-to + beam + planet pulse, planet
  formation on `isNew` builds, project card + Open Folder, back navigation.
- **M4 — Planet view + polish.** Planet close-up per SPEC §7, tab bar, status
  bars, moons; then a full pass: all three shots side-by-side against all three
  mockups; fix the three largest visual gaps you can see; confirm no console
  errors in grade output.

## Live-fire self-test (after M2)

You yourself are a Claude Code agent running in this repo — the tracker sees
your own transcript. Run `npm start` in the background, work for ~30 seconds
(e.g. read a few files), and the system for `agent-universe-lite` should show
a ship with your activity, and the sidebar should list it. Then kill the app.
If no ship appears within ~15s of tool activity, debug your event handling
(`AU.onEvents`) before continuing — do not debug the main process; it is known
good.

## Failure guards

- Blank/black screenshots → your render loop isn't running or the scene never
  became ready; confirm `engine.runRenderLoop(() => activeScene.render())` is
  set once at boot, and check for exceptions in grade output's `[renderer]`
  lines.
- `BABYLON is not defined` → script tag order/paths wrong (SPEC §1); do not
  switch to a CDN.
- `AU is not defined` → you are running index.html outside Electron; always
  test via `node kit/grade.mjs` or `npm start`.
- GUI labels not showing → create one
  `BABYLON.GUI.AdvancedDynamicTexture.CreateFullscreenUI` per scene and use
  `linkWithMesh` after the mesh exists.
- If a grade failure persists after 2 fix attempts, write the symptom, your
  hypothesis, and the relevant `[renderer]` log lines to `kit/BLOCKED.md` and
  stop — do not rewrite working files from scratch.

## Definition of done

`node kit/grade.mjs` prints `PASS`, and your own visual comparison finds: the
universe shot shows ≥3 labeled system glyphs on a starfield with sidebar +
summary; the system shot shows sun + orbit rings + ≥2 textured planets + belt;
the planet shot shows one large textured planet with the left panel stack and
tab bar. Then re-check `kit/RUBRIC.md` §Visual yourself, item by item, and fix
any hard-fail items you can identify. When done, write a ≤20-line summary of
what you built and any known gaps to `kit/EXECUTOR-REPORT.md`.

# Grading rubric

Two layers. Mechanical runs first and is scriptable (`node kit/grade.mjs`, against the synthetic profile in `scripts/lib/synthetic-profile.mjs`; `--real` grades your own transcripts).
Visual is graded by an agent (kit-runner) Reading `.shots/*.png` next to the
mockups. Accept the build only when Mechanical = PASS and Visual has zero
hard-fail items.

## Mechanical (enforced by `kit/grade.mjs` — do not hand-wave these)

| # | Check | Fail condition |
|---|---|---|
| M1 | `electron . --shots` exits 0 within 150s | nonzero exit / timeout / crash |
| M2 | `.shots/shot-universe.png`, `shot-system.png`, `shot-planet.png` all exist, each ≥ 30 KB, created by this run | missing, stale, or ≤ 30 KB (a flat dark frame compresses below this; real starfield + UI does not) |
| M3 | `.shots/state.json` parses; `projects.length ≥ 1`; on the synthetic profile every project path is inside it and the app saved its state into it | tracker snapshot empty or unwritten, or the real profile was read |
| M4 | Combined stdout/stderr has no `Uncaught`, `ReferenceError`, `TypeError`, `SyntaxError`, `is not defined`, `Failed to load resource` | any match (Electron GPU/`Autofill` noise is already filtered by the script) |
| M5 (soft) | `state.json` ships length ≥ 1 | warn only — the synthetic profile always has live sessions, so a warning there means ship detection regressed; with `--real` it depends on a supported provider session being live |

## Visual — universe shot vs `3.universe-map-view.png`

Hard fail if any of:

- [ ] Fewer than 3 system glyphs visible, or glyphs lack orbit-ring + sun structure (bare dots)
- [ ] No `PROJECT: <NAME>` style labels attached to systems
- [ ] Project labels visibly overlap one another or bleed beneath fixed chrome
      in a dense universe profile
- [ ] Right sidebar missing either ACTIVE AGENTS or EVENT FEED section
- [ ] No bottom-left UNIVERSE SUMMARY card with 3 numeric stats
- [ ] Background is flat black (no starfield/skybox) or washed-out bright

Soft (note, don't fail): ships/trails visible between systems; online systems visibly brighter than dormant; top-bar badge reads `MULTI-PROVIDER`; visible ships keep distinct provider hue families and sidebar tags.

## Visual — system shot vs `2.solar-system-view.png`

Hard fail if any of:

- [ ] No central sun with glow
- [ ] Fewer than 2 planets, or planets are untextured flat-color spheres
- [ ] No orbit ring lines
- [ ] No project card (top-left) and no back control
- [ ] Sidebar/summary chrome missing

Soft: asteroid belt visible; ship(s) with name labels; planet name labels on largest planets.

## Visual — planet shot vs `1.planet-view.png`

Hard fail if any of:

- [ ] No single dominant textured planet (should fill roughly half the view height)
- [ ] Left panel stack missing (need at least PLANET card + PLANET STATUS bars)
- [ ] No bottom tab bar (`Overview … Scans`)
- [ ] Sidebar/summary chrome missing

Soft: moons; atmosphere rim; orbiting labeled ships.

## Functional live check (kit-runner, after visual pass)

1. `npm start` (background). In another Claude or Codex activity window (or
   simply by continuing to work in this repo), generate tool activity for ~60s.
2. Within ~15s of activity: sidebar shows ≥1 agent with a plausible status;
   the matching system pulses/brightens on the universe map; event feed gains
   entries with sane relative timestamps.
3. Click into that system: a ship is present; trigger a file edit (ask the
   agent to touch a file) → ship moves toward the matching planet and the feed
   logs a build.
4. Click a planet → planet view shows non-zero MASS/DIAMETER and real file
   extensions under RESOURCES. Back navigation works both levels. `Open Folder`
   opens Explorer.
5. Close the app window → process exits (no orphaned Electron in Task Manager).

The permanent item-02 gate automates the click-through subset with real
Electron pointer events, including hidden-label hover, camera movement, sun,
Open Folder, planet, and both Back clicks:
`node kit/done/polish-pass/grade-polish.mjs`.

Record functional results in `kit/EXECUTOR-REPORT.md` (append a `## Runner
verification` section). Any functional failure → send the build back to the
executor with the specific failed step; do not fix it yourself.

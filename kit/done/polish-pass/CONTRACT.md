# Contract — renderer polish pass

Close every soft gap recorded in `kit/done/renderer-mvp/EXECUTOR-REPORT.md`
without changing the product model or adding dependencies.

## Editable scope

- `src/main/main.js` — test-only pointer harness and safe Open Folder recorder
- `src/renderer/index.html`
- `src/renderer/util.js`
- `src/renderer/polish-math.js` (new, pure browser/Node helper)
- `src/renderer/scene-universe.js`
- `src/renderer/scene-system.js`
- `kit/todo/02-polish-pass/**`
- status/docs files under `kit/`

Everything else is frozen. In particular: no changes to `package.json`,
`src/main/tracker.js`, `src/preload.js`, assets, or the MVP grader.

## P1 — dense universe labels

With the grader's deterministic 30-project profile:

- render all 30 pickable sun glyphs and create all 30 `PROJECT:` labels; a
  glyph-count cap is not a declutter solution;
- select labels deterministically in screen space, prioritizing hovered,
  question/permission, online, then recent projects;
- clip labels away from DOM chrome and reject rectangles whose 6 px padded
  bounds overlap an accepted label;
- show 3–12 labels at the default camera, hide at least one idle label, and
  report zero overlaps;
- moving a real Electron pointer over a previously hidden glyph reveals its
  label, while a subsequent zoom/rotate layout still reports zero overlaps;
- recompute only when camera/viewport, hover, project, or ship state changes.

## P2 — near-black universe backdrop

Keep `skybox-001.png` and the procedural starfield. On the clean central
canvas ROI, the rendered universe frame must have Rec.709 luma:

- median <= 24
- p90 <= 48
- p99 >= 18 and standard deviation >= 3 (reject flat-black cheats)

The foreground glyphs and stars must remain visible.

## P3 — system sun color isolation

The immutable base sun color, mutable material color, and corona color must be
distinct objects. Across at least 240 successive timestamps, every material
RGB value must equal `base * (1 + 0.06 * sin(t * 1.5))` within 1e-6 and the
base must remain unchanged.

## P4 — real pointer click-through

`electron . --polish-test --polish-output=<dir>` must load the real app against
a deterministic 30-project Claude transcript profile and use
`webContents.sendInput` for every interaction. Direct calls to renderer
navigation functions or `element.click()` do not count.

Required sequence:

1. universe (`ucam`)
2. pointer-hover a hidden project label, validate `scene.pick`, click its sun
3. system (`scam`), click **Open Folder** and record the exact project id
   without launching Explorer
4. validate `scene.pick`, click a planet
5. planet (`pcam`)
6. pointer-click Back to the same system
7. pointer-click Back to universe

Each transition is bounded to 10 seconds. Assert matching DOM chrome, one live
scene after each transition, no renderer error tokens, and emit JSON plus fresh
screenshots for every view/return step.

## Gates

From the repository root, both commands must pass:

```powershell
node kit/done/polish-pass/grade-polish.mjs
node kit/grade.mjs
```

Archive this kit under `kit/done/polish-pass/` with its report, validation log,
JSON metrics, and screenshots after both gates and visual review pass.

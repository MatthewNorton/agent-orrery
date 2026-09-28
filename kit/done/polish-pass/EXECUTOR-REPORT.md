# Executor Report

## Delivered

- `src/renderer/polish-math.js`: added pure deterministic label selection,
  padded rectangle collision checks, and exact non-accumulating sun pulse math.
- `src/renderer/scene-universe.js`: renders all project glyphs and labels,
  prioritizes hovered/attention/online/recent labels, clips around chrome,
  recomputes only when dirty, dims the universe sky, and exposes independent
  live layout metrics.
- `src/renderer/scene-system.js`: clones the material and corona colors away
  from the immutable base and reports the live isolation invariant.
- `src/renderer/index.html`: loads the new pure helper before scene modules.
- `src/main/main.js`: added the test-only isolated-profile flow using actual
  `webContents.sendInputEvent` pointer input. It validates unfiltered scene
  picks and records Open Folder without launching Explorer.
- `kit/SPEC.md` and `kit/RUBRIC.md`: made the shipped label, backdrop,
  performance, and pointer-flow behavior part of the live contract.

## Mechanical and rendered verification

The final isolated 30-project run created 30 glyphs, 30 labels, 30 pickable
suns, 30 GUI label controls, and 30 finite projections. Four labels were
visible and 26 decluttered at the default camera. Estimated and measured label
overlaps were zero before hover, after hover, and after camera movement; fixed
chrome occlusions were also zero in all three states. A previously hidden
project label was revealed, reacquired after camera movement, and clicked.

Backdrop luma was median 23.2, p90 40.9, p99 157.3, and standard deviation
22.3. Live system metrics confirmed distinct material/corona color objects and
an unchanged base color. The input trace contains 23 low-level events with
ordered move/down/up proof for the sun, Open Folder, planet, and both Back
clicks. The exact project id matched Open Folder, the view sequence was
universe → system → planet → system → universe, and renderer errors were empty.

## Regression and visual review

`node kit/grade.mjs` passed M1–M4; M5 emitted only its expected soft warning
because no Claude session was live. All seven archived screenshots were
inspected for label clarity, chrome clearance, a dark but non-flat backdrop,
foreground glow, correct system/planet chrome, and both returned views.

## Scope and deviations

No dependencies, assets, tracker behavior, preload API, or normal launch path
changed. Only contract-unfrozen product/test files and live kit documentation
were modified. Normal launch and `--shots` behavior remain unchanged. There
were no hard-contract deviations or known failures.

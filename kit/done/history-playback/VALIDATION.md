# Validation log — Item 06

Date: 2026-07-21 (America/New_York)

## Frozen inputs

```text
CONTRACT.md       F9954C116DC856E26900F11DD853E9B34C343B0EE2F32DF0CD5518D3B57186C9
RUNNER.md         0744609204C43F24ACA60379C37849037FCEF6C4292C872EE1FFA3FA4EE96ED8
grade-history.mjs 970E0CC315C35D03027E249B2344D5864299CF74C971F413010ABF6A210B294F
```

The distilled baseline failed cleanly with `H0: missing
src/main/replay-source.js` before Electron launched. `node kit/grade.mjs`
passed before product edits. The three hashes above remained unchanged through
implementation.

## Final commands

| Command | Result |
|---|---|
| `node kit/todo/06-history-playback/grade-history.mjs` | PASS H1–H5 |
| `node kit/done/multi-provider/grade-providers.mjs` | PASS V1–V5 |
| `node kit/done/attention/grade-attention.mjs --fixtures-only` | PASS 15/15 |
| `node kit/done/galaxy-grouping/grade-galaxies.mjs` | PASS G1–G4 |
| `node kit/done/polish-pass/grade-polish.mjs` | PASS P1–P4; 3/30 labels, median luma 22.2, p90 42.4 |
| `node kit/grade.mjs` | PASS; universe/system/planet captured |

## Rendered proof

`output/result.json` comes from actual renderer store, DOM, scene, and control
state at the minimum 1200×720 window. It records:

- actual scrub/speed/play/pause/LIVE input in the required order;
- exact `REPLAY`, `LIVE`, and `1000x` control labels;
- renderer-verified backward reset and historical build advance;
- a stable paused cursor and no live-only event in the replay epoch;
- fresh LIVE reseeding with the event appended while replay was visible;
- integer epochs `1 < 3 < 4`, no renderer errors, and no history-bar overlap;
- explicit planet view/tabbar coverage with the bar inside the viewport.

Visual inspection of all four output PNGs found a readable unclipped timeline,
intact galaxies, Claude/Codex colors and tags, visible before/after system
growth, fresh LIVE feed activity, and a planet tabbar above the history bar.

## Count-only actual-profile proof

`output/real-profile-summary.json` records only counts and timings: 417 indexed
sources in 538 ms, a 1 ms seek to the earliest cursor, one replay project/ship,
and the continuously running live Tracker returning to the same 46 projects
and two ships. It contains no paths, provider/session IDs, or transcript text.

## Independent review fixes

Three read-only reviews drove final fixes for epoch-gated progress, transition
event queuing, stale route requests, renderer-derived proof metrics, project
chronology, hard source/batch caps, newest-source selection, resumable parsing,
duplicate builds, null-prototype buckets, exact departure timestamps, backlog
clocking, discovery cancellation/yields, and stale-seek publication.

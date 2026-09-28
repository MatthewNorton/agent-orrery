# Executor report — history playback

Status: **PASS** on 2026-07-21.

## What shipped

- Added `src/main/replay-source.js`, an independent, read-only Claude/Codex
  historical source. Bounded head/tail indexing selects the newest 50,000
  effective sources, active rollouts win archive duplicates, captured byte
  lengths make a replay immutable, and resumable per-source cursors parse only
  through the requested historical time.
- Reconstructed the existing project, ship, activity, build, feed, and
  departure vocabulary with deterministic ordering, canonical cwd merging,
  Claude/Codex provider identity, actual subagents, exact virtual lifecycle
  deadlines, successful in-project builds, and null historical attention.
- Added a main-process active-source controller. The live Tracker continues in
  the background, while snapshots/events route through integer stream epochs;
  every seek and LIVE transition is an atomic snapshot boundary.
- Extended the context-isolated bridge with compact replay commands, bounded
  replay status, and epoch metadata without changing ordinary event objects.
- Added a permanent history bar to every view with Play/Pause, exact
  `1x`/`10x`/`100x`/`1000x` speeds, historical clock, scrubber, and exact
  `LIVE`. Replay timestamps use the virtual cursor and old prompts never raise
  desktop notifications.
- Preserved the current universe/system/planet route across valid snapshot
  boundaries, rejected stale asynchronous route responses, queued transition
  events without loss, and bounded retired epoch state.
- Added `--history-test`, an isolated 1200×720 Electron proof that drives the
  actual controls, seeks backward, plays across builds, pauses stably, verifies
  the planet tabbar, appends a live-only event during replay, and returns LIVE.
- Added `docs/HISTORY-PLAYBACK.md` and updated the live app/bridge spec.

No live Tracker/provider adapter, scene, package manifest, dependency, asset,
mockup, or archived grader was changed.

## Privacy, determinism, and performance checks

- Prompt, message, reasoning, command, argument, result, stdout/stderr, and
  patch-body content never enters replay output. Transcript files remained
  byte-, size-, and mtime-identical in the frozen fixture.
- Generic Signal logs are excluded because their privacy boundary forbids
  content reads and file-stat history does not exist.
- Partial/oversized records, outside-cwd paths, failed/duplicate patches, and
  active/archive duplicates do not create public state or duplicate builds.
- Direct and segmented playback produce identical event/departure times;
  backlog slows virtual time instead of skipping history; stale seeks cannot
  publish into a replacement cursor.
- On the count-only real profile, 417 sources indexed in 538 ms and a seek to
  the minimum took 1 ms. The continuously running live Tracker showed 46
  projects and two ships before and after replay. No paths, IDs, transcript
  content, or record text were retained.

## Runner verification

All required gates passed from the repository root:

```text
node kit/todo/06-history-playback/grade-history.mjs
PASS H1-H5 history playback checks green

node kit/done/multi-provider/grade-providers.mjs
PASS V1-V5 passive multi-provider checks green

node kit/done/attention/grade-attention.mjs --fixtures-only
PASS all mechanical checks green (15/15 fixtures)

node kit/done/galaxy-grouping/grade-galaxies.mjs
PASS G1-G4 galaxy grouping checks green

node kit/done/polish-pass/grade-polish.mjs
PASS P1-P4 polish checks green

node kit/grade.mjs
PASS all mechanical checks green
```

The final isolated proof records actual DOM input for scrub, speed, play,
pause, and LIVE; epochs `1 → 3 → 4`; backward reset; renderer-delivered build
growth; pause stability; stream isolation; background live catch-up; and zero
chrome overlap. All four fresh screenshots exceed 580 KiB and contain no
renderer errors.

## Known limits

- The history index is captured at app start. Records appended later remain in
  the uninterrupted live Tracker and join history after a new index/app start.
- Generic Signal watches remain live-only by design.
- History is memory-only: there is intentionally no calendar/search UI, clip
  export, database, or saved playback position.

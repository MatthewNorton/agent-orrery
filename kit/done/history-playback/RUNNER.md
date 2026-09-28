# Runner — history playback

1. Confirm `node kit/grade.mjs` passes before implementation.
2. Run `node grade-history.mjs`; the distilled baseline must fail cleanly on
   missing `src/main/replay-source.js` before Electron launches.
3. Freeze `CONTRACT.md`, this runner, and `grade-history.mjs`. Implement only
   the editable scope; do not modify the live Tracker, provider adapter, any
   scene, package manifests, or archived gate.
4. Pass the isolated replay fixtures first. Check backward seek/reset,
   active/archive deduplication, event ordering, and the privacy sentinel
   before wiring IPC or renderer controls.
5. Wire active-source routing and stream epochs, then implement the timeline
   without adding replay branches to scene code.
6. Pass the item gate and every regression command in the contract.
7. Inspect the fresh 1200x720 screenshots. Confirm timeline controls do not
   overlap the summary, sidebar, or planet tabs; replay builds form planets;
   and LIVE restores events appended while replay was visible.
8. Exercise one actual-profile index/replay/return-live cycle. Record only
   bounded counts and timings, never transcript paths or content.
9. Write `EXECUTOR-REPORT.md`, retain proof artifacts, move this directory
   unchanged to `kit/done/history-playback/`, remove the numbered stub, and
   update status boards and the live spec.

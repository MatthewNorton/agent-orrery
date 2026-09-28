# Contract — history playback

Add a bounded historical mode that reconstructs the universe from native
Claude and Codex transcripts, lets the user seek and play through that record,
and returns to the uninterrupted live tracker with one click. Historical
records must enter the renderer through the existing project, ship, activity,
build, and feed event vocabulary; this item adds no replay-specific scene.

## Minimum complete scope

- Index and replay Claude JSONL files under `~/.claude/projects/*/*.jsonl`.
- Index and replay Codex rollout JSONL files under both
  `~/.codex/sessions/**/*.jsonl` and `~/.codex/archived_sessions/*.jsonl`.
- Add one bottom timeline with seek, play/pause, `1x`, `10x`, `100x`, and
  `1000x` speeds, a historical clock, and an exact `LIVE` button.
- Keep the ordinary Tracker running while replay is visible. Returning to LIVE
  installs a fresh live snapshot, including records appended during replay.
- Generic Signal watches are not replayed: their privacy contract forbids
  reading content and file stat history does not exist.
- Do not add session search, calendars, saved clips, exported recordings,
  provider process control, a database, or a fourth scene.

## Editable scope

- `src/main/replay-source.js` (new, independent source)
- `src/main/main.js`
- `src/preload.js`
- `src/renderer/index.html`
- `src/renderer/style.css`
- `src/renderer/util.js` — only an optional virtual-clock argument for relative
  time formatting
- `src/renderer/app.js`
- `docs/HISTORY-PLAYBACK.md` (new)
- `kit/todo/06-history-playback/**`
- status and live-spec documentation under `kit/`

`CONTRACT.md`, `RUNNER.md`, and `grade-history.mjs` are runner-owned and frozen
after distillation review. Everything else is frozen, especially
`src/main/tracker.js`, `src/main/provider-adapters.js`, all three scene files,
the galaxy/polish helpers, package manifests, dependencies, assets, mockups,
and every archived/current grader. Replay may import existing exports, but it
must not refactor or alter live tracking behavior.

## H1 — independent replay source

`src/main/replay-source.js` is dependency-free outside Node and the existing
local modules. It exports `ReplaySource`, an `EventEmitter` with this contract:

```js
new ReplaySource({
  claudeProjectsDir?,
  codexSessionDirs?,
  now?
})

await source.index()
source.status()
await source.seek(timestamp)
await source.advanceTo(timestamp, { emit? })
source.play()
source.pause()
source.setSpeed(1 | 10 | 100 | 1000)
source.snapshot()
source.getSystem(projectId)
source.getPlanet(projectId, planetName)
source.stop()
```

`index`, `seek`, and `advanceTo` may be asynchronous. `seek` returns the
resulting snapshot. `advanceTo` is the deterministic primitive used by the
wall-clock player and isolated tests. The source emits ordinary `events`
batches and bounded `state` updates. `stop` is idempotent and cancels timers,
indexing, reads, and stale seeks.

`status()` returns only bounded metadata:

```js
{
  mode: 'replay',
  available: Boolean,
  indexing: Boolean,
  minTs: Number | null,
  maxTs: Number | null,
  cursorTs: Number | null,
  playing: Boolean,
  speed: 1 | 10 | 100 | 1000,
  sourceCount: Number,
  truncated: Boolean
}
```

`snapshot()` keeps the existing `{ projects, ships, feed, eventSequence }`
shape. Projects retain every current public field, including `galaxy`; ships
retain every current field, including `provider`. Historical attention and
`attentionSince` are always `null`: replay is observational and must never
page the user for an old prompt.

## H2 — bounded, deterministic index

Discovery never follows symbolic links. Claude discovery is direct beneath
each project directory; Codex discovery is recursive. Duplicate active and
archived Codex files with the same session ID represent one source, preferring
the active root. Snapshot each selected file's byte length during indexing;
later appends are outside that replay until a new index is built.

The first pass obtains provider, session, cwd, kind, and first/last timestamp
from bounded head/tail reads; it does not parse whole transcripts. Use these
hard limits:

- at most 256 KiB from the head and 256 KiB from the tail of each candidate;
- at most 50,000 effective sources, retaining the newest deterministically and
  setting `truncated: true` when capped;
- valid event times are finite dates from 2000-01-01 through 24 hours after
  the index's captured current time;
- yield to the event loop after at most 128 candidates or 16 MiB of index I/O.

One unreadable, moved, malformed, empty, or timestamp-free file produces at
most one bounded warning and cannot stop other sources. No absolute transcript
path or transcript-derived text enters status, events, output artifacts, or
renderer state.

Claude is registered first so its directory slug remains the project ID for a
shared cwd. Codex-only projects use the existing canonical-path/FNV convention.
Canonical cwd merging, ship IDs, providers, and display-name prefixes match
the live Tracker. Ordering is byte-stable across runs: effective timestamp,
provider priority, canonical source identity, byte offset, then signal order.
Within one append-only file preserve byte order; clamp a regressing effective
timestamp to the previous effective timestamp.

## H3 — seek and forward playback semantics

The indexed range is `[minTs, maxTs]`. Seeking clamps to that range, pauses,
cancels any older seek, creates a fresh isolated reducer, and consumes records
through the target without emitting catch-up batches. A seek before the first
event yields an empty historical universe. Backward seeking must remove every
future ship, pending call, build, feed item, and project that did not yet exist.

Forward `advanceTo` and timed playback consume records lazily and emit only the
existing event types:

- `project-added` / `project-updated`
- `ship-spawned` / `ship-updated` / `ship-departed`
- `activity`
- `build`
- `feed`

Every event retains the existing payload shape and receives a monotonically
increasing `seq`. Event and feed timestamps are historical source time, never
wall-clock replay time. Feed text is generated only from safe provider names,
project names, statuses, and project-relative build paths.

Reconstruct Claude main sessions, `Agent`/`Task` drones, tool status, matching
tool results, turn completion, and edit/write builds. Reconstruct Codex main
and actual subagent rollouts with the existing provider adapter; never create
a synthetic Codex drone from a spawn tool. Successful builds inside cwd update
the correct root/top-directory bucket and emit one build event per unique
file. Failed patches, outside-cwd paths, duplicate completion records, prompt
text, reasoning, arguments, results, stdout/stderr, and message bodies do not
affect public state.

Use virtual time for the existing five-minute main and fifteen-minute drone
departure windows. Pause freezes cursor and historical state, though ambient
Babylon camera/orbit animation may continue. At `maxTs`, pause in replay and
never enter live mode automatically. Playback accepts only the four specified
speeds. Backlog slows virtual time rather than skipping records.

Resource limits while reading are one retained partial line per source capped
at 1 MiB, at most 8 MiB per processing slice, at most 256 public events per
batch, and replay-state notifications at most ten times per second. A partial
last line waits for no future append because indexed size is immutable; it is
ignored. Malformed and oversized records are skipped and parsing resumes at
the next newline.

Replay state is memory-only. Never read or write `universe-state.json`; never
open transcripts for write, modify metadata, truncate, rename, delete, lock,
or acknowledge them. Add no process spawn, provider SDK, or network request.

## H4 — active-source controller and stream epochs

The ordinary Tracker starts and continues scanning, polling, expiring ships,
and persisting while replay is displayed. Main owns the visible source and
routes these existing IPC requests to it:

- `au:snapshot`
- `au:system`
- `au:planet`

The folder-open action may use the visible source's project path but retains
all current existence checks. Enter/seek and LIVE are atomic snapshot
boundaries. Main increments an integer `streamEpoch` for every seek and every
live/replay transition. The visible snapshot gains additive
`{ streamEpoch, playback }` metadata.

Keep ordinary event objects unchanged. Extend the existing bridge callback to:

```js
AU.onEvents((batch, meta) => {})
// meta = { streamEpoch, mode: 'live' | 'replay' }
```

Renderer reconciliation uses `(streamEpoch, seq)`, not `seq` alone. While a
mode-changing invoke is pending, queue incoming batches; after installing the
returned snapshot, apply only matching-epoch events newer than its cursor.
Late live events can never enter replay, and events produced while the LIVE
snapshot is being installed cannot be lost.

Add one compact command bridge and progress subscription:

```js
AU.replay({ action: 'index' })
AU.replay({ action: 'seek', ts })
AU.replay({ action: 'play' })
AU.replay({ action: 'pause' })
AU.replay({ action: 'speed', speed })
AU.replay({ action: 'live' })
AU.onReplayState(callback)
```

Reject malformed commands, non-finite timestamps, and unsupported speeds
without changing mode. Index/control commands return bounded playback status;
seek and live return the new snapshot plus status. Progress messages carry the
epoch and bounded status only.

## H5 — timeline and real rendered behavior

Add one bottom history bar visible in universe, system, and planet views. It
contains these stable controls:

- `#history-play` — accessible Play/Pause button;
- `#history-speed` — cycles `1x`, `10x`, `100x`, `1000x`;
- `#history-scrubber` — range input, preview on `input`, one seek on `change`;
- `#history-time` — historical cursor label;
- `#history-live` — exact visible text `LIVE`.

The bar exposes `data-mode="live|replay"` and `data-playing`. While indexing or
when no valid range exists, seek/play are disabled and live visualization is
unchanged. In replay, the EVENT FEED header reads exact `REPLAY`; after return
it reads exact `LIVE`. `AUR.relTime(ts, baseTs)` remains backward compatible
when `baseTs` is omitted and uses the replay cursor when provided.

Installing a historical snapshot clears/reseeds the renderer store,
notification throttles, epoch/sequence cursor, and chrome, then rebuilds the
current route once if its project still exists; otherwise it returns to the
universe. Desktop notifications are suppressed outside live mode. Incremental
replay events use the current scene's existing `update(batch)` path, including
ship flight and system planet formation.

At the minimum 1200x720 window, raise the sidebar, summary, and planet tabs
above the history bar. The bar and all existing chrome must have zero measured
rectangle overlap and no clipped controls.

The isolated `--history-test --history-output=<dir>` mode owns temporary
Claude/Codex/live fixtures and never reads the real profile. Through actual DOM
control events it must enter replay via scrub, select 1000x, play across a ship
and build, pause with a stable cursor, and click LIVE. Append a live-only record
while replay is visible and prove it appears after LIVE, demonstrating that
the background tracker never stopped. Save metrics plus fresh replay universe,
system-before-build, system-after-build, and live-return screenshots.

## Gates

From the repository root all commands must pass:

```powershell
node kit/todo/06-history-playback/grade-history.mjs
node kit/done/multi-provider/grade-providers.mjs
node kit/done/attention/grade-attention.mjs --fixtures-only
node kit/done/galaxy-grouping/grade-galaxies.mjs
node kit/done/polish-pass/grade-polish.mjs
node kit/grade.mjs
```

Visually inspect all four history screenshots for a readable unobstructed
timeline, correct LIVE/REPLAY state, provider-colored ships, intact galaxies,
and visible system growth. Archive this unchanged kit with its report,
validation log, metrics, and screenshots only after every gate passes.

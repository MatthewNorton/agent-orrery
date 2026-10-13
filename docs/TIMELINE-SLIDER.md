# Timeline slider performance and UX

## Diagnostic report

No external crash log was supplied, so the diagnosis is based on the shipped
drag, IPC, and replay code plus the isolated Electron harness. The native
range control itself is not the component throwing. Its `change` event invokes
a historical seek, and that seek was a cold reconstruction: every source was
read from byte zero through the selected time, all parsed records were retained
in one `additions` array, the whole prefix was sorted, and only then was it
reduced. The first review reproduced the crash with 50,000 dense records:
`_records.push(...additions)` exceeded V8's argument limit and threw
`RangeError: Maximum call stack size exceeded`. Smaller histories still caused
a large heap peak and blocked Electron's main process while parsing and sorting,
so the application appeared frozen during a drag release.

The renderer amplified the stall. Every `input` sample called `renderHistory`,
which rewrote mode attributes, button states, range bounds, progress, labels,
and accessibility text. It also constructed two `Intl.DateTimeFormat` objects
per sample. Because the range used 13-digit epoch milliseconds with a
one-second step, Chromium also had to operate over an unnecessarily large
numeric domain. Finally, every completed seek reseeded the store and rebuilt
the active Babylon scene. That reset is required for deterministic backward
history, but it should happen once after a committed seek, never as preview
work.

The implemented fix separates cheap preview from expensive commit. The browser
range is normalized to `0..10000`; input samples only store the mapped timestamp
and one animation-frame callback updates the clock/progress. A `change` still
issues exactly one seek, preserving existing semantics. Cached formatters avoid
allocation churn. Forward replay seeks reuse current parser cursors and reducer
state. Cold and backward seeks now use a deterministic min-heap containing only
the next record from each source. Each record is reduced immediately, stream
buffers are capped to 64 open sources and released after the operation, and no
variadic append is used. A forward scrub also cancels scheduled or in-flight
playback before reusing mutable source cursors. No transcript, project data, or
existing control was removed.

## Prioritized improvements

1. **Bound cold-seek memory (implemented).** Merge one pending record per
   source and reduce it immediately instead of retaining the selected prefix.
2. **Coalesce drag preview work (implemented).** Use one `requestAnimationFrame`
   update for all pointer samples received in that frame; seek only on commit.
3. **Reuse forward replay state (implemented).** `advanceTo` avoids rereading
   transcript prefixes when the user moves forward from an existing replay.
4. **Normalize the native range (implemented).** Map a compact slider position
   to epoch time, avoiding a trillion-scale range without losing visible
   precision.
5. **Avoid repeated allocations and DOM writes (implemented).** Cache date
   formatters and keep preview updates limited to the clock and progress style.
6. **Bounded in-memory checkpoints (implemented).** `history/checkpoints.js`
   keeps up to 32 reducer checkpoints, spaced by indexed bytes, so a seek
   replays only from the nearest one. They live in memory only (64 MB budget),
   so there is no data migration or new persistence/privacy surface.

## Representative implementation

```js
// Many input samples -> at most one visual update per display frame.
scrubber.addEventListener('input', () => {
  pendingTs = timestampFromPosition(scrubber.value);
  frame ??= requestAnimationFrame(flushPreview);
});

// One expensive transition after the user's drag is committed.
scrubber.addEventListener('change', () => {
  flushPreview();
  replay({ action: 'seek', ts: previewTs });
});
```

```js
// Cold seek: keep one next record per source in a bounded merge heap.
for (const source of sourcesThrough(target)) {
  heap.push(await readNext(source, target));
}
while (heap.length) {
  const record = heap.popMin();
  reduce(record);
  heap.push(await readNext(record.source, target));
}
```

## UI mock-up

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ [Play] [10x]  LIVE TIMELINE       NEW SYSTEM · payments-api          [LIVE]│
│               LIVE          ●──────────●───────────────◉                    │
│                         Aug 4, 8:40 PM  PROJECT STARTS  LATEST              │
└─────────────────────────────────────────────────────────────────────────────┘
                            historical project       pulsing new project
```

The readout explicitly says `LIVE TIMELINE` or `HISTORY TIMELINE`. Both ends of
the range are labeled. Project creation times appear as dots; a project
discovered after startup adds a green pulsing dot and an accessible
`NEW SYSTEM · name` announcement. Replay mode retains the same controls and
uses the final indexed timestamp instead of `LATEST`.

## Testing plan

- Automated unit: cold-seek through 50,000 dense records (the original overflow
  case), verify exact build totals, a one-record heap for one source, released
  stream buffers, preserved `firstSeen`, forward cursor reuse, and deterministic
  backward reconstruction.
- Automated rendered drag: dispatch 96 range-input samples in frame-sized
  groups, verify 24 preview frames, exactly one seek, a responsive handler,
  correct backward reset, and no renderer errors.
- Automated live UX: discover a second project after boot; verify the live
  timeline, endpoint labels, project markers, green new marker, and announcement.
- Regression: run all Node tests and the Electron replay flow for play/pause,
  a forward seek while playback is active, every speed, scene navigation,
  stream isolation, and return to live data.
- Manual: drag rapidly in both directions on a large real profile while
  observing responsiveness and process memory; inspect the universe, system,
  and planet layouts at 1200×720 and the normal application size; verify
  keyboard arrows, focus outline, screen-reader value text, reduced motion,
  and that no project/transcript data changes on disk.

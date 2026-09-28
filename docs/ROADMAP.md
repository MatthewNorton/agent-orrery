# Roadmap — prioritized suggestions

Captured 2026-07-20 from a review of the passing MVP. Ordered by value per
unit of effort. The guiding test for every item: **does it move the app from
"beautiful fish tank" to "monitor I keep open"?** The only axis on which this
app beats a one-line statusline is ambient glanceability — every hour invested
should serve that.

## 1. Needs-attention detection — IN PROGRESS (assigned to Codex)

The single highest-value change. A ship blocked on a permission prompt or a
question should flash; a ship that finished its turn should show "task
complete". Turns the visualizer into something you park on a second display:
glance up, see a flashing ship, go answer it.

Fully specced: `kit/ADDENDUM-ATTENTION.md` (contract + executor prompt in §8).
Kill-switch: `node kit/grade-attention.mjs`. Do not re-derive — the detection
signals were verified against live transcripts (pending `tool_use` = blocked;
`type:'system', subtype:'turn_duration'` line = turn complete).

## 2. Cinematic warp transitions (the "Elite Dangerous" feel)

Replace the hard cuts between universe → system → planet with camera
choreography: accelerate toward the clicked glyph with starfield streaks,
brief warp effect, decelerate into the system scene; swoop down until a planet
fills the frame, hand off to the planet scene. What makes Elite feel good is
the sense of scale during transitions, not the flight model — and that is all
camera animation, which Babylon does natively (animatable camera paths, motion
blur, radial-streak post effects). Est. 200–400 lines, renderer-only, no
tracker changes. Also the biggest win for demo/video footage.

See `docs/DESIGN-DIRECTION.md` for why this and explicitly **not** free
flight.

## 3. Light "orbit mode" in the system view

A passive camera that follows a ship along its patrol path or slow-drifts
around a planet. No input scheme, no state — works as a screensaver and as
b-roll. Cheap once #2's camera plumbing exists.

## 4. Launcher actions (viewer → tool)

The first narrow action shipped on 2026-07-21: `Open Terminal` opens Windows
Terminal at a trusted LIVE project directory without starting or owning an
agent. A macOS Terminal.app counterpart landed in 2026-09 (see
`docs/MACOS-LAUNCH.md`). Potential follow-ups remain separate decisions:

- resume the session: `claude --resume <sessionId>` (session id is the
  transcript basename, already tracked)
- open the transcript file

Clicking a stalled ship and landing directly in the conversation that needs
you closes the attention loop completely. Needs small main-process additions
(new IPC + preload methods), i.e. a deliberate unfreeze — spec it as a kit
addendum like the attention work.

## 5. Universe archaeology (mostly free — just leave it running)

Persisted state already accumulates build counts per planet; over weeks the
universe becomes a map of where effort goes. Cheap additions that compound
this: dim/fade systems untouched for N days ("derelict drift"), sort/label by
`lastActivity`, a "most built this week" stat on the summary card.

## 6. Small fixes (batch into whatever touches the renderer next)

- **Label crowding**: with 25+ real projects the universe labels overlap in
  dense clusters. Fade labels below a zoom threshold or declutter by
  priority (online > recent > dormant).
- **Filter/search box**: 27 systems is already past comfortable visual
  scanning. A single text filter that dims non-matching systems is enough.
- **`Color3` aliasing in `scene-system.js`**: same bug class that blacked out
  the universe suns (shared object mutated by `scaleInPlace` per frame) exists
  there, currently masked because the scale factor stays ≈1. Fix is one
  `.clone()`. Documented in `kit/EXECUTOR-REPORT.md`.

## 7. Content use (zero work, available today)

The universe flythrough with real live agent data is genuinely recordable
demo material. Screen-record it while running a real multi-agent workflow.
Value goes up again after #2.

## Anti-goals — do not invest here

- **More visual fidelity for its own sake** (more scene types, planet
  variety, richer surfaces). The rendering already passes its rubric; polish
  is where the original 172k-LOC repo went to die.
- **Free flight / merged continuous world** — see `docs/DESIGN-DIRECTION.md`.
- **Open-ended agent steering from the UI** — the global IDEAS queue can start
  Codex for one exact, user-assigned tagged goal, but arbitrary prompts,
  mid-session steering, process controls, and provider orchestration remain
  outside the product. Passive observation is still the default identity.

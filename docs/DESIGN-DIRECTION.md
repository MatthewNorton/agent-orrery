# Design direction — keep the universe, fake the flight

Decision record, 2026-07-20.

## The question

Stick with the universe metaphor, or pivot to something plainer and more
maintainable? The pull toward "fly to the planets, almost like Elite
Dangerous" made this worth deciding explicitly.

## The decision

**Keep the universe. Get the Elite feel from cinematic camera transitions.
Never build free flight.**

There are two very different readings of "fly to the planets":

### Version A — cinematic flight (chosen)

Keep the three discrete scenes; replace hard cuts with camera *transitions*:

- Universe → system: camera accelerates toward the clicked glyph, starfield
  streaks / brief warp effect, decelerates into the system scene.
- System → planet: camera swoops until the planet resolves from a dot to a
  horizon, then hands off to the planet scene.
- Back navigation: the same in reverse, faster.

Agent focus follows the same boundary. Its first-person cockpit is a camera
rig locked to the selected agent's live transform: users can observe its
patrol or approach from inside the ship, but cannot steer it. The mode adds
embodiment without adding flight controls, collision, or a continuous world.

What makes Elite feel good is not the flight model — it is the **sense of
scale during transitions**: the sun growing on approach, a planet filling the
canopy. That is camera choreography, and Babylon is good at it (animatable
camera paths, motion blur, radial-streak post-process). Roughly 200–400 lines,
renderer-only, slots into the existing architecture untouched.

### Version B — actual free flight (rejected)

A controllable ship (6DOF input), one seamless continuous world instead of
three scenes, LOD management at every distance, collision, a HUD. That is not
a dashboard with a flight mode; it is a space game with a dashboard attached —
exactly the scope class that took the original repo to ~172k LOC before it
was abandoned. It also *hurts* the tool: a monitor you have to pilot is worse
than a monitor you glance at.

## Why the current shape IS the maintainable option

The maintainability question and the metaphor question are independent. The
constraints that keep this codebase small are architectural, not thematic:

- a small main process with explicit trust boundaries: transcript discovery is
  passive, while the task workflow alone may launch verified Codex for one
  user-assigned tagged goal
- three isolated scene files behind one small view contract
- kit-based renderer rebuilds (`kit/SPEC.md` is the contract; the renderer is
  cheap to regenerate against it)
- hard asset/dependency freeze (no new deps, procedural fallbacks only)

Cinematic transitions respect all four. Free flight breaks the scene
isolation (forces one merged world) — which is the actual maintainability
cliff, regardless of theme.

## Standing rule

If a genuine free-flight itch persists after warp transitions and orbit mode
exist, it becomes a **separate toy project in its own repo** — not a feature
of this one. This project's identity is: small, passive by default, narrowly
actionable, tail-the-transcripts, glanceable.

## Update, 2026-10-14: the Tricolor chrome

The universe metaphor stands. The HUD around it was redesigned as "Tricolor": a quiet
dark palette with one orange accent, Archivo and IBM Plex Mono shipped locally, numbered
modules in two rails, and every colour and size held in `design/tricolor/tokens.json`
(renderer CSS is generated from it, so the scheme can change in one place). The source,
boards and rationale live in `design/tricolor/README.md`; planet close-ups keep their
realistic materials on purpose.

# UX improvement backlog

Captured from the July 2026 UX review. The goal is to evolve Agent Orrery
from a beautiful passive visualization into a command deck that remains
glanceable, useful, and small enough to maintain.

## Completed from this review

### Collapsible command rail

The Active Agents and Event Feed rail can collapse to a compact, icon-only
strip. Each section can also collapse independently, empty sections minimize
themselves, counts remain visible in compact mode, and the user's layout is
remembered between launches.

### First-person agent focus

Selecting an active agent enters an immersive cockpit view driven by that
ship's live system-scene transform. The focused hull becomes the viewpoint,
unrelated traffic dims, and a restrained HUD shows provider, status, project,
and flight target alongside bounded folder and terminal actions. Escape exits
the cockpit and restores the previous command-deck focus.

## Future improvements

### 2. Status-driven universe map

Add aggregate badges to galaxies and systems, such as "3 active", "1 needs
you", and "5 dormant". Pair them with restrained status halos and filters for
Needs You, Active, Done, and Dormant so the universe is readable without
hunting through labels.

### 3. Rebalance scene contrast

Reduce skybox exposure and saturation in the system and planet views, add a
subtle vignette behind the focal area, soften orbit lines, and reserve the
brightest glow for selected or urgent objects. The scene should remain rich
without competing with labels and controls.

### 4. Clear interaction grammar

Use hover to preview, single-click to select, and double-click or Enter to
travel inward. Show a compact inspector for the selected project or planet so
exploration feels deliberate and accidental navigation is less likely.

### 5. Cinematic transitions and breadcrumbs

Implement the planned universe-to-system warp and system-to-planet swoop.
Keep orientation predictable with a breadcrumb such as
`Universe / agent-orrery / kit` and provide a Reset Camera action.
Cinematic camera choreography should remain the boundary; free flight stays
out of scope.

### 6. Literal developer data inside the visual metaphor

Present fields such as Files, Size, Languages, Builds, and Last Activity
directly. Keep planets, ships, resources, and structures as the visual
metaphor, but avoid mappings such as "Mass: 56 files" that require users to
translate the interface before understanding it.

### 7. Event-aware history

Add timeline markers for agent starts, questions, permissions, completions,
and project changes. Hovering a marker should preview the event and selecting
it should jump directly to that moment. Collapse the full history bar into a
small LIVE strip when no history is available.

### 8. Universal command palette

Expand navigation into a `Ctrl+K` command palette spanning projects, agents,
planets, events, and actions. Support arrow keys, Enter to focus, Escape to
move outward, and Space to pause or resume history playback.

### 9. Actionable summaries

Prioritize signals such as "1 agent needs you", "most active project", "last
completed task", and recent activity trends. Keep raw counts as supporting
information, but make the primary summary answer: what changed, and what
should I do?

## Guardrails

- Preserve the three isolated scene architecture.
- Prefer renderer-only improvements unless a workflow genuinely needs a new
  trusted main-process capability.
- Keep reduced-motion behavior for every new animation.
- Favor glanceability and navigation over additional decorative fidelity.
- Do not add free flight or open-ended agent steering. Keep actions bounded to
  explicit, user-assigned tasks and preserve passive observation by default.

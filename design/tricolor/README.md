# Tricolor

The chosen visual direction for Agent Orrery (design pass 7, 2026-10-14): armour plates bolted over a full-screen universe. Dark only for now. Plates are slate charcoal, text is warm off-white, the primary action is an off-white armour plate; orange is the one accent (the catalogue tag, focus, a permission), red means a question, green means live or done. Bold is kept for the headline and module titles; everything else is 400–600 and sentence case. Nothing is set under 12px.

This folder is the source of truth for the look. The mockups on the design canvas are generated from it; the renderer implementation will take its tokens from it.

## Layout

- `tokens.json` — colour (light and dark), type, spacing, size, radius, shadow, duration and easing tokens, each with a usage note. The format is the one the design-system artifact type reads, so it can be published as a system unchanged.
- `components.css` — the components, written only in `var(--…)` and the type classes. Includes the responsive tiers (container queries on `.screen`): two rails from 1200px, one rail below, a scrolling sheet under the universe below 700px.
- `build.cjs` — writes `boards/tri.css` from the two files above. Fails if any type style is under 12px.
- `boards/` — one generator per screen (`universe.cjs`, `system.cjs`) and the shared chrome (`lib.cjs`). Each writes `.dc.html` boards (the design-canvas format; they also open directly in a browser). `img/` holds the textures the boards use: planet and sky images derived from `assets/planets` and `assets/skyboxes`, ship decals from the fleet QA renders.
- `fonts/` — Archivo and IBM Plex Mono, see `FONTS.md`.
- `render.cjs` — screenshots a board headless to `renders/` at any window size.

## Build

```
node design/tricolor/build.cjs
node design/tricolor/boards/universe.cjs
node design/tricolor/boards/system.cjs
node design/tricolor/render.cjs TriUniverse
node design/tricolor/render.cjs TriPhone 390x844
```

Environment variables let the same generators write the canvas copies: `TRI_OUT` (board directory), `TRI_IMG` (image base), `TRI_CSS` (stylesheet href), `TRI_FONTS` and `TRI_CSS_OUT` for `build.cjs`.

## Boards

| Board | What it shows |
|---|---|
| `TriUniverse` | The universe, 1440 × 900 |
| `TriWindow` | The same screen in a 1024 × 768 window: one rail, most urgent first |
| `TriPhone` | 390 × 844: the universe on top, the modules as a sheet below |
| `TriSystem` | One project as a solar system: folders as planets, the agents working in it |

## Rules the renderer inherits

- Scene colours stay: `claude` and `codex` equal `AUR.PROVIDERS`; the scene's `AUR.ATTENTION` hexes stay. The chrome's `red`, `orange` and `green` are separate tokens.
- The headline is Archivo 700 at 48px (36px at phone width, and for project names over twelve characters).
- Capitals are set by CSS on `mod-title`, `sub`, `brand` and `map-galaxy` only; source text is sentence case.
- Only real data fields. No invented metrics.

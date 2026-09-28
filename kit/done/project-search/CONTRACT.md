# Kit 11 — project search on the star map (contract)

A search field in the top bar, universe view only, to find any project among
the galaxies instantly: type → matching systems highlight and a result list
drops down → Enter/click → jump to that system. Complements the RECENT pills.

Gate: `node kit/todo/11-project-search/grade-search.mjs`
(FAILs cleanly until implemented; `--fixtures-only` skips the Electron
regression).

## 1. Matching core — `src/renderer/search-core.js` (pure, dual-environment)

A classic script that attaches `AUR.searchProjects` AND is requirable from
Node for the grader (end with the guard
`if (typeof module !== 'undefined') module.exports = { searchProjects };`).

`searchProjects(projects, query) -> results` where projects is an array of
`{ id, name, path, galaxy? }`:
- Empty/whitespace query, or non-string → `[]`.
- Case-insensitive substring match on `name`; if no name hit, substring on
  `path`.
- Ranking: name-prefix matches first (alphabetical within rank), then other
  name matches, then path-only matches. Cap at **8** results.
- Pure: no DOM, no globals beyond the exports, no Date/random.

## 2. UI (renderer, universe view only)

- Top bar, right of the RECENT strip: input styled like the pill family
  (`SEARCH` glass field, placeholder `Search projects…`, ~200px, focus ring in
  `--accent`). Hidden outside the universe view.
- On input (debounced ~120 ms): dropdown panel under the field (same `.panel`
  chrome) listing results — project name, muted galaxy/path second line, green
  dot when the project has live ships. Keyboard: ↑/↓ move selection, Enter
  opens the selected (or first) result, Esc clears + closes. Click = open.
- While the query is non-empty, matching system glyphs brighten and
  non-matching dim (reuse the existing online/dim material paths — do NOT
  invent a new highlight system); clearing restores normal state.
- Opening a result = the existing guarded `openSystem` navigation; the search
  field clears on navigate.
- No results → single muted row `No systems found`.
- Update `kit/SPEC.md` §4/§5 with a short block documenting the field.

## Acceptance

| # | Check |
|---|---|
| P1 | `search-core.js` exists and exports `searchProjects` via the Node guard (clean FAIL "not implemented" until then) |
| P2 | Fixture table passes (empty query, case-insensitive name, prefix-first ranking, path fallback, cap 8, non-string safety) |
| P3 | index.html loads `search-core.js` before `app.js`; renderer wires an input + dropdown (grep-level check) |
| P4 | Regression: `node kit/grade.mjs` PASSes |

Runner live check: type a fragment of a real project name → dropdown shows it
ranked sensibly; Enter lands in that system; Esc clears; dimming restores.
Done → `kit/EXECUTOR-REPORT.md`; stuck → `kit/BLOCKED.md` and stop.

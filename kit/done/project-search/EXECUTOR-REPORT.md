# Executor report — project search

Status: **PASS** on 2026-07-22.

## Delivered

- Added a dependency-free dual-environment `searchProjects` core with safe
  query normalization, case-insensitive name/path matching, deterministic
  prefix/name/path ranking, alphabetical tie-breaking, and an eight-result
  cap. It exports to both `AUR.searchProjects` and CommonJS without mutating
  its inputs.
- Added the universe-only SEARCH field after RECENT with the exact placeholder,
  a debounced combobox/listbox, ranked result rows, galaxy/path details, live
  ship dots, selected-row styling, and the exact no-results state.
- Added complete keyboard and pointer behavior: arrows wrap the selected row,
  Enter flushes a pending debounce and uses the existing guarded system route,
  Esc clears immediately, and click opens the chosen result.
- Added lifecycle-safe cleanup on navigation and live refreshes for changed
  project names/paths or ship dots. Search stays hidden outside universe view.
- Integrated match emphasis into the existing universe glyph state path:
  matching suns/rings brighten and nonmatches dim through their existing
  materials; labels reuse the current priority pass; clear/leave restores the
  online, idle, and derelict factors exactly.
- Updated the short shared-chrome and universe-view search blocks in
  `kit/SPEC.md`.

No main-process, preload, package, dependency, asset, mockup, task-panel,
navigation, grader, or new-material/highlight-system change was made.

## Frozen kit

- `CONTRACT.md`: `4e298a16c468fb3c4da02a217b71ef4e9b3da118e2bf6a261bebee5fb72dd61b`
- `grade-search.mjs`: `25d850726a07d172f60bc660a9ee1a2e730d7b5dc3b7ac08864df4dfb5520457`

The distilled baseline failed cleanly at P1 because
`src/renderer/search-core.js` did not exist. The permanent renderer gate was
green before implementation.

## Verification

- `node kit/todo/11-project-search/grade-search.mjs --fixtures-only` — PASS
  P1-P3.
- `node kit/todo/11-project-search/grade-search.mjs` — PASS P1-P4, including
  fresh universe, system, and planet captures from the permanent regression.
- Additional core checks — PASS for deterministic within-rank ordering,
  malformed projects/queries, path-only fallback, stable original references,
  and input non-mutation.
- Syntax checks and `git diff --check` — PASS.

## Live and visual check

A real Electron renderer at 1200x720 was driven through the visible field:

1. `agent-universe-lite` ranked the real project first and showed its green
   live-ship dot plus galaxy/path detail.
2. The active universe scene reported one matched glyph at factor `1.45` and
   45 nonmatching glyphs at factor `0.18` through the existing material path.
3. Esc emptied the field, closed the dropdown, and restored all glyph and
   label factors to `1`.
4. A nonsense query showed the exact `No systems found` row.
5. Typing the real project and pressing Enter before the debounce elapsed
   still opened its system, cleared the field, and hid search outside universe.

The final minimum-size visual check confirmed the logo, badge, RECENT strip,
SEARCH label/field, and dropdown remain on one line and inside the viewport.
Measured top-bar groups were non-overlapping, and the dropdown began below the
field. Temporary screenshots were removed after inspection.

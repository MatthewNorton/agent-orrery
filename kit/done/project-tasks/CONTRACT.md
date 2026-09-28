# Kit 10 — per-project task lists (contract)

A simple checklist per project, visible in the system view. The storage design
IS the feature: tasks live in a **`GOALS.md`** markdown checklist at the
project root — so any agent session working in that project (Claude, Codex)
naturally sees and can address them ("work through GOALS.md"), and edits made
by agents show up in the app. No database, no sync protocol.

Gate: `node kit/todo/10-project-tasks/grade-tasks.mjs`
(FAILs cleanly until implemented; `--fixtures-only` skips the Electron
regression).

## Scope guard

Simple to start, per matt: display, add, check/uncheck. NO priorities, NO due
dates, NO drag-ordering, NO assigning tasks to agents from the UI, NO
automatic agent launching. The existing LIVE-only terminal action is the only
bridge to "go address these" (a session opened there reads GOALS.md itself).

## 1. File format (the contract with agents)

`GOALS.md` in the project root. Task lines are GitHub-style checkboxes:
`- [ ] text` (open) / `- [x] text` (done; accept uppercase `X`; accept `*` as
the bullet; accept leading indentation). Every other line is free prose and
must survive round-trips byte-identical. If the file doesn't exist, creating
the first task writes:

```markdown
# Goals

- [ ] first task
```

## 2. Main process — new module `src/main/goals.js` (pure core + IO)

Pure functions (exported for the grader, NO fs in them):
- `parseGoals(text) -> { items: [{ text, done, line }] }` — `line` is the
  0-based line number in the source text; tolerant of any surrounding prose.
- `serializeGoals(originalText|null, items) -> newText` — items carry
  `{ text, done, line? }`. Items with a `line` rewrite that line in place
  (bullet/indent preserved, only the `[ ]`/`[x]` mark and text change); items
  without `line` are appended after the last existing checkbox line (or at
  EOF, or as a fresh `# Goals` document when originalText is null/empty).
  Round-trip law: `serializeGoals(text, parseGoals(text).items) === text`.

IO wrappers (main.js or goals.js): read/write `GOALS.md` under the project's
canonical path, ONLY for projects that are trusted per the existing
agent-control trust rules (post-consolidation) and `exists: true`. Writes are
atomic (tmp + rename). Reject paths that escape the project root.

## 3. IPC + preload (unfrozen for exactly these additions)

- `au:tasks-get (projectId)` → `{ exists, path, items }` or `null`
- `au:tasks-save (projectId, items)` → `{ ok, items }` (re-read after write)
- preload: `tasksGet(projectId)`, `tasksSave(projectId, items)` on `AU`.

## 4. Renderer — TASKS panel (system view only)

Left column, below the project card, same `.panel` chrome:
- Header `TASKS` + right-aligned `n / m done` (open count vs total).
- Rows: checkbox glyph + text (2-line clamp). Click row → toggle done →
  `tasksSave` → re-render from the response. Done rows muted + strikethrough.
- Footer: text input (placeholder `Add a goal…`) + Add on Enter/button;
  empty/whitespace input is a no-op.
- Refresh: on view open, after every save, and poll every 10 s while the
  system view is open (an agent may edit GOALS.md externally); stop polling on
  view dispose. Missing file → empty state `No goals yet — add one`.
- Untrusted/missing project path → panel hidden entirely.
- Update `kit/SPEC.md` §6 to document the panel (one short block).

## Acceptance

| # | Check |
|---|---|
| T1 | `src/main/goals.js` exports `parseGoals` + `serializeGoals` (clean FAIL "not implemented" until then) |
| T2 | Fixture table passes (parse, round-trip identity, toggle-in-place, append-after-last-checkbox, create-new, uppercase-X/indent/`*` tolerance) |
| T3 | `au:tasks-get`/`au:tasks-save` wired in main + `tasksGet`/`tasksSave` in preload; `TASKS` panel markup/renderer code present |
| T4 | Regression: `node kit/grade.mjs` PASSes |

Runner live check: add a task from the UI → GOALS.md appears in the project
with the item; check it off in the UI → file shows `[x]`; edit the file in an
editor → panel reflects it within ~10 s; prose in the file survives all of it.
Done → `kit/EXECUTOR-REPORT.md`; stuck → `kit/BLOCKED.md` and stop.

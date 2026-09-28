# Executor report — per-project task lists

Status: **PASS** on 2026-07-22.

## Delivered

- Added a dependency-free `GOALS.md` parser/serializer with source line
  tracking, exact no-change round trips, in-place checkbox/text rewrites, and
  insertion after the last existing checkbox without disturbing prose or line
  endings.
- Added guarded file IO for the fixed `GOALS.md` filename under the existing
  canonical live-project root. Reads reject invalid targets; writes validate
  every item, reject newline injection and symlinks, and use a same-directory
  temporary file plus rename before re-reading the result.
- Added main-frame-only `au:tasks-get` and `au:tasks-save` handlers. The
  renderer supplies only a project ID and task data; main resolves the trusted
  live Tracker record and never accepts a path from IPC.
- Added the system-only TASKS panel with open/total count, accessible toggle
  rows, two-line text clamping, done styling, empty state, and Add form. A
  generation-guarded controller refreshes on entry and every 10 seconds,
  rejects stale async replies, and tears down polling on every view change.
- Added the short Kit 10 system-view block to `kit/SPEC.md`.

No priority, due-date, ordering, assignment, provider-launch, database, sync,
dependency, asset, package, mockup, or grader change was made.

## Frozen kit

- `CONTRACT.md`: `58e7e5d865a13d62415553424f1af46e1d3e52a7e1bdb06ac03a8536f6ed30c9`
- `grade-tasks.mjs`: `b2044fdf92ad087f72e716fa8884cafdaa24bf751909f1f4ea1d0ff1a35e3c2b`

The distilled baseline failed cleanly at T1 because `src/main/goals.js` did
not exist. Before implementation, `node kit/grade.mjs` passed.

## Verification

- `node kit/todo/10-project-tasks/grade-tasks.mjs --fixtures-only` — PASS T1-T3.
- `node kit/todo/10-project-tasks/grade-tasks.mjs` — PASS T1-T4, including the
  permanent Electron renderer regression.
- Additional pure/IO checks — PASS for mixed CRLF input, uppercase `X`, exact
  round trip, initial file creation, atomic replacement of an existing file,
  append placement, toggling, and surrounding-prose preservation.
- Syntax checks and `git diff --check` — PASS.

## Live and visual check

A real Electron renderer was driven through its visible controls at the
repository's project system:

1. With no `GOALS.md`, the exact empty state was visible.
2. Adding `Kit 10 live check` in the form created the canonical fresh Goals
   document.
3. Clicking its row rewrote the file to `[x]`, updated the open/total count,
   and applied muted strikethrough styling.
4. An external file edit changed the item text and added prose before and
   after it. The panel reflected that edit on its next 10-second poll.
5. Clicking the externally edited row saved `[ ]` while preserving both prose
   lines byte-for-byte.

The panel was visually inspected in the normal window and again at the
1200x720 minimum. Measured bounds placed it 12 px below the project card,
above the summary card, inside the viewport, with no sidebar/history overlap.
The temporary live-check `GOALS.md` and screenshots were removed afterward;
no test project content remains.

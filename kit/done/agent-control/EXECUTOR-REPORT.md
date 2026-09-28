# Executor report — safe terminal launch action

Status: **PASS** on 2026-07-21.

## Delivered

- Added a dependency-free Windows Terminal adapter using only the fixed
  per-user app alias, `fs.accessSync(..., F_OK)`, an argv array, `shell:false`,
  detached ignored stdio, and immediate `unref()`.
- Added a main-frame-only `au:open-terminal` IPC boundary. The renderer sends
  only a primitive project ID; main resolves the ordinary live Tracker record,
  freshly canonicalizes/stats its directory, rejects replay and transition
  races, and returns bounded result codes.
- Added one accessible `Open Terminal` button and live status region to the
  existing project card in system and planet views. Open Folder stays first.
  Replay keeps the terminal action visible but disabled with the exact LIVE
  return note.
- Added a 1200x720 isolated Electron control mode with an intercepted launcher.
  It uses real pointer input for universe-to-system navigation, terminal
  requests, replay blocking, LIVE return, and planet navigation. A delayed
  first launch proves busy state survives a card rerender without a duplicate
  request.
- Added `docs/AGENT-CONTROL.md` and updated the live spec, roadmap, and kit
  status documentation.

No provider command, prompt, resume action, PATH lookup, shell wrapper, PID,
process registry, lifecycle supervision, tracker mutation, or replay mutation
was added.

## Frozen kit

- `CONTRACT.md`: `18891375cfaaf22b1c0ecb4973c34f8c3124dd380925f0af3a0dabb0c96c2dd2`
- `RUNNER.md`: `fb060058c8991415c10ad69e4387adac6c85734aae24e43cc886f196e94f0be7`
- `grade-control.mjs`: `e31e3c880cbebf764243ac8ba2b23dc68791f71bd812e0da43b410ed2ee1878f`

The distilled baseline failed cleanly at C0 because
`src/main/terminal-launcher.js` did not yet exist, while `node kit/grade.mjs`
passed before implementation.

## Verification

All required final gates passed:

- Item 07 control C1-C5
- History playback H1-H5
- Passive multi-provider V1-V5
- Attention fixtures A1-A2
- Galaxy grouping G1-G4
- Renderer polish P1-P4
- Permanent renderer mechanical gate

The final isolated result is bounded and path-free. It records two explicit
launch requests, one blocked replay interval, a main-side replay rejection,
safe Windows arguments, matching canonical working directories, one action in
planet view, no process ownership, and preserved pending state across rerender.

Both final screenshots were visually inspected at 1200x720. The LIVE action,
success status, replay-disabled state, history controls, project summary, and
sidebar are readable with no terminal-control clipping or overlap.

A real Windows Terminal smoke launch in a disposable empty directory returned
only `{ok:true}`. The app retained no path, argv, PID, child handle, or lifecycle
control; the launched terminal was intentionally left independent.

## Independent review

- Security review: PASS. Adversarial checks covered malformed and boxed IDs,
  wrong frames, replay/pending boundaries, missing and non-directory projects,
  concurrent requests, cooldown, and metadata stripping.
- Renderer/harness review: the initial review identified that system entry used
  a debug route. The harness was corrected to click the actual universe sun;
  a pending/rerender/duplicate-click proof was added, and C1-C5 passed again.
- Frozen-contract audit: PASS with no scope, leakage, provider, shell, PATH, or
  lifecycle findings.

Artifacts are retained in `output/`.

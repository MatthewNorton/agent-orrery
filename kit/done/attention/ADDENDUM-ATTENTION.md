# Addendum: "Needs Attention" detection + UI (phase 1.5)

Extends the shipped MVP (see `SPEC.md`, which this document assumes you have
read). Goal: the app must tell the user **which Claude sessions need them right
now** — a session blocked on a permission prompt or a question, or a session
that finished its turn and is waiting for orders. This is the feature that
turns the visualizer into a monitor.

Non-goals: OS tray, sounds, main-process notifications, config UI, history of
attention events. Do not build any of these.

## 0. Freeze changes for this addendum ONLY

- `src/main/tracker.js` — **UNFROZEN, additive-only.** You may add fields,
  constants, methods, and one export. You may insert code into existing
  methods. You may NOT rename/remove anything existing, change existing event
  shapes (only extend them), change existing feed kinds, timers' existing
  duties, or the persistence schema.
- `src/main/main.js`, `src/preload.js`, `package.json` — still frozen. The
  bridge already passes whole objects through, so no preload change is needed.
- `src/renderer/*` — editable, but the existing three views must keep passing
  `kit/grade.mjs` and the visual rubric in `RUBRIC.md` (regression-graded).

## 1. Transcript signals (verified against live transcripts on this machine)

Each JSONL line may be one of (top-level `type` / `message.role`):

- `type:'assistant'`, `message.role:'assistant'`, `message.content` is an
  array; `tool_use` blocks always have `id` and `name`.
- `type:'user'`, `message.role:'user'`; `message.content` is EITHER an array
  (tool_result blocks always have `tool_use_id`; may also contain text blocks)
  OR a **plain string** (a typed user prompt — the current tracker's
  `Array.isArray` guard skips these; your additions must not).
- `type:'system'`, `subtype:'turn_duration'`, with `durationMs` and
  `timestamp`, **written exactly when an assistant turn completes**. No
  `message` field. This is the authoritative "turn ended" signal.
- Other line types (`mode`, `attachment`, `file-history-snapshot`, …) exist;
  ignore them beyond the existing lastEvent bookkeeping.

Key fact the whole feature rests on: the assistant message containing a
`tool_use` block is appended to the transcript **before** the tool runs (and
before any permission prompt is answered); the matching `tool_result` is
appended only after it finishes. So "pending tool_use + file gone quiet" means
the session is blocked — on a permission prompt, a question, or a long-running
tool. Tool name + elapsed time disambiguate (heuristically; see §3).

## 2. Data model additions (tracker)

Ship records gain (internal + in `publicShip` output):

```js
ship.pending        // Map<toolUseId, { tool: string, ts: msEpoch }> — internal
ship.turnDone       // boolean — internal
ship.attention      // 'question'|'permission'|'stalled'|'done'|null — PUBLIC
ship.attentionSince // msEpoch | null — PUBLIC
```

Tracker gains `this.pendingIndex` (Map<toolUseId, shipId>) so `tool_result`
lines clear pending entries in O(1). Cap `ship.pending` at 12 entries (evict
oldest) so a malformed transcript can't grow it unbounded.

`FeedEntry.kind` gains two values: `'attention'` and `'done'`.

## 3. The classifier — exact contract (mechanically graded)

Export from `src/main/tracker.js` (alongside `Tracker`) a **pure function**:

```js
module.exports = { Tracker, classifyAttention };

classifyAttention(ship, now) -> 'question' | 'permission' | 'stalled' | 'done' | null
// reads ONLY: ship.kind, ship.lastEvent, ship.turnDone, ship.pending
// no I/O, no Date.now() inside — `now` is always passed in
```

Constants (top of file, near the existing ones):

```js
const QUESTION_PENDING_MS = 2_000;
const FAST_PENDING_MS     = 10_000;
const SLOW_PENDING_MS     = 180_000;
const DONE_QUIET_MS       = 10_000;
const ATTENTION_LINGER_MS = 60 * 60 * 1000;
const ASK_TOOLS  = new Set(['AskUserQuestion', 'ExitPlanMode']);
const LONG_TOOLS = new Set(['Bash', 'PowerShell', 'BashOutput', 'TaskOutput',
  'Agent', 'Task', 'Workflow', 'WebFetch', 'WebSearch', 'Monitor']);
```

Rules, in strict priority order (first match wins):

1. `ship.kind === 'drone'` → `null` (subagents never page the user).
2. Any pending `p` with `ASK_TOOLS.has(p.tool)` and `now - p.ts ≥
   QUESTION_PENDING_MS` → `'question'` (an unanswered AskUserQuestion or plan
   approval is a 100%-reliable "waiting on you").
3. Any pending `p` with `!LONG_TOOLS.has(p.tool)` and `now - p.ts ≥
   FAST_PENDING_MS` → `'permission'` (fast tools like Edit/Write/Read complete
   in well under 10s once approved; still pending ⇒ almost certainly a
   permission prompt). Unknown/MCP tool names count as fast.
4. Any pending `p` with `now - p.ts ≥ SLOW_PENDING_MS` → `'stalled'` (a
   long-running tool 3+ minutes without result — maybe working, maybe stuck;
   soft signal).
5. No pending, `ship.turnDone === true`, and `now - ship.lastEvent ≥
   DONE_QUIET_MS` → `'done'` (turn complete, awaiting orders).
6. Otherwise `null`.

`node kit/todo/01-attention/grade-attention.mjs` runs a fixture table against exactly this
contract. Do not tune thresholds or rules — they are decisions, not
suggestions; if one seems wrong, write `kit/BLOCKED.md` instead of deviating.

## 4. Tracker wiring (additive)

In `parseLine` (existing early-return structure must keep working):

- `type:'system'` + `subtype:'turn_duration'` → `ship.turnDone = true`.
- Assistant message (array content): `ship.turnDone = false`; for each
  `tool_use` block: `ship.pending.set(block.id, { tool: block.name, ts })` and
  `this.pendingIndex.set(block.id, ship.id)` (respect the 12-entry cap).
- User line that is a real prompt — string content, or array content with no
  `tool_result` blocks → `ship.turnDone = false` (clears a `'done'` state on
  the next evaluation; pending untouched).
- In `onToolResult`: in addition to the existing drone logic, look up
  `pendingIndex`, delete the entry from the owning ship's `pending`, delete
  from `pendingIndex`.

New method `evaluateAttention(now)` — called at the end of `pollFiles()`
(before `flush`) and inside `sweepShips()`:

- For each ship: `next = classifyAttention(ship, now)`. If `next !==
  ship.attention`: set `ship.attention = next`,
  `ship.attentionSince = next ? now : null`, queue
  `{ type: 'ship-updated', ship: publicShip(ship) }`, and push a feed entry —
  only on entering a non-null state:
  - `'question'` → kind `'attention'`, `` `${ship.name} is asking you something in ${project.name}` ``
  - `'permission'` → kind `'attention'`, `` `${ship.name} needs permission in ${project.name}` ``
  - `'stalled'` → kind `'info'`, `` `${ship.name} may be stuck in ${project.name}` ``
  - `'done'` → kind `'done'`, `` `${ship.name} finished its task in ${project.name}` ``
  - transitions to `null` (or between states, for the leaving side): no feed
    entry, just the `ship-updated`.

In `sweepShips`: ships with attention `'question'` or `'permission'` use
`ATTENTION_LINGER_MS` as their departure timeout instead of
`ACTIVE_WINDOW_MS` — a session waiting on the user must stay visible.
`'done'`/`'stalled'`/`null` keep existing timeouts.

## 5. Renderer requirements

Attention palette + labels (add to `util.js`):

| state | color | label |
|---|---|---|
| question | `#ff5d5d` | `Question` |
| permission | `#ffb454` | `Needs permission` |
| stalled | `#facc15` | `Maybe stuck` |
| done | `#34d399` | `Task complete` |

Feed kind colors: `attention` `#ff5d5d`, `done` `#34d399`.

- **Sidebar — ACTIVE AGENTS.** Sort order: question, permission, stalled,
  done, then the rest (stable within groups). Rows with non-null attention get
  a 2px left border in the attention color plus a small pill badge with the
  label; question/permission dots pulse (CSS animation, ~1Hz). Header
  right-text: when ≥1 ship is question/permission, show `N need you` in
  `#ff5d5d` (N = count of question+permission ships); else keep `N Running`.
- **Universe view.** A system glyph whose project has ≥1 question/permission
  ship gets a pulsing alert halo around its sun (thin ring or soft disc in the
  attention color, ~1Hz opacity pulse, sized to read at map distance). Remove
  it promptly when the state clears. `done`/`stalled` get no halo.
- **System view.** Ship name labels gain a short suffix in the attention color
  (`· needs you` for question/permission, `· done` for done). Project card
  STATE row: if any ship in this project is question/permission, show
  `Needs You` in `#ff5d5d`, overriding the existing state logic.
- **Event feed.** Render the two new kinds with their colors; rows stay
  clickable (existing behavior jumps to the project's system view).
- **Desktop notification (SOFT — graded as soft, don't gate on it).** In
  `app.js`, when applying a `ship-updated` whose attention transitions
  null→`'question'` or null→`'permission'` (compare against the store's
  previous value): fire an HTML5 `new Notification(...)` — title
  `` `${ship.name} needs you` ``, body `` `${label} · ${projectName}` ``.
  Feature-detect + try/catch; throttle to ≥30s per ship and ≥10s globally.
  No click handling, no permission-request flow.

Perf guardrails from `SPEC.md` §9 still apply: no per-frame allocations, halo
is one reusable mesh/animation per glyph, sidebar re-renders only on change.

## 6. Known limitations (accepted — document, don't fix)

- Sessions already mid-turn when the app starts tail from the end of the file
  (`SPEC` startup behavior), so their pending state is unknown until their
  next tool call. Accepted.
- A genuinely long non-interactive Bash command (> 3 min) reads as `stalled`.
  Accepted — that's why stalled is styled soft and never counts in `need you`.

## 7. Grading

Mechanical — `node kit/todo/01-attention/grade-attention.mjs` (kill-switch; FAILs cleanly until
implemented):

| # | Check | Fail condition |
|---|---|---|
| A1 | `classifyAttention` exported from `src/main/tracker.js` | missing/not a function |
| A2 | Full fixture table passes (priority order, thresholds, drone rule, done rule) | any case wrong |
| A3 | Regression: `node kit/grade.mjs` still PASSes (M1–M4) | any mechanical regression |

Visual/functional (staged live check — runner or matt):

1. `npm start`. In a terminal, start a Claude session in any repo and give it
   a prompt that triggers a permission prompt (e.g. a command outside the
   allowlist). Within ~15s of the prompt appearing: sidebar shows that ship
   with the amber `Needs permission` badge sorted to top, header shows
   `1 need you`, the project's universe glyph pulses with a halo, feed logs
   the attention entry. **Hard fail** if none of that appears within 30s.
2. Approve the prompt. Within ~15s the badge/halo/`need you` clear. **Hard
   fail** if the state sticks after the tool_result lands.
3. Let the session finish its turn. Within ~15s the ship shows the green
   `Task complete` badge and the feed logs the done entry. **Hard fail** if
   turn completion is never detected.
4. Soft: desktop notification fired on step 1; `AskUserQuestion` (ask the
   session to use it) produces the red `Question` state; existing visuals
   unchanged vs the passing `.shots/*.png`.

Record results by APPENDING a `## Attention addendum` section to
`kit/EXECUTOR-REPORT.md` (what changed per file, fixture output, live-check
evidence, deviations if any).

## 8. Executor instructions (Codex or any coding agent)

1. Read, in order: this file, `SPEC.md` §1–§4 + §9, `src/main/tracker.js`,
   `src/preload.js`, `src/renderer/app.js`, `src/renderer/util.js`,
   `src/renderer/style.css`, `src/renderer/scene-universe.js`,
   `src/renderer/scene-system.js`.
2. Baseline: run `node kit/todo/01-attention/grade-attention.mjs` — it must FAIL with "not
   implemented". Run `node kit/grade.mjs` — it must PASS. If either behaves
   otherwise, stop and write `kit/BLOCKED.md`.
3. Milestone 1 — tracker: constants, data model, `classifyAttention`, wiring
   (§2–§4). Gate: `node kit/todo/01-attention/grade-attention.mjs --fixtures-only` passes.
4. Milestone 2 — renderer (§5). Gate: `node kit/todo/01-attention/grade-attention.mjs` passes
   in full (includes the `grade.mjs` regression, which launches Electron and
   takes ~1–2 min).
5. Run the staged live check (§7) yourself if you can run GUI apps; otherwise
   state clearly in the report that it's untested and why.
6. Append the report section (§7). Never modify `main.js`, `preload.js`,
   `package.json`, `grade.mjs`, `grade-attention.mjs`, or this file. Blocked
   → `kit/BLOCKED.md` with the specific question; do not guess around a
   contract.

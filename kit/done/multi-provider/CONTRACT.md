# Contract — passive multi-provider agents

Make Claude Code, Codex, and explicitly registered unknown log producers appear
in one universe while preserving the product's defining safety boundary: Agent
Universe observes files; it never launches, owns, steers, or writes to an agent
process or transcript.

## Minimum complete scope

- Claude remains a zero-configuration native provider.
- Codex becomes a zero-configuration native provider by observing
  `~/.codex/sessions/**/*.jsonl`.
- Unknown tools can be represented as generic `Signal` ships by manually
  registering a log directory in `providers.json` beside
  `universe-state.json`. There is no settings UI in this item.
- Retire the `MVP · CLAUDE ONLY` badge and add provider identity to ship hulls
  and ACTIVE AGENTS rows.
- Do not add playback, agent controls, process discovery, a tray, networking,
  or support for another provider-specific transcript schema.

## Editable scope

- `src/main/tracker.js`
- `src/main/provider-adapters.js` (new, pure Node helper)
- `src/main/main.js` — additive isolated `--provider-test` plumbing only
- `src/renderer/index.html`
- `src/renderer/style.css`
- `src/renderer/util.js`
- `src/renderer/app.js`
- `src/renderer/scene-universe.js`
- `src/renderer/scene-system.js`
- `src/renderer/scene-planet.js`
- `docs/MULTI-PROVIDER.md` (new)
- `kit/todo/05-multi-provider/**`
- live status/spec documentation under `kit/`

`CONTRACT.md`, `RUNNER.md`, and `grade-providers.mjs` are runner-owned and
frozen after distillation review. Everything else is frozen, especially
`src/preload.js`, `package.json`, the lockfile, assets, mockups, and every
archived/current grader. Add no dependency or network request.

## V1 — additive public contract

Every public Ship in snapshots and `ship-spawned` / `ship-updated` events gains
one always-present additive field:

```js
provider: 'claude' | 'codex' | 'generic'
```

Keep all existing Ship fields, Project fields, bridge methods, event names,
sequence semantics, feed kinds, and view routes unchanged. Existing Claude
ships and drones are `claude`; Codex threads are `codex`; manual signals are
`generic`. `ship-departed` remains `{ shipId, ts, seq }`.

Provider-qualified ship IDs must not collide. Preserve existing Claude ID
formats for compatibility. Use `ship:codex:<session-id>` for Codex and a
stable hashed source/file identity for generic ships. Display names use the
bounded prefixes `Claude-`, `Codex-`, and `Signal-`; no prompt text becomes a
name.

Projects are shared across providers. Export
`canonicalProjectPath(value)` from `src/main/provider-adapters.js`; it returns
`win:<case-folded slash path>` for Windows syntax and
`posix:<case-preserved path>` for POSIX syntax, invariant to trailing or mixed
Windows separators. The tracker keeps a canonical-path registry so two
providers with the same cwd produce one Project and multiple ships, never
duplicate systems. Claude discovery runs first for legacy compatibility;
new non-Claude-only projects use `project:<eight-hex-fnv1a>` IDs. Persist the
canonical path→project ID aliases additively beside the existing state and
continue reading legacy state unchanged.

The Tracker constructor remains backward compatible and accepts an optional
second object for isolated tests:

```js
new Tracker(statePath, {
  claudeProjectsDir?, codexSessionsDir?, providerConfigPath?
})
```

Omitted paths use the real home-directory defaults. No environment lookup may
occur inside pure adapter functions.

## V2 — provider adapters and normalized semantics

`src/main/provider-adapters.js` must be dependency-free and export:

```js
canonicalProjectPath(value)
codexRecordToSignals(record)
providerToolStatus(tool)
readGenericWatchConfig(file)
```

`codexRecordToSignals` is pure and always returns an array. It understands the
observed Codex rollout vocabulary and ignores every unrelated record:

- `session_meta` → one `session` signal carrying only bounded `sessionId`,
  `cwd`, and `kind`; `kind` is `drone` for `thread_source: 'subagent'`, with
  `parent_thread_id` / `agent_path` only as a fallback when thread_source is
  absent, otherwise `main`;
- `response_item` `function_call` or `custom_tool_call` → `tool-start` with
  only `callId` and a bounded tool name;
- matching `function_call_output` / `custom_tool_call_output` → `tool-end`;
- successful `event_msg:patch_apply_end` → `build` with only the property
  names of `payload.changes` as file paths; patch contents/stdout/stderr are
  discarded;
- `event_msg:task_started` → `turn-start`;
- `event_msg:task_complete` or `turn_aborted` → `turn-end`;
- message, reasoning, token, command, output, and tool-argument content → no
  signal.

Read a Codex file's first complete line separately (bounded to 256 KiB) to get
session metadata even when normal startup tailing begins at EOF. Discover
rollouts recursively without following symlinks. Startup creates a ship only
for a file in the existing active window; later appends update it using the
existing hot/active/departure timing and batched event cursor.

Map normalized tool starts into the existing vocabulary:

- edit/write/patch → `Building`;
- read/find/search/list/open/view → `Exploring`;
- exec/shell/command/write_stdin/wait → `Gathering Resources`;
- web/browser → `Scanning`;
- spawn/followup/send_message/agent/task → `Delegating`;
- plan/goal/todo → `Planning`;
- otherwise `Working`.

Emit the ordinary `ship-updated` and `activity` events. A successful Codex
patch emits one ordinary `build` per changed file inside the cwd, with the
same root/top-directory bucket rules as Claude, and updates Project build
counts/cache. Paths outside the cwd, failed patches, and duplicate completion
records cannot create builds. Actual Codex subagent rollout files create drone
ships; do not also synthesize a second drone from `spawn_agent` calls.

Codex pending call IDs participate in the existing attention classifier.
`request_user_input` is an ask tool. Treat exec, command, wait, web, and agent
coordination tools as long-running so a legitimate operation is not called a
permission prompt after ten seconds. `task_started` clears done and
`task_complete`/`turn_aborted` sets done. Drones still never page the user.

Claude parsing, attention, builds, persistence, timing, names, IDs, and event
ordering remain behaviorally unchanged except for the additive provider field
and shared-project registry.

## V3 — generic signal watches

The optional JSON file is:

```json
{
  "watch": [
    {
      "directory": "C:\\absolute\\agent-logs",
      "projectPath": "C:\\absolute\\repo",
      "label": "Gemini"
    }
  ]
}
```

`directory` must be absolute. `projectPath` is optional and defaults to the
directory. `label` is optional, printable, trimmed, and capped at 24
characters; it may prefix the display name but the public provider remains
`generic` and the UI tag remains `SIGNAL`. Ignore invalid/duplicate entries
with one concise warning; a missing or malformed file cannot stop native
providers. Document that config changes require an app restart.

For each configured directory, recursively stat regular `.json`, `.jsonl`,
`.log`, and `.txt` files without following symlinks. Cap each watch at the 256
most recently modified files. Never open generic file contents. A fresh file
creates one main Signal ship; size/mtime changes emit a bounded `activity`
with tool `signal`, status `Working`, and no detail. Missing files depart once;
otherwise use the normal active timeout. Generic watches never infer builds,
drones, attention, or message text.

## V4 — privacy, safety, and resource bounds

- Read provider logs only; never modify, truncate, lock, delete, rename, or
  acknowledge them.
- Never spawn a provider executable, attach to a process, issue a command,
  import provider SDKs, or communicate over the network.
- Never persist or emit prompts, assistant responses, reasoning, commands,
  tool arguments/results, patch bodies, stdout/stderr, or generic log bytes.
  Public detail may contain only a bounded tool label or a project-relative
  file path.
- Bound a retained partial JSONL line to 1 MiB. Skip an oversized/malformed
  line and resume after its newline; one bad line cannot stall other sources.
- Read at most 8 MiB per file per poll, preserve the existing hot-file cutoff,
  and make ordinary updates O(changed records). No renderer scene rebuild is
  allowed for provider/status-only events.

## V5 — provider identity in every view

Replace the top badge text with exactly `MULTI-PROVIDER`.

Add provider palettes in `util.js` and make `shipTint(shipId, provider)`
default a missing provider to `claude` for legacy fixtures. Claude uses purple
variants, Codex cyan/blue variants, and generic amber/neutral variants. Pass
the provider in all universe, system, planet, and sidebar tint calls. Tint is
the provider identity; no new asset or glyph is required.

Every ACTIVE AGENTS row contains a compact tag with exact text `CLAUDE`,
`CODEX`, or `SIGNAL`. Preserve attention sorting/badges, drone styling,
click-through, status text, feed behavior, decluttering, galaxy layout, and
all three scenes. Provider tags must remain readable alongside an attention
badge at the minimum window size.

Expose actual proof as `scene.metadata.providerStats()` in the universe and
include it plus DOM tag/badge evidence in the isolated `--provider-test`
`result.json`. Metrics cover public provider counts, ship mesh counts by
provider, distinct material colors, sidebar tag counts/text, the top badge,
and renderer errors. The harness records `universe.png` and exits without
touching real provider data.

## Gates

From the repository root all commands must pass:

```powershell
node kit/todo/05-multi-provider/grade-providers.mjs
node kit/done/attention/grade-attention.mjs --fixtures-only
node kit/done/galaxy-grouping/grade-galaxies.mjs
node kit/done/polish-pass/grade-polish.mjs
node kit/grade.mjs
```

Visually inspect the provider fixture screenshot for three identifiable ship
colors, all three provider tags, the MULTI-PROVIDER badge, intact galaxies,
and no clipped chrome. Also launch once against the real profile and confirm a
current Codex main thread and subagent appear without duplicate projects.
Archive this unchanged kit with report, validation log, metrics, and
screenshots only after every gate and live check passes.

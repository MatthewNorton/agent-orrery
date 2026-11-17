# Passive multi-provider tracking

Agent Orrery's passive discovery layer observes Claude Code and Codex session
files, and the local Ollama server, without owning the agents that create them. It never launches or spawns
provider processes, sends commands to a discovered session, or writes to its
transcript. The separate, user-initiated global task workflow may start a new
Codex process for an assigned tagged goal; see [TASK-IDEAS.md](TASK-IDEAS.md).

Claude Code is discovered under `~/.claude/projects`. Codex is discovered
recursively under `~/.codex/sessions` and `~/.codex/archived_sessions`.
Sessions from either provider that report the same working directory share one
project system.

## Generic signal sources

An unrecognized local tool can appear as a metadata-only Signal ship. Create
`providers.json` beside `universe-state.json` and restart the app:

```json
{
  "watch": [
    {
      "directory": "C:\\absolute\\agent-logs",
      "projectPath": "C:\\absolute\\repo",
      "label": "Local Builder"
    }
  ]
}
```

`directory` must be absolute. `projectPath` defaults to that directory, and
`label` is optional. Configuration changes take effect after an app restart.
Agent Orrery recursively stats regular `.json`, `.jsonl`, `.log`, and `.txt`
files but never reads their contents. An optional `extensions` array, such as
`[".log"]`, narrows that list; one that names none of the four is ignored with a
warning. A fresh or changed file produces a
content-free activity signal; generic sources never infer builds, prompts,
subagents, or attention state.

## Local model servers

A model loaded in a local server is tracked by the server itself, whatever
client is driving it: the Ollama desktop app, a script, an editor plugin. The
`local` provider is server-agnostic; Ollama is its first adapter
(`src/main/live/ollama-source.js`). Every five seconds the main process asks
`GET /api/ps` on the loopback Ollama server (`http://127.0.0.1:11434` by
default) which models are loaded. The answer names each model, its memory
split and the time it will be unloaded, which Ollama moves forward on every
request the model serves. Agent Orrery never reads a chat, a prompt or a
response: `/api/ps` is the only request, and it carries none.

Each loaded model is a red ship named for the server (`Ollama-1`, `Ollama-2`)
with the model name as its tag, in the `Ollama` system, which is the server's
home folder (`~/.ollama`). A served request is an activity on that ship; a
model unloaded from the server departs as "unloaded"; a ship idle for five
minutes warps out like any other and docks again on the next request. When
the server stops answering, the feed says "Ollama server offline" and every
Ollama ship departs; "Ollama server online" marks its return.

`providers.json` can turn the adapter off or point it elsewhere:

```json
{ "ollama": false }
{ "ollama": { "host": "127.0.0.1:11500", "home": "D:\\ollama" } }
```

`OLLAMA_HOST` is honoured too, in Ollama's own syntax (`host`, `host:port`,
`http://host[:port]`). Only `http` on a loopback host (`127.0.0.1`,
`localhost`, `0.0.0.0`, `::1`) is accepted; anything else, a LAN address
included, is refused with one warning and no request. A `watch` array is not
required beside an `ollama` entry.

A second local server (LM Studio on `127.0.0.1:1234`, llama.cpp, vLLM) is one
more adapter beside the Ollama one in the main process: the same `local`
provider, its own label and home folder, and its own "in use" signal (LM
Studio lists `state: "loaded"` on `/api/v0/models`). The renderer and the
harness need nothing for it.

## Transcript formats

The transcripts are the providers' own working files, not a published
interface, and either provider may change them without notice. Agent Orrery
reads them defensively: every line is parsed on its own, every field is
checked, and a record it does not recognise is skipped. A format change
therefore never crashes the app; it empties it. To make that visible, each
tailed transcript counts the lines it reads and the records of a kind its
adapter reads (`claudeRecordFacts`: a message or a system record;
`codexRecordFacts`: a `session_meta`, `turn_context`, `response_item` or
`event_msg`). One that reaches 40 lines with none of that kind raises a warning
for its provider, quoting the provider's version when its records name one, in
the console, the event feed and `snapshot.warnings`; the feed panel keeps it
pinned for the rest of the run. A fresh Codex rollout whose metadata cannot be
read is never tailed, so the same rule runs over its head at discovery.
`providers.json` errors show the same way.

What each adapter depends on, last confirmed against Claude Code 2.1 and
Codex CLI 0.167 (November 2026):

| Provider | Files | Fields read |
|---|---|---|
| Claude Code | `~/.claude/projects/<slug>/<session>.jsonl` | `type` (`user`, `assistant`, `system` with `subtype: turn_duration`), `cwd`, `isSidechain`, `timestamp`, `version`; `message.role`, `message.model`, and in `message.content[]` the block `type` (`text`, `tool_use`, `tool_result`), `id`, `name`, `input.file_path` / `pattern` / `description`, `tool_use_id` |
| Codex | `~/.codex/sessions/**/rollout-*-<uuid>.jsonl` and `~/.codex/archived_sessions/**` | `type` (`session_meta`, `turn_context`, `response_item`, `event_msg`), `timestamp`; in `payload`: `id`, `session_id`, `cwd`, `thread_source`, `source`, `parent_thread_id`, `forked_from_id`, `agent_path`, `model`, `model_provider`, `cli_version`, `type` (`message`, `function_call`, `custom_tool_call`, their `_output` forms, `patch_apply_end`, `task_started`, `task_complete`, `turn_aborted`), `call_id`, `name`, `role`, `content[].text`, `changes`, `success` |

The adapters are `src/main/transcripts/claude.js` and
`src/main/transcripts/codex.js`; the fixtures in `test/support/transcripts.js`
are the executable half of this table. When the warning fires, the repair is in
those two files, and `src/main/live/drift.js` is the canary.

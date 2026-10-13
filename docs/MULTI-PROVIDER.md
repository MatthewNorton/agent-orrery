# Passive multi-provider tracking

Agent Orrery's passive discovery layer observes Claude Code and Codex session
files without owning the agents that create them. It never launches or spawns
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

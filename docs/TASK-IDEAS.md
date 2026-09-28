# Global task ideas

The command rail includes a global **IDEAS** queue. It is independent of the
current universe, system, or planet view, so a user can capture a to-do before
choosing where it belongs.

New ideas are stored in Agent Universe's per-user application data. An idea is
not written into a repository and does not start an agent until the user picks
an existing project and chooses **Assign & start**. Project assignment is
permanent for that idea.

An unassigned idea can be removed from the global queue after confirmation.
Once assignment begins, the global record is protected so removing it cannot
orphan a project goal or an active task run.

Assignment is available only in **LIVE** mode. Agent Universe resolves the
selected project through the live tracker, writes one tagged unchecked item to
that project's root `GOALS.md`, records the launch request, and starts Codex in
the project directory. The tag is an internal UUID and is hidden from the task
text shown in the app. Only one app-started task may run in a project at a time.

The launch adapter invokes a verified native Codex binary directly (`codex.exe`
on Windows, `codex` on macOS and Linux), with no shell and no renderer-supplied
executable or command arguments. It supports a native executable on `PATH`
(including a Homebrew or npm symlink whose target is a real binary outside the
project) and the native architecture package from an npm-installed
`@openai/codex`. It never executes npm's `.cmd` or JavaScript wrappers. If Codex cannot be found or started, the goal remains
assigned and the idea exposes **Retry start**; retrying does not duplicate the
`GOALS.md` item.

Agent Universe correlates the spawned Codex transcript with the exact hidden
task tag. When that agent reports successful completion, the matching checkbox
is marked complete and both the global idea and the project task show **Ready
for review**. Aborted, missing, or failed starts remain visible with a bounded
failure state and can be retried where safe. The app does not automatically
approve elevated access, merge code, push changes, or mark unrelated tasks.

The project **TASKS** panel also lets users remove manually created checklist
items after confirmation. Internally tagged agent tasks remain protected and
must stay available for run correlation and review status.

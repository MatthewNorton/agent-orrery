# Open Terminal control

Agent Orrery adds one deliberately narrow control to each live project card:
`Open Terminal`. It opens the host's stock terminal at that project's current
working directory so the next command remains the user's choice.

The action is available only in **LIVE** mode for a project that still exists.
During history replay it stays visible but disabled; return to LIVE before
opening a terminal. A failed or unavailable terminal launch is reported inside
the project card without exposing paths or operating-system details.

Exactly one fixed executable per host is supported: on Windows the per-user
Windows Terminal app alias at `%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe`,
and on macOS the system launcher `/usr/bin/open` opening Terminal.app. Linux
reports the control as unavailable. Agent Orrery does not search `PATH`,
invoke a shell, or accept a path, executable, command, prompt, session
identifier, or arguments from the renderer. The main process resolves the
selected ID through the live tracker, verifies the directory immediately before
launch, and passes the working directory as one opaque argument. See
[MACOS-LAUNCH.md](MACOS-LAUNCH.md) for the per-platform matrix.

The terminal control is not an agent launcher: it does not launch or pretype a
provider command or prompt, and Agent Orrery never owns, manages, writes to,
or terminates the independent terminal process. If the user later starts an
agent there, the ordinary passive tracker observes it like every other session.

The global IDEAS queue is a separate, explicit task workflow. After the user
assigns an idea to a project, that workflow can write a tagged `GOALS.md` item
and start Codex without opening a terminal. Its boundaries and completion
tracking are documented in [TASK-IDEAS.md](TASK-IDEAS.md).

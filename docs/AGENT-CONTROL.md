# Open Terminal control

`Open Terminal` returns to the terminal running the selected agent. In the
first-person cockpit it targets that exact ship's session, including when several
agents share a project. A drone returns to its known parent session. The project
card targets its sole live agent; with several agents it asks you to select one.
Only a dormant project, with no live agents, opens a fresh shell at its directory.

The action is available only in **LIVE** mode for a project that still exists.
During history replay it stays visible but disabled; return to LIVE before
opening a terminal. A failed or unavailable terminal request is reported inside
the project card without exposing paths or operating-system details.

On Windows, a fixed PowerShell helper uses the local Claude session registry or
the OS's open-file ownership for a Codex rollout to identify the running process.
It validates the process name and start time before attaching to its console.
Classic console windows are focused directly. For Windows Terminal, a temporary,
unique console title identifies the exact tab and pane through accessibility;
the original title is restored afterward, and unsuccessful searches restore the
previous tab. No project-name or window-title guessing is used.

On macOS, the registry or `lsof` identifies the process and `ps` resolves its TTY.
A fixed AppleScript selects the existing Terminal.app tab with that TTY. macOS
may require Automation permission for this action. Other macOS terminal hosts
and Linux are unsupported. Closed, inaccessible, or headless agent sessions
report that their terminal cannot be found; they never fall back to a new shell.

The renderer supplies only a live project or ship ID through the existing
one-argument bridge. Main resolves the session from its own tracker and revalidates
the local project directory. It accepts no renderer-supplied paths, PIDs,
executables, commands, prompts, or arguments. Helper input is data, never code;
helpers have bounded execution and output. A dormant project's shell still uses
the fixed Windows Terminal app alias or `/usr/bin/open -a Terminal`, with its
working directory passed as one opaque argument. See [MACOS-LAUNCH.md](MACOS-LAUNCH.md).

The terminal control is not an agent launcher: it does not launch or pretype a
provider command or prompt, and Agent Orrery never owns, manages, types into,
or terminates the independent agent or terminal process. If the user later starts an
agent there, the ordinary passive tracker observes it like every other session.

The global IDEAS queue is a separate, explicit task workflow. After the user
assigns an idea to a project, that workflow can write a tagged `GOALS.md` item
and start Codex without opening a terminal. Its boundaries and completion
tracking are documented in [TASK-IDEAS.md](TASK-IDEAS.md).

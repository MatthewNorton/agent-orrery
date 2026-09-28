# Contract — safe terminal launch action

Turn the project card into the smallest useful control surface: open a new
terminal at the selected live project's working directory. This is one
explicit user-initiated launch only. Agent Universe never pretypes a provider
command and never owns, resumes, prompts, writes to, monitors, terminates, or
otherwise manages anything launched from that terminal.

## Minimum complete scope

- Add one `Open Terminal` action to the project card in system and planet
  views.
- Support the fixed per-user Windows Terminal app alias on Windows. Other
  platforms and an unavailable alias fail safely.
- Keep the action live-only. History can be inspected but never acted on.
- Do not add provider launch, prompt entry, approval/deny, session resume,
  transcript opening, task queues, process lists, PID tracking, provider SDKs,
  or a terminal emulator inside Electron. Each is a separate later decision.

## Editable scope

- `src/main/terminal-launcher.js` (new, dependency-free launch adapter)
- `src/main/main.js`
- `src/preload.js`
- `src/renderer/style.css`
- `src/renderer/app.js`
- `docs/AGENT-CONTROL.md` (new)
- `kit/todo/07-agent-control/**`
- status and live-spec documentation under `kit/`

`CONTRACT.md`, `RUNNER.md`, and `grade-control.mjs` are runner-owned and
frozen after distillation review. Everything else is frozen, especially the
Tracker, replay source, provider adapter, renderer HTML, all scene files and
pure renderer helpers, package manifests, dependencies, assets, mockups,
scripts, and every archived/current grader. This item must consume the
existing project model and active-source controller without changing
observation or replay semantics.

## C1 — narrow action and bridge

Expose one additive preload method:

```js
AU.openTerminal(projectId)
// result: { ok: Boolean, code?: String }
```

The renderer can supply only the project ID. It never sends a cwd, executable,
arguments, command string, prompt, transcript path, session ID, environment,
or PID. Main registers one `au:open-terminal` handler and accepts calls only
from the window's main renderer frame.

Validate a primitive `projectId`: a non-empty string of at most 256 code units
with no NUL or control characters. Reject objects, arrays, boxed strings,
symbols, malformed strings, and inherited/coerced values before looking up a
project. Failed validation cannot spawn or reveal whether an arbitrary
filesystem path exists.

Main resolves the ID through the ordinary live `Tracker`, never through a
renderer value or a replay snapshot. Launch only when `activeSource ===
tracker`, the project currently has `exists: true`, its stored path is
absolute, and a fresh realpath/stat check says it is a directory. Resolve the
real cwd immediately before launch. Deleted, missing, stale, symlink-loop, or
non-directory projects fail closed.

IPC results are bounded to `{ok}` or `{ok:false, code}`. Failure `code` is one
of `INVALID`, `REPLAY`, `NOT_FOUND`, `UNAVAILABLE`, `BUSY`, or `FAILED`. Do not
return or log a cwd, executable path, argv, environment, PID, stack, terminal
output, or operating-system error text. One in-flight action plus a 750 ms
success cooldown prevents rapid duplicate clicks; the renderer also disables
the button while its invoke is pending.

## C2 — fixed Windows Terminal, no-shell adapter

`src/main/terminal-launcher.js` uses only Node built-ins and exports:

```js
createTerminalLauncher(options?)
buildTerminalSpec({ terminalPath, cwd })
resolveWindowsTerminal({ platform, env, fsImpl? })
```

`createTerminalLauncher({...}).open({cwd})` accepts only an already resolved
absolute directory. Production defaults use `process.platform`, `process.env`,
`node:fs`, and `child_process.spawn`; injection is allowed only so the isolated
gate can record calls without starting a real terminal. It returns bounded
metadata such as `{ok:true, terminal:'windows-terminal'}` and never returns a
child handle, path, argv, environment, or PID.

Adapter failures either reject or return `{ok:false, code}` with code
`INVALID`, `UNAVAILABLE`, or `FAILED`. Their message, if any, is generic and
must not include the cwd, alias path, or underlying operating-system error.

On `win32`, `resolveWindowsTerminal` derives exactly this path from the
existing environment value:

```text
%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe
```

`LOCALAPPDATA` must be a non-empty absolute Windows path. Append the literal
segments with `path.win32`; accept no renderer override. Check the app alias
with `fs.accessSync(alias, fs.constants.F_OK)`. Do not require `stat`,
`realpath`, open/read, or executable-bit checks: the Windows app-execution
alias can reject metadata reads even though it is launchable. Never search
`PATH`, the project cwd, the registry, Start menu, installed packages, or any
fallback terminal. Do not accept `.cmd`, `.bat`, `.ps1`, provider executables,
or arbitrary names. A missing/inaccessible alias and every platform other
than `win32` return `UNAVAILABLE` with no spawn.

`buildTerminalSpec` treats a cwd containing spaces, quotes, ampersands,
parentheses, semicolons, leading dashes, or shell metacharacters as one opaque
argv value. It never quotes, escapes, joins, or interpolates a command string.
It returns `{command, args, options}` matching the spawn call below. The
required spec is exact:

```text
Windows Terminal app alias:  ["-d", cwd]
```

Every call is exactly:

```js
spawn(absoluteTerminalExecutable, argvArray, {
  cwd: absoluteRealProjectDirectory,
  shell: false,
  detached: true,
  stdio: 'ignore',
  windowsHide: false
})
```

No `shell:true`, `exec`, `execFile`, command wrapper, login shell, `-c`,
`/c`, PowerShell command, `start`, `eval`, or platform shell is allowed. The
arguments contain no provider command, prompt, resume flag, transcript/session
identifier, or user-derived text beyond the resolved cwd as its own element.

After a successful `spawn` call, attach at most a one-shot error sink, call
`unref()` immediately, and discard the handle. Never retain a child in a map,
subscribe to exit/close/stdout/stderr, poll it, wait for it, restart it, send
input/signals, expose it to the renderer, or kill it on app shutdown. Starting
an agent remains the user's choice inside the independent terminal; the
ordinary Tracker observes any transcript that later appears.

## C3 — live/replay and failure boundaries

Opening a terminal is an explicit side effect and is allowed only in LIVE.
While replay is visible, the project action remains visible but disabled and
an exact note reads `Return to LIVE to open a terminal.` Main independently
returns `{ok:false, code:'REPLAY'}` for a forged or stale bridge call and the
adapter is not invoked. Returning LIVE re-enables the action from the fresh
live snapshot; it does not queue or replay a historical click.

The action is absent for a missing/deleted project. Executable-unavailable and
spawn-failure states stay in the app, keep visualization usable, and show
short, non-path-bearing messages. No terminal action adds universe events or
feed entries. It does not modify replay epochs, seek/playback state, live
tracker state, project state, transcripts, provider config, or
`universe-state.json`.

## C4 — one accessible project-card action

Keep the existing Open Folder button first so established pointer and polish
proofs continue to target it. Give the new button stable ID
`#project-terminal`, exact visible text `Open Terminal`, and an accessible
name. Add `#project-control-status` with `role="status"`,
`aria-live="polite"`, and `aria-atomic="true"`.

There is exactly one terminal button and no selector, menu, prompt textbox,
provider button, resume button, or confirmation dialog. The action is keyboard
reachable, has a visible focus treatment, and exposes disabled and busy state.
Success text is exact `Terminal launch requested`. Failure text is bounded and
contains no path or OS error. Re-rendering the project card preserves pending
and status state for the same project and cannot accidentally invoke again.

The action appears in both system and planet project cards, not the universe
or sidebar agent rows. At 1200x720 it is fully within the viewport, not
clipped, and has zero rectangle overlap with the back button, right sidebar,
summary, planet tabs, or history bar.

## C5 — isolated and real rendered proof

Add `--control-test --control-output=<dir>` to the existing Electron test-mode
plumbing. It owns temporary live/history transcript fixtures and an injected
recording terminal launcher. It never reads the real profile and never opens a
real terminal. The window is exactly 1200x720.

Through actual Electron pointer input, the harness opens one fixture system
and clicks `#project-terminal` once. It proves exactly one recorded safe call,
then enters replay, proves the rendered button and a forged bridge call are
both blocked with zero additional calls, returns LIVE, and proves one new
explicit click works. It navigates to the fixture planet and proves the same
single action is rendered there without spawning merely from re-rendering.
Save `control-live.png`, `control-replay.png`, and bounded `result.json` with no
absolute paths, argv, environment, PID, transcript text, or real-profile data.

The result schema is:

```js
{
  schemaVersion: 1,
  passed: true,
  windowSize: { width: 1200, height: 720 },
  steps: [
    { action: 'system-terminal', actualInput: true },
    { action: 'replay-blocked', actualInput: true },
    { action: 'live-return', actualInput: true },
    { action: 'planet-proof', actualInput: true }
  ],
  controls: {
    ids: ['project-terminal', 'project-control-status'],
    exactText: 'Open Terminal',
    liveEnabled: true,
    replayDisabled: true,
    replayNote: 'Return to LIVE to open a terminal.',
    overlapCount: 0,
    clippedCount: 0,
    singleTerminalButton: true,
    noProviderOrPromptControls: true
  },
  metrics: {
    initialLaunchCount: 1,
    replayLaunchCount: 1,
    finalLaunchCount: 2,
    safeWindowsSpec: true,
    sameCanonicalCwd: true,
    replayMainRejected: true,
    planetRendered: true,
    noProcessOwnership: true
  },
  rendererErrors: []
}
```

`planet-proof` is an actual planet navigation input and DOM/layout assertion;
it does not click the terminal a third time. Both screenshots must be fresh,
readable, and captured at the minimum window size.

## Gates and archive

From the repository root all commands must pass:

```powershell
node kit/todo/07-agent-control/grade-control.mjs
node kit/done/history-playback/grade-history.mjs
node kit/done/multi-provider/grade-providers.mjs
node kit/done/attention/grade-attention.mjs --fixtures-only
node kit/done/galaxy-grouping/grade-galaxies.mjs
node kit/done/polish-pass/grade-polish.mjs
node kit/grade.mjs
```

Visually inspect both fresh 1200x720 screenshots for a readable project action,
disabled replay state, intact history/sidebar/summary chrome, and no overlap.
Exercise one real terminal launch in a disposable project and record only
success/failure, never a path, PID, command, or terminal content. Archive this
unchanged kit with its report, validation log, bounded result, and screenshots
under `kit/done/agent-control/` only after every gate passes.

# Contract — terminal-free Windows launch shortcuts

Satisfy the first sufficient level of the packaging stub: launch Agent
Universe Lite from the Windows Desktop or Start menu without opening a
terminal. Stop at per-user shortcuts; do not add login startup, a tray, an
installer, or relocation machinery.

## Editable scope

- `scripts/windows-shortcuts.ps1` (new)
- `docs/WINDOWS-LAUNCH.md` (new)
- `kit/ASSET-REQUESTS.md` — append the missing branded-icon request
- `kit/todo/03-packaging/EXECUTOR-REPORT.md` (new)

`CONTRACT.md`, `RUNNER.md`, and `grade-packaging.mjs` are runner-owned and
frozen once distillation review finishes. Everything else is frozen. In
particular, do not modify `package.json`,
`package-lock.json`, `src/**`, `assets/**`, the mockup PNGs, or any existing
grader. Add no dependency, registry entry, scheduled task, startup shortcut,
tray behavior, electron-builder/NSIS config, or packaged application.

## W1 — direct GUI shortcuts

On Windows, `scripts/windows-shortcuts.ps1` defaults to `Install` and creates
exactly these per-user shortcuts:

- `<DesktopDirectory>/Agent Universe Lite.lnk`
- `<ProgramsDirectory>/Agent Universe Lite/Agent Universe Lite.lnk`

Both must use structured `.lnk` fields:

- target: absolute `node_modules/electron/dist/electron.exe`
- arguments: `.`
- working directory: the canonical repository root
- description: `Launch Agent Universe Lite`
- window style: normal
- icon: the generated support-directory ICO, frame 0

The target must be the direct Windows GUI-subsystem executable, never
`electron.cmd`, Node, `cmd.exe`, PowerShell, or a wrapper script.

## W2 — safe, idempotent lifecycle

The script supports `-Action Install|Uninstall` and stock Windows PowerShell
5.1 without elevation. It derives the repository from `$PSScriptRoot`, but
accepts `-RepositoryRoot`, `-DesktopDirectory`, `-ProgramsDirectory`, and
`-SupportDirectory` overrides so the gate can remain isolated.
Defaults must come from Windows known-folder APIs: the current user's Desktop,
Programs, and `%LOCALAPPDATA%/Agent Universe Lite`, never guessed profile paths.

Install must preflight the repository, package identity, Electron executable,
known-folder destinations, and drawing support before writing. It creates or
rebinds only the two deterministic links and support icon. A second run leaves
the same three artifacts and semantic metadata, with no duplicates.

Uninstall must succeed even when the repository or `node_modules` no longer
exists. It removes only the two exact links and generated icon. It must remove
the app-specific Start-menu/support directories non-recursively when empty;
it must preserve unrelated sentinel content and all parent/user directories.
Repeated uninstall is success.

## W3 — procedural Windows icon

No app-specific ICO exists and `assets/**` is frozen. Generate a deterministic
dark navy/purple/cyan/gold orbit glyph at install time using built-in Windows
drawing APIs. Write a valid PNG-backed ICO with 16, 24, 32, 48, 64, 128, and
256 px 32-bit frames beneath the support directory. Both shortcuts reference
that stable file. Log the desired artist-supplied replacement in
`kit/ASSET-REQUESTS.md`; do not add generated art to `assets/`.

## W4 — documentation and boundaries

`docs/WINDOWS-LAUNCH.md` documents prerequisites, install/uninstall commands,
the two destinations, no-terminal behavior, idempotence, and the requirement
to rerun Install after moving the repo or reinstalling dependencies. It also
states why startup/tray/NSIS/portable packaging is deliberately absent.

The implementation must not use `Invoke-Expression`, shell-built commands,
wildcard deletion, recursive deletion, self-elevation, machine-wide/common
folders, the registry, or user-profile path guessing.

## Gates and live check

From the repository root, both commands must pass:

```powershell
node kit/todo/03-packaging/grade-packaging.mjs
node kit/grade.mjs
```

Then run Install with default destinations, open one resulting shortcut, and
verify an `Agent Universe` window appears with no console window. Re-run
Install once to verify the real destinations remain idempotent. Leave the two
shortcuts installed for normal use. Record the installed link paths, launched
PID/window title, GUI PE subsystem, console-descendant count, and a live window
screenshot as archived evidence.

Archive the kit under `kit/done/packaging/` with its report, validation log,
JSON metrics, generated-icon preview, and live-check evidence after both gates
pass.

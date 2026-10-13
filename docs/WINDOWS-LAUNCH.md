# Launch from Windows without a terminal

For macOS, see [MACOS-LAUNCH.md](MACOS-LAUNCH.md).

Agent Orrery can install per-user shortcuts that launch Electron
directly as a Windows GUI application. After the one-time setup, neither the
Desktop nor Start-menu shortcut opens a terminal window.

## Prerequisite

The repository and its dependencies must already be present. From the
repository root, `node_modules/electron/dist/electron.exe` must exist; run
`npm install` if it does not.

## Install or refresh

Open PowerShell in the repository root and run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows-shortcuts.ps1 -Action Install
```

The command creates or refreshes exactly two shortcuts:

- `Agent Orrery.lnk` on the current user's Desktop
- `Agent Orrery\Agent Orrery.lnk` in the current user's Start
  menu Programs folder

It also creates a deterministic procedural multi-resolution icon under
`%LOCALAPPDATA%\Agent Orrery`. Re-running Install is safe and rebinds
the same shortcuts without creating duplicates.

The links target Electron's GUI executable directly, pass `.` as its argument,
and use this repository as the working directory. They do not invoke a command
shim, Node console process, PowerShell launcher, or terminal wrapper.

## Uninstall

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows-shortcuts.ps1 -Action Uninstall
```

Uninstall removes only the two named links and the generated icon. It does not
delete the repository, user data, parent Desktop/Start-menu folders, or any
unrelated files. It remains safe if `node_modules` or the old repository path
no longer exists, and it can be run repeatedly.

## Repository moves and dependency reinstalls

Windows shortcuts store absolute paths. After moving this checkout, run
Install from the new location to rebind both links. If Electron is removed or
reinstalled at a different location, restore dependencies and run Install
again.

## Deliberate boundary

This is the first sufficient packaging tier for a personal checked-out app.
There is no launch-on-login entry, tray behavior, registry mutation,
electron-builder/NSIS configuration, portable bundle, or 250 MB+ installer.
Those add weight without improving the requested terminal-free local launch.

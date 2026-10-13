# Launch on macOS

Agent Orrery runs on macOS from a checkout with no platform-specific
setup. Transcript discovery, the universe state, and all three views work the
same as on Windows; only the two LIVE-only controls need host support, and both
have macOS implementations.

## Run from a terminal

```sh
npm install
npm start
```

Node.js 22.12 or newer is expected. Electron and Babylon.js install from npm; the app
itself makes no network requests.

## Install a Launchpad / Spotlight / Dock shortcut

Double-click `Install Agent Orrery.command` in the repository root, or run
`npm run setup`. It installs the dependencies when Electron is missing, runs
the install command below, and opens the app. If the folder came from a
downloaded ZIP rather than `git clone`, macOS may block the file the first
time; right-click it and choose **Open**.

To do it by hand, after `npm install`, from the repository root:

```sh
bash scripts/macos-shortcuts.sh install
```

This creates `~/Applications/Agent Orrery.app`, a thin launcher bundle
that runs the Electron binary already inside `node_modules` with this
repository as its argument. It records the absolute repository path at install
time, so re-run Install after moving the checkout or reinstalling Electron.

```sh
bash scripts/macos-shortcuts.sh uninstall
```

Uninstall removes only that bundle, and only if this script created it. It never
deletes the repository, user data, or anything else in `~/Applications`.

The bundle is unsigned. On first launch macOS may ask you to confirm opening an
app from an unidentified developer; right-click the app and choose **Open**.

## Platform behavior

| Feature | Windows | macOS | Linux |
|---|---|---|---|
| Transcript tailing, universe, replay | yes | yes | yes |
| Open Terminal | Windows Terminal (`wt.exe` app alias) | Terminal.app via `/usr/bin/open -a Terminal` | unavailable |
| Start Codex on an IDEAS task | native `codex.exe` on `PATH` or the npm package | native `codex` on `PATH` (Homebrew or npm global) | native `codex` on `PATH` (npm global) |
| Desktop shortcut | `scripts/windows-shortcuts.ps1` | `scripts/macos-shortcuts.sh` | none |

Both controls resolve a fixed executable, never search for shells, never
accept a command from the renderer, and detach immediately. A host without the
required executable reports the control as unavailable inside the project card.

## Portability notes

- The persisted universe state under Electron's user-data directory keys
  projects by canonical path (`win:c:/...` or `posix:/Users/...`). Copying a
  state file between operating systems re-creates every project as new.
- The `--control-test` harness and the archived kit gates under `kit/done/`
  build Windows fixture paths and are expected to run on Windows only. The unit
  tests under `test/` are host-independent.

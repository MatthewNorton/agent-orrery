# Executor Report — Windows launch shortcuts

## Delivered

- `scripts/windows-shortcuts.ps1`: added a dependency-free Windows PowerShell
  5.1 installer/uninstaller for per-user Desktop and Start-menu shortcuts.
  Links target the direct Electron GUI executable with structured arguments and
  working-directory fields. Install is idempotent, rebinding is transactional,
  preflight is write-safe, and uninstall removes only exact owned artifacts.
- The same script generates a deterministic seven-frame PNG-backed ICO under
  LocalAppData using built-in `System.Drawing`; no generated art enters
  `assets/`.
- `docs/WINDOWS-LAUNCH.md`: documents prerequisites, installation, uninstall,
  idempotence, repository moves, and the deliberate no-startup/tray/installer
  boundary.
- `kit/ASSET-REQUESTS.md`: records the desired artist-supplied branded icon and
  the procedural fallback replacement point.

## Mechanical verification

The undistilled baseline failed cleanly only for the missing item-03 script,
documentation, and asset request; the renderer regression passed.

The final isolated Windows gate passed W0–W4. It proved:

- exactly two semantic shortcuts targeting GUI-subsystem `electron.exe` with
  arguments `.`, the canonical working directory, description, normal window
  style, and the generated icon;
- fresh directory creation, omitted-Action default Install, hostile path
  characters, repeat-install idempotence, and repository rebinding;
- a byte-stable 22,550-byte ICO (SHA-256
  `778cac32855578767bb86da3495c0816c6b5857417cd98dc35f0182a38b3f5e4`)
  containing 16/24/32/48/64/128/256 px 32-bit RGBA PNG frames;
- exact-tree allowlists, `.lnk`/`.ico` sentinel preservation, missing-repo
  uninstall, repeated uninstall, empty owned-directory cleanup, and atomic
  failure for missing Electron, wrong package identity, and invalid paths;
- no frozen product/package/assets changes or packaging dependencies.

`node kit/grade.mjs` also passed all renderer mechanical checks after the final
script changes; M5 emitted only its expected soft no-live-ship warning.

## Real default-destination verification

Install ran twice against the actual per-user known folders and left these
normal-use links installed:

- `%USERPROFILE%\Desktop\Agent Universe Lite.lnk`
- `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Agent Universe Lite\Agent Universe Lite.lnk`

After the final transaction revision, Install ran twice again. The Desktop
link then launched PID 18892 as direct `electron.exe .` at
2026-07-21 22:05:37 America/New_York; its visible
window title was `Agent Universe`. Its full descendant tree contained three
Electron processes and zero `cmd`, PowerShell, Node, conhost, or Windows
Terminal processes. The app window was captured in `output/live-window.png`.
The exact test process tree then closed cleanly, leaving zero repo Electron
processes. `output/live-check.json` retains the link metadata, PID/window data,
icon hash, process tree, screenshot dimensions, and cleanup result.

## Scope and deviations

No package metadata, lockfile, source code, assets, mockups, registry entries,
startup entries, scheduled tasks, tray code, builder config, or installer was
added. This deliberately stops at the first sufficient local-launch tier.
There are no hard-contract deviations or known failures.

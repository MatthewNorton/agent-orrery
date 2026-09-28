# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems.

Report vulnerabilities privately through GitHub: open the **Security** tab of this
repository and choose **Report a vulnerability**. That creates a private advisory
that only the maintainer can see.

You can expect an acknowledgement within 7 days.

## Scope

Agent Universe Lite is a local desktop app. It tails Claude Code and Codex
transcript files on the user's own machine and never contacts the network from
the renderer. The security boundary that matters most is **transcript content**:
anything an observed agent writes into a transcript (working directories, file
paths, tool output) is treated as untrusted input. Reports in these areas are
especially welcome:

- Path handling for transcript-supplied working directories (UNC, device, or
  traversal paths).
- The `window.AU` preload bridge and the IPC handlers behind it.
- The two host actions the app can take (opening a terminal, launching Codex on
  a tagged `GOALS.md` item).
- Electron web-contents hardening (CSP, navigation, permissions).

## Supported versions

Only the latest commit on `main` is supported.

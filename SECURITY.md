# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems.

Report vulnerabilities privately through GitHub: open the **Security** tab of this
repository and choose **Report a vulnerability**. That creates a private advisory
that only the maintainer can see.

You can expect an acknowledgement within 7 days.

## Scope

Agent Orrery is a local desktop app. It tails Claude Code and Codex
transcript files on the user's own machine, asks the local Ollama server on
loopback which models are loaded (one `GET /api/ps`, refusable in
`providers.json`; the loopback check is `ollamaEndpoint` in
`src/main/live/ollama-source.js`, and the answer is read under a byte cap),
and never contacts the network from the renderer. The security boundary that matters most is **transcript content**:
anything an observed agent writes into a transcript (working directories, file
paths, tool output) is treated as untrusted input. Those files are also not a
published interface: a record the app does not recognise is skipped, never
guessed at, and a transcript that stops being recognised raises a visible
warning (see `docs/MULTI-PROVIDER.md`). Reports in these areas are
especially welcome:

- Path handling for transcript-supplied working directories (UNC, device, or
  traversal paths).
- The `window.AU` preload bridge and the IPC handlers behind it.
- The two host actions the app can take (opening a terminal, launching Codex on
  a tagged `GOALS.md` item).
- Electron web-contents hardening (CSP, navigation, permissions).

## Supported versions

Only the latest commit on `main` is supported.

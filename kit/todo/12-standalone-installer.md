# Stub — standalone installer (parked: wanted later, not yet)

Goal: a real packaged build — a self-contained `Agent Universe Lite.exe`
(NSIS installer and/or portable exe; macOS `.app`/dmg later) that launches
without a checkout or `node_modules`, like the sibling `agent-universe` app's
`npm run pack:dir` / `npm run dist`.

Why parked: matt wants this eventually, but for now the kit 03 per-user
shortcuts (`scripts/windows-shortcuts.ps1`) are enough. Don't distill until
matt asks for it.

Seed notes:
- Motivating incident (2026-09-27): a stray `pnpm install` moved Electron into
  `node_modules/.ignored`; Windows link tracking silently re-pointed the
  Desktop shortcut there (Start-in became `node_modules`) → "Unable to find
  Electron app". A packaged app removes the dependency on `node_modules`
  entirely. Also observed that day: with Electron 43 (no postinstall) and
  npm 12, `npm ci` left `dist/electron.exe` missing and
  `npm exec --no -- install-electron` restored it (unverified whether
  `npm start` also fetches it lazily).
- Reference config: `../agent-universe/package.json` `build` key
  (electron-builder: `nsis` + `portable`, per-user, `artifactName` patterns).
- Gates that must be amended in the same change, or they fail:
  - `kit/done/packaging/grade-packaging.mjs` W4 rejects any
    electron-builder/packager/forge/nsis dependency, a `build` key, or
    `packagerConfig` in package.json; its docs check also expects
    `docs/WINDOWS-LAUNCH.md` to explain the no-installer boundary.
  - `kit/done/agent-control/grade-control.mjs` and
    `kit/done/history-playback/grade-history.mjs` pin package.json's SHA-256.
- Keep persisted state: `userData` derives from `app.getName()` (package
  `name`, or top-level `productName` if set). Adding a top-level `productName`
  would move `universe-state.json` to a new directory — put the display name
  under the builder config only, and verify the packaged app reads the
  existing state.
- Packaging inputs: `src/`, the frozen `assets/` library (~134 MB, full set,
  never trimmed), Babylon UMD bundles from `node_modules`. Check that asar
  paths work for the renderer's `file://` loads, the GLB ship assets, and
  `window-security.js` trusted-frame validation.
- Icon: needs the `agent-universe-windows-icon` from `kit/ASSET-REQUESTS.md`
  (today's ICO is generated at shortcut-install time, not a repo asset).
- Trade-off to state in the contract: a packaged build is a snapshot, so it
  must be rebuilt after each pull; the shortcuts always run the checkout.
  Unsigned builds trigger SmartScreen / Gatekeeper prompts.

Status: parked. Not distilled.

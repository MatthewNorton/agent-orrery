# Runner — safe terminal launch action

1. Confirm `node kit/grade.mjs` passes before implementation.
2. Run `node grade-control.mjs`; the distilled baseline must fail cleanly on
   missing `src/main/terminal-launcher.js` before Electron launches.
3. Review and freeze `CONTRACT.md`, this runner, and `grade-control.mjs`.
   Implement only the editable scope; do not modify tracking, replay parsing,
   renderer HTML, scenes, package manifests, dependencies, scripts, assets, or
   prior gates.
4. Pass the isolated adapter checks first. Include an adversarial cwd,
   unsupported platform, missing app alias, exact Windows Terminal argv,
   no PATH fallback, `shell:false`, and immediate `unref()`.
5. Wire the main-frame-only IPC to the live Tracker, then add the one-argument
   preload method. Prove invalid/deleted/replay calls never reach the launcher.
6. Add the one-button project-card UI and its busy, failure, and
   replay-disabled states. Keep Open Folder first; add no prompt or provider
   control and do not touch scene code.
7. Pass the real Electron control proof and inspect its two fresh 1200x720
   screenshots. Confirm isolated mode opened no real terminal.
8. Run the item gate and every regression command in the contract.
9. Manually open one terminal in a disposable live project. Confirm the app
   retains no lifecycle controls or PID and nothing launches during replay.
10. Write `EXECUTOR-REPORT.md` and `VALIDATION.md`, retain bounded artifacts,
    move this directory unchanged to `kit/done/agent-control/`, remove the
    numbered stub, and update status boards and the live spec.

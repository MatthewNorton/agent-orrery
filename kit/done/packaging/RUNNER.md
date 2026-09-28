# Runner — Windows launch shortcuts

1. Confirm `node kit/grade.mjs` passes before implementation.
2. Run `node grade-packaging.mjs`; the distilled baseline must fail only for
   missing item-03 implementation artifacts.
3. Implement only the files unfrozen by `CONTRACT.md`; the grader is frozen.
4. Iterate until the item gate and permanent renderer regression both pass.
5. Inspect the generated icon preview, then exercise the default installer and
   launch a real shortcut without a console window.
6. Write `EXECUTOR-REPORT.md`, archive this kit under `kit/done/packaging/`,
   retain the real shortcuts for the user, and update kit status boards.

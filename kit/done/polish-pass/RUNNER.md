# Runner — polish pass

1. Confirm `node kit/grade.mjs` passes before implementation.
2. Run `node grade-polish.mjs`; the undistilled baseline must fail cleanly.
3. Implement only the files unfrozen by `CONTRACT.md`.
4. Iterate until both the item grader and `node kit/grade.mjs` pass.
5. Inspect the generated screenshots in `.shots/polish/` for label clarity,
   near-black backdrop, intact foreground glow, and correct view chrome.
6. Write `EXECUTOR-REPORT.md`, retain this kit under
   `kit/done/polish-pass/`, and update the kit status boards.

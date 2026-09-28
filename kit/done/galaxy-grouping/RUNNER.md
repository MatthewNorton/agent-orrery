# Runner — galaxy grouping

1. Confirm `node kit/grade.mjs` passes before implementation.
2. Run `node grade-galaxies.mjs`; the distilled baseline must fail cleanly
   before Electron launches.
3. Freeze `CONTRACT.md`, this runner, and `grade-galaxies.mjs`. Implement only
   files unfrozen by the contract; never modify the gate to fit the product.
4. Iterate until the item gate, archived polish gate, and global regression
   gate all pass.
5. Inspect the item grader's fresh screenshots for obvious separated galaxy
   regions, correct labels/counts, readable systems, near-black contrast, and
   intact hover/click navigation.
6. Exercise one actual-profile launch/restart and record its galaxy metrics and
   screenshot in the validation log.
7. Write `EXECUTOR-REPORT.md`, retain proof artifacts, move this directory
   unchanged to `kit/done/galaxy-grouping/`, remove the numbered stub, and
   update the kit status boards and live spec.

# Validation — safe terminal launch action

Date: 2026-07-21
Result: **PASS**

## Distillation baseline

```text
node kit/todo/07-agent-control/grade-control.mjs
FAIL C0: missing src/main/terminal-launcher.js

node kit/grade.mjs
PASS all mechanical checks green
```

The baseline control failure occurred before Electron launch, profile access,
or Windows Terminal discovery. Frozen input hashes match the executor report.

## Final gates

```text
node kit/done/agent-control/grade-control.mjs
PASS C1-C5 safe terminal action checks green

node kit/done/history-playback/grade-history.mjs
PASS H1-H5 history playback checks green

node kit/done/multi-provider/grade-providers.mjs
PASS V1-V5 passive multi-provider checks green

node kit/done/attention/grade-attention.mjs --fixtures-only
PASS A1-A2 attention fixtures

node kit/done/galaxy-grouping/grade-galaxies.mjs
PASS G1-G4 galaxy grouping checks green

node kit/done/polish-pass/grade-polish.mjs
PASS P1-P4 polish checks green

node kit/grade.mjs
PASS all mechanical checks green
```

JavaScript syntax checks and `git diff --check` also passed.

## Rendered proof

`output/result.json` records:

- exact 1200x720 window size;
- actual pointer input for all four required steps;
- one terminal action in both system and planet views;
- zero terminal-control overlaps and zero clipped control rectangles;
- exact replay-disabled note and one blocked replay launch count;
- safe fixed Windows Terminal specification and canonical cwd equality;
- two child `unref()` calls for two explicit LIVE launch requests;
- pending/busy state preserved across a forced project-card rerender;
- no provider/prompt controls and no renderer errors.

`output/control-live.png` and `output/control-replay.png` were inspected at
original resolution. Text, disabled state, status, sidebar, summaries, and
history chrome are readable and intact.

## Real smoke

The fixed Windows Terminal app alias resolved successfully. One adapter launch
in a disposable empty directory returned `{ok:true}`. No path, executable,
arguments, PID, terminal content, or environment was recorded, and the terminal
was not monitored or terminated by Agent Universe.

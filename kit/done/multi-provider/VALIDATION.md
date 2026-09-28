# Validation log — Item 05

Date: 2026-07-21 (America/New_York)

## Frozen inputs

```text
CONTRACT.md         CE79B1A446F4EC9FA3C590A69A3E90CBC1D7C4B62F3458EB070F1444D59ED046
RUNNER.md           0032B40ABCDA3082E4D7E0388CEDC11252D37C11AF7065972D3280073687E3CD
grade-providers.mjs 64DF2FAA2F80745163DA261C903C4E96F4C7A8B4D32F99DA033CF34FFE062F55
```

The distilled baseline failed cleanly on missing
`src/main/provider-adapters.js`; `node kit/grade.mjs` passed before product
edits. The three hashes above remained unchanged through implementation.

## Final commands

| Command | Result |
|---|---|
| `node kit/todo/05-multi-provider/grade-providers.mjs` | PASS V1–V5 |
| `node kit/todo/05-multi-provider/edge-validation.mjs` | PASS all five edge summaries |
| `node kit/done/attention/grade-attention.mjs --fixtures-only` | PASS 15/15 |
| `node kit/done/galaxy-grouping/grade-galaxies.mjs` | PASS G1–G4 |
| `node kit/done/polish-pass/grade-polish.mjs` | PASS P1–P4; 3/30 labels, median luma 22.2, p90 42.4 |
| `node kit/grade.mjs` | PASS; universe/system/planet captured |

## Rendered proof

`output/result.json` is derived from actual public tracker state, sidebar DOM,
Babylon ship meshes, and material emissive colors at the minimum 1200×720
window. It records:

- public counts: Claude 1, Codex 1, generic 1;
- mesh counts: Claude 1, Codex 1, generic 1;
- three distinct provider colors and zero material-color mismatches;
- exact tags `CLAUDE`, `CODEX`, `SIGNAL`;
- exact badge `MULTI-PROVIDER`;
- at least one provider tag in an attention row;
- zero renderer errors.

Visual inspection of `output/universe.png` found the top badge, recent strip,
provider tags, Question badge, three hull hue families, sidebar, feed, summary,
system glyph, and galaxy region readable with no clipping or chrome overlap.

## Real-profile proof

The final global Electron run's snapshot was reduced to count-only evidence in
`output/real-profile-summary.json`: 46 projects, two Codex ships (one main and
one drone), and no duplicate canonical projects. No paths or transcript text
were copied into the item archive.

# Stub — locally generated ship hulls (phase 2 of the hybrid ship plan)

Goal: replace/augment the CC0 pack hulls (kit 08) with unique hulls generated
on matt's own rig, one provider family at a time, with zero code changes.

Seed notes:
- The manifest indirection from kit 08 is the whole trick:
  `assets/ships/manifest.json` maps provider → hull family → .glb files with
  per-hull correction data. Generated hulls that satisfy the same schema drop
  straight in; `grade-ships.mjs` S3/S4 (with the CC0 check relaxed to
  `license: "local-gen"`) still applies.
- Pipeline: ComfyUI image-to-3D (Hunyuan3D-class) — concept sheet per provider
  (silhouette language: e.g. Claude = sleek courier, Codex = angular
  industrial, Signal = utility probe) → glb export → QA pass.
- QA rubric (the frontier work at distill time): silhouette readable at 64 px;
  ≤ 8k triangles; single material group; watertight enough to light; correct
  after manifest correction (facing +Z, length 1). Reject examples matter —
  image-to-3D fails ugly (holes, bacon-strip topology, baked shadows).
- Also generate here: the `agent-universe-windows-icon` from
  `kit/ASSET-REQUESTS.md` if kit 08's optional Phase 3 didn't resolve it.
- Grading can reuse matt's judge-panel skill for the visual pass.

Status: not distilled. Run /distill on this file AFTER kit 08 lands — the
manifest contract it establishes is a prerequisite.

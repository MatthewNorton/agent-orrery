# TODO — pending kits and backlog, in intended order

## Pending kits

| # | Item | State |
|---|---|---|
| 09 | `09-ship-assets-gen.md` — locally generated hulls (ComfyUI image-to-3D) | stub — Kit 08's manifest contract has landed; ready to distill |
| 12 | `12-standalone-installer.md` — packaged exe/installer independent of the checkout | parked — wanted later, not yet; don't distill until matt asks |
| 13 | `13-structural-cleanup.md` — split `app.js` into `AUR.app` modules, one path classifier, observable-driven scene dispose | **ready for Codex** — distilled 2026-09-27; gate `grade-structure.mjs` beside it; executor prompt in §7 |

Feed a ready kit to an executor via `kit/EXECUTOR-HANDOFF.md` with its
CONTRACT.md path.

Completed:

- 01 needs-attention detection + UI — **PASS 2026-07-21**; archived under
  `../done/attention/` with its contract, grader, and executor report.
- 02 renderer polish pass — **PASS 2026-07-21**; archived under
  `../done/polish-pass/` with its contract, grader, report, metrics, and images.
- 03 Windows launch shortcuts — **PASS 2026-07-21**; archived under
  `../done/packaging/` with its contract, grader, icon, and live-launch proof.
- 04 galaxy grouping — **PASS 2026-07-21**; archived under
  `../done/galaxy-grouping/` with its contract, grader, rendered metrics,
  screenshots, and restart-stability proof.
- 05 passive multi-provider agents — **PASS 2026-07-21**; archived under
  `../done/multi-provider/` with its contract, grader, edge validation,
  minimum-size rendered proof, and count-only real-profile evidence.
- 06 history playback — **PASS 2026-07-21**; archived under
  `../done/history-playback/` with its frozen contract, deterministic replay
  gate, four minimum-size screenshots, and count-only real-profile proof.
- 07 safe terminal action — **PASS 2026-07-21**; archived under
  `../done/agent-control/` with its frozen contract, isolated no-shell gate,
  two minimum-size screenshots, and bounded real Windows Terminal smoke proof.
- 08 realistic CC0 provider ship hulls — **PASS 2026-07-26**; archived under `../done/ship-assets-pack/` with its frozen contract, grader, executor report, ten curated hulls, and manifest-backed fallback integration.
- 10 per-project task lists — **PASS 2026-07-22**; archived under
  `../done/project-tasks/` with its frozen contract, grader, executor report,
  and real UI-to-`GOALS.md` polling/prose-preservation proof.
- 11 project search — **PASS 2026-07-22**; archived under
  `../done/project-search/` with its frozen contract, grader, executor report,
  and real minimum-size keyboard/navigation/dimming proof.

A **stub** is a parked idea with goal + seed notes — not executable. To
activate one: run `/distill` on the stub file to produce a full kit (contract +
mechanical grader), then hand it to an executor.

Baseline invariant while anything here is in flight: `node kit/grade.mjs`
must stay green.

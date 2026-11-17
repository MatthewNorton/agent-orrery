# TODO — pending kits and backlog, in intended order

## Pending kits

| # | Item | State |
|---|---|---|
| 09 | `09-ship-assets-gen.md` — locally generated hulls (ComfyUI image-to-3D) | stub — Kit 08's manifest contract has landed; ready to distill |
| 12 | `12-standalone-installer.md` — packaged exe/installer independent of the checkout | declined 2026-10-13 — the users are developers, `npm run setup` is the install path; don't distill unless matt asks |
| 16 | `16-idle-cap-and-glyphs.md` — idle frame cap, universe glyph consolidation, Ultra tier | stub — split from the old kit-15 stub 2026-11-01 |
| 17 | `17-ollama-source/CONTRACT.md` — local model ships: a server-agnostic `local` provider with Ollama as its first adapter; a model loaded in Ollama is a red hull with its model name | **ready** — distilled 2026-11-04, re-cut 2026-11-06 (provider key `local`, not `ollama`); gate `17-ollama-source/grade-ollama.mjs`; O0 kill-switch needs the owner at the keyboard |

Feed a ready kit to an executor via `kit/EXECUTOR-HANDOFF.md` with its
CONTRACT.md path.

Completed kits and their gates are listed in `../README.md`. Their contracts and
executor reports were removed once the kits shipped; `git log -- kit/done` finds them.

A **stub** is a parked idea with goal + seed notes — not executable. To
activate one: run `/distill` on the stub file to produce a full kit (contract +
mechanical grader), then hand it to an executor.

Baseline invariant while anything here is in flight: `node kit/grade.mjs`
must stay green.

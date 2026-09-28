# Executor report — passive multi-provider agents

Status: **PASS** on 2026-07-21.

## What shipped

- Added `src/main/provider-adapters.js`, a bounded structural adapter for
  Codex rollout records plus validated generic watch configuration. Prompt,
  reasoning, command, argument, result, patch-body, and generic-log content
  never enter the public event vocabulary.
- Extended `src/main/tracker.js` to discover Claude, Codex active/archive
  rollouts, and explicitly configured Signal directories. Canonical cwd keys
  merge providers into one project, aliases persist, Codex main/subagent ships
  remain provider-qualified, patch completions grow the existing planet
  buckets, and archive moves retain cursor/dedupe state.
- Kept Claude's public IDs and parsing behavior compatible while adding the
  always-present `provider` field to every public ship.
- Added provider palettes and safe normalization in `src/renderer/util.js`.
  Claude uses purple variants, Codex cyan/blue variants, and Signal
  amber/neutral variants in every scene and sidebar glyph.
- Replaced the Claude-only badge with `MULTI-PROVIDER`; ACTIVE AGENTS rows now
  include compact `CLAUDE`, `CODEX`, or `SIGNAL` tags without displacing the
  existing attention badge.
- Added actual Babylon mesh/material provider evidence to all three scenes and
  an isolated minimum-size Electron provider harness in `src/main/main.js`.
- Documented native discovery and the optional metadata-only `providers.json`
  format in `docs/MULTI-PROVIDER.md`.

No dependency, preload API, asset, mockup, provider process, transcript, or
archived grader was changed.

## Privacy and lifecycle checks

- Generic watches were guarded so opening their log file would throw; the
  validation passed, proving only directory entries and file stats are read.
- Copied parent records in a Codex subagent rollout were ignored until the
  child's matching metadata appeared.
- Moving an active rollout into the archive kept one ship and one cursor;
  replaying the same patch call did not double-count it.
- Partial lines are bounded to 1 MiB and per-poll reads remain capped at 8 MiB.
- Provider test failure cleanup stops the tracker and removes its isolated
  temporary profile before the nonzero Electron exit.

## Runner verification

All required gates passed from the repository root:

```text
node kit/todo/05-multi-provider/grade-providers.mjs
PASS V1-V5 passive multi-provider checks green

node kit/done/attention/grade-attention.mjs --fixtures-only
PASS all mechanical checks green (15/15 fixtures)

node kit/done/galaxy-grouping/grade-galaxies.mjs
PASS G1-G4 galaxy grouping checks green

node kit/done/polish-pass/grade-polish.mjs
PASS P1-P4 polish checks green

node kit/grade.mjs
PASS all mechanical checks green
```

The dedicated edge validation also passed copied-parent suppression,
active-to-archive cursor continuity, build dedupe, generic content non-read,
and six provider tool classes.

At 1200×720 the isolated rendered proof showed exactly one Claude, one Codex,
and one Signal public ship and hull, three distinct correct hull colors, all
three provider tags, the exact `MULTI-PROVIDER` badge, and a Claude Question
attention badge coexisting with its provider tag. No renderer errors or color
mismatches were recorded.

The real-profile Electron run recorded count-only evidence: 46 projects, one
current Codex main ship, one current Codex subagent drone, and zero duplicated
canonical project paths. No transcript content, session IDs, project paths, or
prompt text was retained in the proof artifact.

## Known limits

- Signal watches are configured on disk and require an app restart; there is
  intentionally no settings UI.
- Generic logs provide only content-free activity/liveness. They cannot infer
  builds, subagents, attention, or completion.
- This item observes agents only. Playback and launch controls remain separate
  numbered items.

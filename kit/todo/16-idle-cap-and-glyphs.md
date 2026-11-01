# Stub — idle frame cap, universe glyph consolidation, Ultra tier

Split out of the old `15-visual-quality.md` stub on 2026-11-01, when its planet and sun work became
kit 15 (shipped; its gate lives in `kit/done/procedural-worlds/`). These three items are performance work, independent of the new
look. Each waits for the owner's word; run /distill on this file to activate one.

## Measurements (2026-10-18, owner's machine: Radeon 890M iGPU, 4K at 125%)

Synthetic profile padded to 40 projects, driven over the DevTools protocol. Every view holds a
vsync-locked 60 fps at every tier, even with an emulated 3840×2160 viewport, so the cost is
per-object work and idle power, not pixels.

| View | GPU ms at 2082×1180 | GPU ms at 4K, High | Draw calls | Meshes / materials |
|---|---|---|---|---|
| Universe, 40 projects | 3.6 | 6.4 | 684 | 466 / 396 |
| System | 1.5 | 3.3 | 56 | 28 / 46 |
| Planet | 1.5 | 4.7 | 30 | 15 / 19 |

Idle on the universe view: ~62% of one core, ~19% of the GPU, 557 MB. Low vs High barely moves
the GPU at window size.

## Items

1. **Idle frame cap** (~2 h). A "Reduce frame rate when idle" toggle:
   - full rate during input, then a 1 s grace and camera coasting
   - ~30 fps idle, ~15 fps unfocused
   - each view keeps its own delta time from `performance.now()`, because `engine.getDeltaTime()`
     keeps ticking on skipped frames
   - off in test mode
2. **Universe glyph consolidation** (~3 h, identical image, ~40% fewer universe draws):
   - shared dot materials
   - rings as one line system, dots as thin instances
   - raymarch clipped to the r ≤ 24 cylinder
   - front faces culled instead of discarded
3. **Ultra tier** for discrete GPUs:
   - steps 64, glow ratio 1.0
   - 4096×2048 active-planet map (kit 15 caps generation at 2048×1024, so this widens that bound),
     1024×512 system maps, 96 segments
   - ~130 MB VRAM per 4096 world with mips; generation about 4× slower than 2048

Status: not distilled.

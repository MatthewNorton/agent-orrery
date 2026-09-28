# Asset requests

Wants discovered during the build that `assets/` doesn't cover. The build never
blocks on these — code uses a procedural fallback and the want is logged here
for a later asset pass.

Format per entry:

```
## <short-name>
- Purpose: what it's for, which view
- Suggested spec: format, dimensions, style notes
- Plugs in at: file/function where the fallback lives
```

## agent-universe-windows-icon
- Purpose: Branded icon for the Agent Universe Lite Desktop and Start-menu
  shortcuts.
- Suggested spec: Transparent multi-resolution Windows `.ico` with 16, 24,
  32, 48, 64, 128, and 256 px 32-bit RGBA frames, matching the dark
  navy/purple/cyan/gold universe UI.
- Plugs in at: `scripts/windows-shortcuts.ps1` in
  `New-AgentUniverseIcon`; until supplied, that function generates the
  deterministic orbit-glyph fallback outside the repository.

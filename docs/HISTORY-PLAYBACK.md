# History playback

Agent Orrery can reconstruct an earlier universe from the append-only
records already written by Claude Code and Codex. The history bar stays at the
bottom of every view: drag the timeline to seek, use Play/Pause, cycle through
`1x`, `10x`, `100x`, and `1000x`, or select **LIVE** to return to current
activity.

Playback is observational. Claude project JSONL and Codex active or archived
rollouts are opened read-only; Agent Orrery never writes, modifies, moves,
or acknowledges provider records. Prompt text, reasoning, commands, tool
arguments/results, and patch bodies do not enter the renderer. Generic Signal
watches are deliberately excluded because their content-free file statistics
do not contain a historical event stream.

The live tracker continues running in the background during replay. Selecting
LIVE atomically installs a fresh snapshot, so provider activity that arrived
while history was visible appears immediately. Historical attention never
creates desktop notifications.

Indexing uses bounded head and tail reads to discover each source's time range,
then reads selected records lazily. A replay captures each file's current byte
length; later appends become available after a new index, while the current
playback remains deterministic. Large profiles may take a moment to index, and
the controls remain disabled until a valid range is available.

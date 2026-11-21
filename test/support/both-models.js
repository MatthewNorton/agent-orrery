'use strict';

// One transcript fed to the live Tracker and to the history ReplaySource, for the tests that
// compare the two models.

const fs = require('node:fs');
const path = require('node:path');
const { SEC, T0, CODEX_SESSION, TASK_ID, appendJsonl, createWorld, claude, codex } = require('./transcripts');

function claudeSession(dir, root) {
  return [
    claude.prompt(dir, T0),
    claude.tool(dir, T0 + 1 * SEC, 'toolu_read', 'Read', { file_path: path.join(dir, 'src', 'a.js') }),
    claude.result(dir, T0 + 2 * SEC, 'toolu_read'),
    claude.tool(dir, T0 + 3 * SEC, 'toolu_edit', 'Edit', { file_path: path.join(dir, 'src', 'a.js') }),
    claude.result(dir, T0 + 4 * SEC, 'toolu_edit'),
    claude.tool(dir, T0 + 5 * SEC, 'toolu_write', 'Write', { file_path: path.join(dir, 'notes.md') }),
    claude.result(dir, T0 + 6 * SEC, 'toolu_write'),
    claude.tool(dir, T0 + 7 * SEC, 'toolu_out', 'Edit', { file_path: path.join(root, 'elsewhere', 'x.js') }),
    claude.result(dir, T0 + 8 * SEC, 'toolu_out'),
    claude.tool(dir, T0 + 9 * SEC, 'toolu_mcp', 'mcp__probe__lookup', {}),
    claude.result(dir, T0 + 10 * SEC, 'toolu_mcp'),
    claude.tool(dir, T0 + 11 * SEC, 'toolu_task', 'Task', { description: 'Survey' }),
    claude.result(dir, T0 + 12 * SEC, 'toolu_task'),
    claude.turnDone(dir, T0 + 13 * SEC),
    claude.prompt(dir, T0 + 14 * SEC, 'next'),
  ];
}

function codexSession(dir) {
  return [
    codex.meta(T0, CODEX_SESSION, dir),
    codex.event(T0 + 1 * SEC, 'task_started'),
    codex.userText(T0 + 2 * SEC, `agent-universe:${TASK_ID}`),
    codex.call(T0 + 3 * SEC, 'call-exec', 'exec_command'),
    codex.output(T0 + 4 * SEC, 'call-exec'),
    codex.patchCall(T0 + 5 * SEC, 'call-patch'),
    codex.patched(T0 + 6 * SEC, 'call-patch', [path.join(dir, 'src', 'x.js')]),
    codex.patchOutput(T0 + 7 * SEC, 'call-patch'),
    codex.event(T0 + 8 * SEC, 'task_complete'),
  ];
}

// Live sees the first record at startup (tailed from EOF) and the rest in one
// poll at the last record's time; replay seeks to the first record and
// advances to the same time.
async function runBoth(t, { provider = 'claude', records, cwd } = {}) {
  const world = createWorld(t);
  const build = records || (provider === 'claude' ? claudeSession : codexSession);
  const lines = build(cwd || world.projectDir, world.root);
  const end = Date.parse(lines.at(-1).timestamp);
  const file = provider === 'claude' ? world.claudeFile() : world.codexFile();

  appendJsonl(file, lines.slice(0, 1), T0);
  const startupBytes = fs.statSync(file).size;
  const live = world.live();
  live.tracker.scan(true);
  live.take();
  world.clock.set(end);
  appendJsonl(file, lines.slice(1), end);
  live.tracker.pollFiles();
  const liveEvents = live.take();

  const replay = world.replay();
  await replay.source.index();
  await replay.source.seek(T0);
  replay.take();
  await replay.source.advanceTo(end);
  const replayEvents = replay.take();

  return {
    world,
    startupBytes,
    live: { tracker: live.tracker, events: liveEvents, snapshot: live.tracker.snapshot() },
    replay: { source: replay.source, events: replayEvents, snapshot: replay.source.snapshot() },
  };
}

module.exports = { runBoth };

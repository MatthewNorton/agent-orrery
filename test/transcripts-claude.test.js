'use strict';

// src/main/transcripts/claude.js: a tool's file path is checked once, here, for the live Tracker
// and the history ReplaySource alike.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { claudeRecordToSignals } = require('../src/main/transcripts/claude');
const { SEC, T0, ofType, claude } = require('./support/transcripts');
const { runBoth } = require('./support/both-models');

// The tool-start signal of one tool_use block with `input`.
const toolStart = (input, name = 'Edit') => claudeRecordToSignals(claude.tool('/work/demo', T0, 'toolu_1', name, input))
  .find((signal) => signal.type === 'tool-start');

test('claude adapter: a file path is trimmed and checked; one it refuses names no file and no detail', () => {
  assert.equal(toolStart({ file_path: '\r\n /work/demo/src/a.js \n' }).filePath, '/work/demo/src/a.js');
  for (const bad of ['/work/a\0b.js', '/work/a\rb.js', '/work/a\nb.js', '/work/' + 'a'.repeat(5000), ' \r\n ']) {
    const signal = toolStart({ file_path: bad, pattern: 'needle', description: 'what' });
    assert.deepEqual([signal.filePath, signal.detail], [null, null], JSON.stringify(bad.slice(0, 20)));
  }
  // Only a tool that names no file at all shows its pattern or description.
  assert.deepEqual([toolStart({ pattern: 'needle' }, 'Grep').detail, toolStart({ description: 'Survey' }, 'Task').detail,
    toolStart({ file_path: 7, pattern: 'needle' }, 'Grep').detail], ['needle', 'Survey', 'needle']);
});

test('claude adapter: both models build the same from paths it keeps, trimmed, and nothing from those it refuses', async (t) => {
  const { live, replay } = await runBoth(t, {
    records: (dir) => [
      claude.prompt(dir, T0),
      ...['bad\0dir', 'bad\rdir', 'bad\ndir'].map((folder, index) => claude.tool(dir, T0 + (1 + index) * SEC, `toolu_u${index}`, 'Edit',
        { file_path: path.join(dir, folder, 'a.js') })),
      claude.tool(dir, T0 + 4 * SEC, 'toolu_long', 'Edit', { file_path: path.join(dir, 'long', 'a'.repeat(5000)) }),
      // A CR, LF or space at either end is trimmed before the check, so this path builds.
      claude.tool(dir, T0 + 5 * SEC, 'toolu_edge', 'Edit', { file_path: `\r\n ${path.join(dir, 'edge', 'a.js')} \n` }),
      claude.tool(dir, T0 + 6 * SEC, 'toolu_ok', 'Write', { file_path: path.join(dir, 'src', 'a.js') }),
    ],
  });
  const builds = (events) => ofType(events, 'build').map((event) => [event.bucket, event.file.replaceAll('\\', '/')]);
  assert.deepEqual(builds(live.events), [['edge', 'edge/a.js'], ['src', 'src/a.js']]);
  assert.deepEqual(builds(replay.events), builds(live.events));
  assert.deepEqual([live.snapshot.projects[0].totalBuilds, replay.snapshot.projects[0].totalBuilds], [2, 2]);
});

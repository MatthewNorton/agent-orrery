// Additional isolated lifecycle/privacy proof retained with Item 05.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const require = createRequire(import.meta.url);
const { Tracker } = require(path.join(root, 'src', 'main', 'tracker.js'));
const {
  adaptLine, createAdapterState, classifyTool,
} = require(path.join(root, 'src', 'main', 'provider-adapters.js'));

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'au-provider-edge-'));
try {
  const childId = '019f0000-0000-7000-8000-000000000055';
  const parentId = '019f0000-0000-7000-8000-000000000044';
  let adapterState = createAdapterState('codex', { sessionId: childId });
  const adapt = (record) => {
    const result = adaptLine('codex', JSON.stringify(record), adapterState, { now: Date.now() });
    adapterState = result.state;
    return result.signals;
  };
  assert.equal(adapt({ type: 'session_meta', payload: {
    id: parentId, session_id: parentId, cwd: 'C:\\parent', thread_source: 'user',
  } }).length, 0);
  assert.equal(adapt({ type: 'event_msg', payload: {
    type: 'patch_apply_end', success: true, call_id: 'parent-call',
    changes: { 'C:\\parent\\secret.js': { type: 'update' } },
  } }).length, 0);
  assert.equal(adapt({ type: 'session_meta', payload: {
    id: childId, session_id: parentId, cwd: 'C:\\child',
    source: { subagent: {} }, parent_thread_id: parentId,
  } })[0]?.kind, 'drone');

  const expectedTools = new Map([
    ['exec', 'Gathering Resources'], ['wait', 'Gathering Resources'],
    ['browser', 'Scanning'], ['create_goal', 'Planning'],
    ['list_files', 'Exploring'], ['request_user_input', 'Working'],
  ]);
  for (const [tool, status] of expectedTools) assert.equal(classifyTool(tool).status, status);
  assert.equal(classifyTool('request_user_input').tool, 'AskUserQuestion');

  const projectDir = path.join(temp, 'workspace', 'project');
  const activeRoot = path.join(temp, 'sessions');
  const archiveRoot = path.join(temp, 'archived');
  const rolloutDir = path.join(activeRoot, '2026', '07', '21');
  const archiveFile = path.join(archiveRoot, `rollout-${childId}.jsonl`);
  const activeFile = path.join(rolloutDir, `rollout-${childId}.jsonl`);
  fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
  fs.mkdirSync(rolloutDir, { recursive: true });
  fs.writeFileSync(activeFile, JSON.stringify({
    timestamp: new Date().toISOString(), type: 'session_meta',
    payload: { id: childId, session_id: childId, cwd: projectDir, source: 'cli' },
  }) + '\n');
  const tracker = new Tracker(path.join(temp, 'state.json'), {
    claudeProjectsDir: path.join(temp, 'no-claude'),
    codexSessionDirs: [activeRoot, archiveRoot],
    providerConfigPath: path.join(temp, 'no-providers.json'),
  });
  tracker.scan(true);
  const appendBuild = (file, callId, changedFile) => fs.appendFileSync(file, [
    { timestamp: new Date().toISOString(), type: 'response_item', payload: {
      type: 'custom_tool_call', call_id: callId, name: 'apply_patch', input: 'discarded',
    } },
    { timestamp: new Date().toISOString(), type: 'event_msg', payload: {
      type: 'patch_apply_end', call_id: callId, success: true,
      changes: { [changedFile]: { type: 'update', content: 'discarded' } },
    } },
    { timestamp: new Date().toISOString(), type: 'response_item', payload: {
      type: 'custom_tool_call_output', call_id: callId, output: 'discarded',
    } },
  ].map(JSON.stringify).join('\n') + '\n');
  appendBuild(activeFile, 'build-one', path.join(projectDir, 'src', 'one.js'));
  tracker.pollFiles();
  assert.equal(tracker.snapshot().projects[0].totalBuilds, 1);

  fs.mkdirSync(archiveRoot, { recursive: true });
  fs.renameSync(activeFile, archiveFile);
  tracker.scan(false);
  appendBuild(archiveFile, 'build-one', path.join(projectDir, 'src', 'one.js'));
  appendBuild(archiveFile, 'build-two', path.join(projectDir, 'src', 'two.js'));
  tracker.pollFiles();
  const afterMove = tracker.snapshot();
  assert.equal(afterMove.projects[0].totalBuilds, 2);
  assert.equal(afterMove.ships.filter((ship) => ship.provider === 'codex').length, 1);

  const signalDir = path.join(temp, 'signals');
  const signalProject = path.join(temp, 'workspace', 'signal');
  const signalFile = path.join(signalDir, 'private.log');
  const signalConfig = path.join(temp, 'providers.json');
  fs.mkdirSync(signalDir, { recursive: true });
  fs.mkdirSync(signalProject, { recursive: true });
  fs.writeFileSync(signalFile, 'PRIVATE_GENERIC_BYTES');
  fs.writeFileSync(signalConfig, JSON.stringify({ watch: [{
    directory: signalDir, projectPath: signalProject,
  }] }));
  const originalRead = fs.readFileSync;
  fs.readFileSync = function guardedRead(file, ...args) {
    if (path.resolve(String(file)) === path.resolve(signalFile)) {
      throw new Error('generic log content was read');
    }
    return originalRead.call(this, file, ...args);
  };
  try {
    const signalTracker = new Tracker(path.join(temp, 'signal-state.json'), {
      claudeProjectsDir: path.join(temp, 'no-claude'), codexSessionDirs: [],
      providerConfigPath: signalConfig,
    });
    signalTracker.scan(true);
    assert.equal(signalTracker.snapshot().ships[0]?.provider, 'generic');
  } finally {
    fs.readFileSync = originalRead;
  }

  console.log(JSON.stringify({
    copiedParentSuppressed: true,
    activeArchiveBuilds: 2,
    activeArchiveShips: 1,
    genericContentRead: false,
    toolClassesChecked: expectedTools.size,
  }, null, 2));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

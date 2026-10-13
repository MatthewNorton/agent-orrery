'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ReplaySource } = require('../src/main/replay-source');
const { inspectClaudeFile } = require('../src/main/history/index-builder');
const { safeTimestamp } = require('../src/main/history/jsonl');

function createFixture(t, name = 'timeline-project') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-universe-replay-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectDir = path.join(root, 'workspace', name);
  const claudeRoot = path.join(root, '.claude', 'projects');
  const sessionDir = path.join(claudeRoot, name);
  fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  return { root, projectDir, claudeRoot, sessionDir };
}

function createSource(t, claudeRoot, now, codexSessionDirs = []) {
  const source = new ReplaySource({
    claudeProjectsDir: claudeRoot,
    codexSessionDirs,
    now: () => now,
  });
  t.after(() => source.stop());
  return source;
}

test('cold seek streams a dense history without retaining its full record prefix', async (t) => {
  const { projectDir, claudeRoot, sessionDir } = createFixture(t, 'dense-timeline-project');
  const start = Date.UTC(2026, 7, 4, 12, 0, 0);
  const recordCount = 50_000;
  const lines = new Array(recordCount);
  for (let index = 0; index < recordCount; index++) {
    lines[index] = JSON.stringify({
      type: 'assistant', timestamp: new Date(start + index).toISOString(), cwd: projectDir,
      message: { role: 'assistant', content: [{
        type: 'tool_use', id: `edit-${index}`, name: 'Edit',
        input: { file_path: path.join(projectDir, 'src', `file-${index}.js`) },
      }] },
    });
  }
  fs.writeFileSync(path.join(sessionDir, 'dense.jsonl'), `${lines.join('\n')}\n`);

  const source = createSource(t, claudeRoot, start + 24 * 60 * 60 * 1000);
  await source.index();
  await source.seek(start + recordCount - 1);
  const snapshot = source.snapshot();

  assert.equal(snapshot.projects.length, 1);
  assert.equal(snapshot.projects[0].firstSeen, start);
  assert.equal(snapshot.projects[0].totalBuilds, recordCount);
  assert.equal(source._lastDrainPeakRecords, 1,
    'the merge heap should hold one next record for this source, not the whole history');
  assert.equal(source._sourceCursors.get(source._indexEntries[0].sourceKey).buffer.length, 0,
    'stream buffers should be released after the seek');
});

test('cold seek merges Claude and Codex sources through the selected timestamp',
  { timeout: 5_000 }, async (t) => {
    const { root, projectDir, claudeRoot, sessionDir } = createFixture(t, 'mixed-project');
    const start = Date.UTC(2026, 7, 4, 12, 0, 0);
    const iso = (offset) => new Date(start + offset).toISOString();
    fs.writeFileSync(path.join(sessionDir, 'mixed-claude.jsonl'), [
      { type: 'user', timestamp: iso(0), cwd: projectDir,
        message: { role: 'user', content: 'private fixture' } },
      { type: 'assistant', timestamp: iso(30_000), cwd: projectDir,
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'claude-edit',
          name: 'Edit', input: { file_path: path.join(projectDir, 'src', 'claude.js') } }] } },
      { type: 'system', subtype: 'turn_duration', timestamp: iso(600_000), cwd: projectDir },
    ].map((line) => `${JSON.stringify(line)}\n`).join(''));

    const codexId = '019f0000-0000-7000-8000-000000000106';
    const codexRoot = path.join(root, '.codex', 'sessions');
    fs.mkdirSync(codexRoot, { recursive: true });
    fs.writeFileSync(path.join(codexRoot, `rollout-mixed-${codexId}.jsonl`), [
      { timestamp: iso(2_000), type: 'session_meta', payload: {
        id: codexId, session_id: codexId, cwd: projectDir, thread_source: 'user' } },
      { timestamp: iso(40_000), type: 'response_item', payload: {
        type: 'custom_tool_call', call_id: 'codex-patch', name: 'apply_patch', input: 'private' } },
      { timestamp: iso(45_000), type: 'event_msg', payload: {
        type: 'patch_apply_end', call_id: 'codex-patch', success: true,
        changes: { [path.join(projectDir, 'src', 'codex.js')]: { type: 'add' } } } },
    ].map((line) => `${JSON.stringify(line)}\n`).join(''));

    const source = createSource(t, claudeRoot, start + 24 * 60 * 60 * 1000, [codexRoot]);
    await source.index();
    await source.seek(start + 60_000);
    const snapshot = source.snapshot();

    assert.equal(snapshot.projects.length, 1);
    assert.equal(snapshot.projects[0].totalBuilds, 2);
    assert.ok(source._lastDrainPeakRecords <= 2);
  });

test('forward seek reuses source cursors and backward seek reconstructs deterministically', async (t) => {
  const { projectDir, claudeRoot, sessionDir } = createFixture(t);
  const start = Date.UTC(2026, 7, 4, 12, 0, 0);
  const lines = [];
  for (let index = 0; index <= 12; index++) {
    const ts = start + index * 10 * 60 * 1000;
    lines.push({
      type: 'user', timestamp: new Date(ts).toISOString(), cwd: projectDir,
      message: { role: 'user', content: 'private fixture' },
    });
    lines.push({
      type: 'assistant', timestamp: new Date(ts + 1000).toISOString(), cwd: projectDir,
      message: { role: 'assistant', content: [{
        type: 'tool_use', id: `edit-${index}`, name: 'Edit',
        input: { file_path: path.join(projectDir, 'src', `file-${index}.js`) },
      }] },
    });
  }
  fs.writeFileSync(path.join(sessionDir, 'timeline.jsonl'),
    lines.map((line) => `${JSON.stringify(line)}\n`).join(''));

  const source = createSource(t, claudeRoot, start + 24 * 60 * 60 * 1000);
  await source.index();
  await source.seek(start + 20 * 60 * 1000 + 1000);
  const cursor = source._sourceCursors.get(source._indexEntries[0].sourceKey);
  await source.advanceTo(start + 12 * 10 * 60 * 1000 + 1000, { emit: false });
  const endSnapshot = source.snapshot();

  assert.equal(source._sourceCursors.get(source._indexEntries[0].sourceKey), cursor,
    'forward seeks should continue from the existing parser cursor');
  assert.equal(endSnapshot.projects[0].totalBuilds, 13);

  await source.seek(start + 10 * 60 * 1000 + 1000);
  const backwardSnapshot = source.snapshot();
  assert.notEqual(source._sourceCursors.get(source._indexEntries[0].sourceKey), cursor,
    'backward seeks should use a fresh parser cursor');
  assert.equal(backwardSnapshot.projects[0].firstSeen, start);
  assert.equal(backwardSnapshot.projects[0].totalBuilds, 2);
});

test('cancelled seek closes handles against the cursors that opened them', async (t) => {
  const { projectDir, claudeRoot, sessionDir } = createFixture(t, 'overlapping-seek-project');
  const start = Date.UTC(2026, 7, 4, 12, 0, 0);
  const later = start + 60 * 60 * 1000;
  const record = (timestamp, id) => ({
    type: 'assistant', timestamp: new Date(timestamp).toISOString(), cwd: projectDir,
    message: { role: 'assistant', content: [{
      type: 'tool_use', id, name: 'Edit',
      input: { file_path: path.join(projectDir, 'src', `${id}.js`) },
    }] },
  });
  fs.writeFileSync(path.join(sessionDir, 'early.jsonl'),
    `${JSON.stringify(record(start, 'early-edit'))}\n`);
  fs.writeFileSync(path.join(sessionDir, 'later.jsonl'),
    `${JSON.stringify(record(later, 'later-edit'))}\n`);

  const source = createSource(t, claudeRoot, later + 60_000);
  await source.index();
  const laterEntry = source._indexEntries.find((entry) => entry.startMs === later);
  assert.ok(laterEntry, 'the fixture should expose a later source');

  const openStreamHandle = source._openStreamHandle.bind(source);
  let releaseRead;
  const readGate = new Promise((resolve) => { releaseRead = resolve; });
  let notifyReadStarted;
  const readStarted = new Promise((resolve) => { notifyReadStarted = resolve; });
  let heldLaterRead = false;
  source._openStreamHandle = async (entry, cursor, handles) => {
    const handle = await openStreamHandle(entry, cursor, handles);
    if (entry.sourceKey !== laterEntry.sourceKey || heldLaterRead) return handle;
    heldLaterRead = true;
    const read = handle.read.bind(handle);
    handle.read = async (...args) => {
      notifyReadStarted();
      await readGate;
      return read(...args);
    };
    return handle;
  };

  const cancelledSeek = source.seek(later);
  await readStarted;
  await source.seek(start);
  source.pause();
  releaseRead();

  const cancellation = await cancelledSeek.then(
    () => null,
    (error) => error
  );
  assert.equal(cancellation?.code, 'ERR_REPLAY_CANCELLED');
  assert.equal(source.snapshot().projects[0].totalBuilds, 1,
    'the completed earliest-time seek should remain intact');
});

test('history index skips a Claude transcript whose cwd has no local project key', async (t) => {
  const { sessionDir } = createFixture(t, 'unc-project');
  const now = Date.UTC(2026, 7, 4, 13, 0, 0);
  const timestamp = new Date(Date.UTC(2026, 7, 4, 12, 0, 0)).toISOString();
  for (const cwd of ['\\\\wsl.localhost\\Ubuntu\\home\\u\\proj', 'relative/proj']) {
    const file = path.join(sessionDir, `${cwd.length}.jsonl`);
    fs.writeFileSync(file, `${JSON.stringify({ type: 'user', timestamp, cwd })}\n`);
    assert.equal(await inspectClaudeFile(file, 'unc-project', (value) => safeTimestamp(value, now)), null, cwd);
  }
});

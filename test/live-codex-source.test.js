'use strict';

// src/main/live/codex-source.js, through the Tracker: a Codex rollout. Part of the
// characterization of the live model in tracker.test.js: it pins behaviour as it is.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { adaptLine, createAdapterState, classifyTool, canonicalProjectPath } = require('../src/main/provider-adapters');
const {
  SEC, MIN, T0, SLUG, CODEX_SESSION, TASK_ID, SHIP_ID, CODEX_SHIP_ID, fnv1a, hex8, appendJsonl,
  createWorld, ofType, pick, claude, codex,
} = require('./support/transcripts');
const { startCodex, appendAndPoll, pollAt, shipOf } = require('./support/live-session');

test('codex: session_meta at startup creates a project keyed by canonical cwd and a codex ship', (t) => {
  const { world, file, tracker, startup } = startCodex(t);
  const projectId = `project:${hex8(canonicalProjectPath(world.projectDir))}`;

  assert.deepEqual(startup.map((event) => event.type), ['project-added', 'ship-spawned', 'feed']);
  assert.deepEqual(startup[0].project, {
    id: projectId, path: world.projectDir, name: 'demo', exists: true,
    firstSeen: T0, lastActivity: T0, totalBytes: 0, totalBuilds: 0,
    seed: fnv1a(projectId), galaxy: { key: 'workspace:demo', label: 'Demo' }, planets: [],
  });
  assert.deepEqual(startup[1].ship, {
    id: CODEX_SHIP_ID, name: 'Codex-1', project: projectId, kind: 'main', provider: 'codex',
    status: 'Working', detail: null, lastEvent: T0, attention: null, attentionSince: null,
    builds: 0, local: false, model: null, taskId: null, turnOutcome: null,
  });
  assert.equal(startup[2].entry.text, 'Codex-1 entered demo');
  assert.equal(tracker.snapshot().projects[0].totalBytes, fs.statSync(file).size,
    'codex bytes are folded in after the project-added event');
});

test('codex: a Claude project with the same cwd keeps its slug id and absorbs codex ships and bytes', (t) => {
  const world = createWorld(t);
  appendJsonl(world.claudeFile(), [claude.prompt(world.projectDir, T0)], T0);
  appendJsonl(world.codexFile(), [codex.meta(T0, CODEX_SESSION, world.projectDir)], T0);
  const { tracker, take } = world.live();
  tracker.scan(true);

  assert.deepEqual(ofType(take(), 'project-added').map((event) => event.project.id), [SLUG]);
  const snapshot = tracker.snapshot();
  assert.deepEqual(snapshot.ships.map((ship) => [ship.id, ship.project, ship.name]),
    [[SHIP_ID, SLUG, 'Claude-1'], [CODEX_SHIP_ID, SLUG, 'Codex-1']]);
  assert.equal(snapshot.projects[0].totalBytes,
    fs.statSync(world.claudeFile()).size + fs.statSync(world.codexFile()).size);
});

test('codex: function calls, patch builds (deduped by call id), turn lifecycle and the task marker', (t) => {
  const session = startCodex(t);
  const { dir, tracker } = session;
  const projectId = `project:${hex8(canonicalProjectPath(dir))}`;
  const events = appendAndPoll(session, [
    codex.event(T0 + 1 * SEC, 'task_started'),
    codex.userText(T0 + 2 * SEC, `Please do this.\nagent-universe:${TASK_ID.toUpperCase()}`),
    codex.call(T0 + 3 * SEC, 'call-exec', 'exec_command'),
    codex.output(T0 + 4 * SEC, 'call-exec'),
    codex.patchCall(T0 + 5 * SEC, 'call-patch'),
    codex.patched(T0 + 6 * SEC, 'call-patch', [
      path.join(dir, 'src', 'x.js'), path.join(dir, 'notes.md'), path.join(session.world.root, 'outside.js'),
    ]),
    codex.patched(T0 + 7 * SEC, 'call-patch', [path.join(dir, 'src', 'x.js')]),
    codex.patchOutput(T0 + 8 * SEC, 'call-patch'),
    codex.event(T0 + 9 * SEC, 'task_complete'),
  ], T0 + 9 * SEC);

  assert.deepEqual(events.map((event) => event.type), [
    'ship-updated', 'ship-updated',
    'ship-updated', 'activity', 'ship-updated',
    'ship-updated', 'activity',
    'build', 'feed', 'feed', 'build', 'feed', 'feed',
    'ship-updated', 'ship-updated',
  ]);
  assert.deepEqual(ofType(events, 'ship-updated').map((event) => pick(['status', 'taskId', 'turnOutcome'])(event.ship)), [
    { status: 'Working', taskId: null, turnOutcome: 'running' },
    { status: 'Working', taskId: TASK_ID, turnOutcome: 'running' },
    { status: 'Gathering Resources', taskId: TASK_ID, turnOutcome: 'running' },
    { status: 'Gathering Resources', taskId: TASK_ID, turnOutcome: 'running' },
    { status: 'Building', taskId: TASK_ID, turnOutcome: 'running' },
    { status: 'Building', taskId: TASK_ID, turnOutcome: 'running' },
    { status: 'Building', taskId: TASK_ID, turnOutcome: 'completed' },
  ]);
  assert.deepEqual(ofType(events, 'activity').map(pick(['project', 'shipId', 'tool', 'status', 'detail', 'ts'])), [
    { project: projectId, shipId: CODEX_SHIP_ID, tool: 'Bash', status: 'Gathering Resources', detail: null, ts: T0 + 3 * SEC },
    { project: projectId, shipId: CODEX_SHIP_ID, tool: 'Edit', status: 'Building', detail: null, ts: T0 + 5 * SEC },
  ]);
  assert.deepEqual(ofType(events, 'build').map(pick(['project', 'bucket', 'file', 'shipId', 'isNew', 'ts'])), [
    { project: projectId, bucket: 'src', file: path.join('src', 'x.js'), shipId: CODEX_SHIP_ID, isNew: true, ts: T0 + 6 * SEC },
    { project: projectId, bucket: '(root)', file: 'notes.md', shipId: CODEX_SHIP_ID, isNew: true, ts: T0 + 6 * SEC },
  ]);
  assert.equal(tracker.snapshot().projects[0].totalBuilds, 2);
  assert.equal(tracker.snapshot().ships[0].builds, 2, 'a re-reported call id and outside files do not count');

  const done = pollAt(session, T0 + 19 * SEC);
  assert.deepEqual(done.map((event) => [event.type, event.ship && event.ship.attention]),
    [['ship-updated', 'done'], ['feed', undefined]]);
});

test('codex: turn_aborted marks the outcome aborted; malformed task markers are ignored', (t) => {
  const session = startCodex(t);
  appendAndPoll(session, [
    codex.userText(T0 + 1 * SEC, 'agent-universe:not-a-uuid'),
    codex.userText(T0 + 2 * SEC, `xagent-universe:${TASK_ID}`),
    codex.userText(T0 + 3 * SEC, `agent-universe:${TASK_ID.replace(/-4/, '-0')}`),
    codex.event(T0 + 4 * SEC, 'task_started'),
    codex.event(T0 + 5 * SEC, 'turn_aborted'),
  ], T0 + 5 * SEC);
  assert.deepEqual(pick(['status', 'taskId', 'turnOutcome'])(shipOf(session.tracker, CODEX_SHIP_ID)),
    { status: 'Working', taskId: null, turnOutcome: 'aborted' });
});

test('codex: a rollout resumed after 15 min idle continues from its previous offset (no re-count)', (t) => {
  const session = startCodex(t);
  const { dir, tracker } = session;
  appendAndPoll(session, [codex.patched(T0 + 1 * SEC, 'p1', [path.join(dir, 'src', 'a.js')])], T0 + 1 * SEC);
  pollAt(session, T0 + 1 * SEC + 15 * MIN + 1);

  const resumedAt = T0 + 20 * MIN;
  session.world.clock.set(resumedAt);
  appendJsonl(session.file, [codex.patched(resumedAt, 'p2', [path.join(dir, 'src', 'b.js')])], resumedAt);
  tracker.scan(false);
  tracker.pollFiles();
  assert.deepEqual(ofType(session.take(), 'build').map((event) => event.file), [path.join('src', 'b.js')]);
  assert.equal(tracker.snapshot().projects[0].totalBuilds, 2);
});

// Ported from kit/done/multi-provider/edge-validation.mjs.
test('codex adapter: records copied from a parent before the child session_meta are ignored', () => {
  const childId = '019f0000-0000-7000-8000-000000000055';
  const parentId = '019f0000-0000-7000-8000-000000000044';
  let state = createAdapterState('codex', { sessionId: childId });
  const adapt = (record) => {
    const result = adaptLine('codex', JSON.stringify(record), state, { now: T0 });
    state = result.state;
    return result.signals;
  };
  assert.deepEqual(adapt({ type: 'session_meta', payload: {
    id: parentId, session_id: parentId, cwd: 'C:\\parent', thread_source: 'user',
  } }), []);
  assert.deepEqual(adapt({ type: 'event_msg', payload: {
    type: 'patch_apply_end', success: true, call_id: 'parent-call',
    changes: { 'C:\\parent\\secret.js': { type: 'update' } },
  } }), []);
  const [session] = adapt({ type: 'session_meta', payload: {
    id: childId, session_id: parentId, cwd: 'C:\\child',
    source: { subagent: {} }, parent_thread_id: parentId,
  } });
  assert.deepEqual(session, { type: 'session', sessionId: childId, cwd: 'C:\\child', kind: 'drone', provider: 'codex', ts: T0 });
  assert.equal(state.parentSessionId, parentId);
});

test('codex: a forked child rollout found mid-run is a drone and skips its copied parent prefix', (t) => {
  const world = createWorld(t);
  const dir = world.projectDir;
  const parentId = '019f0000-0000-7000-8000-000000000044';
  const childId = '019f0000-0000-7000-8000-000000000055';
  appendJsonl(world.codexFile(parentId), [codex.meta(T0, parentId, dir)], T0);
  const { tracker, take } = world.live();
  tracker.scan(true);
  take();

  world.clock.set(T0 + 5 * SEC);
  appendJsonl(world.codexFile(childId), [
    codex.meta(T0 + 1 * SEC, parentId, dir),
    codex.patched(T0 + 2 * SEC, 'parent-call', [path.join(dir, 'src', 'parent.js')]),
    codex.meta(T0 + 3 * SEC, childId, dir, {
      session_id: parentId, thread_source: 'subagent', parent_thread_id: parentId,
    }),
    codex.patched(T0 + 4 * SEC, 'child-call', [path.join(dir, 'src', 'child.js')]),
  ], T0 + 5 * SEC);
  tracker.scan(false);
  tracker.pollFiles();

  const events = take();
  assert.deepEqual(ofType(events, 'ship-spawned').map((event) => pick(['id', 'kind', 'name'])(event.ship)),
    [{ id: `ship:codex:${childId}`, kind: 'drone', name: 'Codex-2' }]);
  assert.deepEqual(ofType(events, 'build'), [], 'a rollout found mid-run is read in catchup mode');
  assert.equal(tracker.snapshot().projects[0].totalBuilds, 1, 'only the child\'s own patch counts');
  assert.deepEqual(tracker.snapshot().ships.map((ship) => [ship.id, ship.builds]),
    [[`ship:codex:${parentId}`, 0], [`ship:codex:${childId}`, 1]]);
});

// Ported from kit/done/multi-provider/edge-validation.mjs.
test('codex: moving a rollout from sessions to archived_sessions keeps one ship and dedupes builds by call id', (t) => {
  const world = createWorld(t);
  const dir = world.projectDir;
  const activeFile = world.codexFile();
  const archiveFile = path.join(world.codexArchive, path.basename(activeFile));
  appendJsonl(activeFile, [codex.meta(T0, CODEX_SESSION, dir, { thread_source: undefined, source: 'cli' })], T0);
  const { tracker } = world.live({ codexSessionDirs: [world.codexRoot, world.codexArchive] });
  tracker.scan(true);
  const build = (callId, file, at) => [
    codex.patchCall(at, callId),
    codex.patched(at, callId, [path.join(dir, 'src', file)]),
    codex.patchOutput(at, callId),
  ];

  world.clock.set(T0 + 1 * SEC);
  appendJsonl(activeFile, build('build-one', 'one.js', T0 + 1 * SEC));
  tracker.pollFiles();
  assert.equal(tracker.snapshot().projects[0].totalBuilds, 1);

  fs.mkdirSync(world.codexArchive, { recursive: true });
  fs.renameSync(activeFile, archiveFile);
  tracker.scan(false);
  world.clock.set(T0 + 2 * SEC);
  appendJsonl(archiveFile, [
    ...build('build-one', 'one.js', T0 + 2 * SEC),
    ...build('build-two', 'two.js', T0 + 2 * SEC),
  ]);
  tracker.pollFiles();
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.projects[0].totalBuilds, 2);
  assert.deepEqual(snapshot.ships.map((ship) => ship.id), [CODEX_SHIP_ID]);
});

// Ported from kit/done/multi-provider/edge-validation.mjs.
test('classifyTool maps Codex tool names onto the shared status vocabulary', () => {
  const expected = [
    ['exec', 'Bash', 'Gathering Resources'],
    ['wait', 'Bash', 'Gathering Resources'],
    ['browser', 'WebSearch', 'Scanning'],
    ['create_goal', 'TodoWrite', 'Planning'],
    ['list_files', 'Read', 'Exploring'],
    ['request_user_input', 'AskUserQuestion', 'Working'],
  ];
  for (const [name, tool, status] of expected) {
    assert.deepEqual(classifyTool(name), { tool, status, build: false }, name);
  }
});

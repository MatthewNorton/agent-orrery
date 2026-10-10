'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReplayControl } = require('../src/main/replay-control');
const { createTerminalIpc } = require('../src/main/ipc/terminal');
const { createTasksIpc } = require('../src/main/ipc/tasks');
const { createRootTasksIpc } = require('../src/main/ipc/root-tasks');
const { createProjectPathsIpc } = require('../src/main/ipc/project-paths');
const {
  callNames, deferred, fakeCtx, fakeReplaySource, fakeTracker, sentOn, trustedEvent,
} = require('./support/main-wiring');

const PLAYBACK_KEYS = [
  'available', 'cursorTs', 'indexing', 'maxTs', 'minTs', 'mode', 'playing', 'sourceCount', 'speed', 'truncated',
];

function replayCtx(t, { status, tracker = fakeTracker(), flags = {} } = {}) {
  const ctx = fakeCtx({ tracker, replaySource: fakeReplaySource(status), flags });
  const replay = createReplayControl(ctx);
  ctx.replay = replay;
  t.after(() => replay.reset());
  return { ctx, replay, source: ctx.replaySource };
}

async function enterReplay(replay, source, ts = 5_000) {
  const result = await replay.handleReplayCommand({ action: 'seek', ts });
  source.calls.length = 0;
  return result;
}

function fakeVcsController() {
  const calls = [];
  return {
    calls,
    enrichSnapshot(source, snapshot) { calls.push(['snapshot', source]); return { ...snapshot, enriched: true }; },
    enrichSystem(source, system) { calls.push(['system', source]); return { ...system, enriched: true }; },
  };
}

test('playback status is sanitized and LIVE pins the cursor to the newest record', (t) => {
  const { ctx, replay, source } = replayCtx(t, {
    status: {
      available: 1, indexing: 0, minTs: NaN, maxTs: Infinity, cursorTs: '5',
      playing: true, speed: 7, sourceCount: undefined, truncated: 'yes',
    },
  });
  assert.deepEqual(replay.boundedReplayStatus(), {
    mode: 'live', available: true, indexing: false, minTs: null, maxTs: null, cursorTs: null,
    playing: false, speed: 1, sourceCount: 0, truncated: true,
  });

  source.raw = { available: true, minTs: 1_000, maxTs: 9_000, cursorTs: 4_000, playing: true, speed: 100, sourceCount: 3 };
  assert.equal(replay.boundedReplayStatus().cursorTs, 9_000, 'LIVE shows the end of history');
  assert.equal(replay.boundedReplayStatus().playing, false, 'LIVE never reports playing');
  ctx.activeSource = source;
  assert.deepEqual(replay.boundedReplayStatus(), {
    mode: 'replay', available: true, indexing: false, minTs: 1_000, maxTs: 9_000, cursorTs: 4_000,
    playing: true, speed: 100, sourceCount: 3, truncated: false,
  });

  ctx.replaySource = null;
  ctx.activeSource = ctx.tracker;
  assert.equal(replay.boundedReplayStatus().available, false, 'no history source yet');
});

test('the visible snapshot has the contract shape and follows the active source', (t) => {
  const { ctx, replay, source } = replayCtx(t);
  const live = replay.visibleSnapshot();
  assert.deepEqual(Object.keys(live).sort(), ['eventSequence', 'feed', 'playback', 'projects', 'ships', 'streamEpoch']);
  assert.deepEqual(Object.keys(live.playback).sort(), PLAYBACK_KEYS);
  assert.equal(live.eventSequence, 3);
  assert.equal(live.streamEpoch, 1);
  assert.equal(live.playback.mode, 'live');

  ctx.activeSource = source;
  ctx.streamEpoch = 4;
  const replayed = replay.visibleSnapshot();
  assert.equal(replayed.eventSequence, 11);
  assert.equal(replayed.streamEpoch, 4);
  assert.equal(replayed.playback.mode, 'replay');

  ctx.activeSource = null;
  ctx.tracker = null;
  const empty = replay.visibleSnapshot();
  assert.deepEqual([empty.projects, empty.ships, empty.feed, empty.eventSequence], [[], [], [], 0]);
});

test('snapshots and systems go through the git-status enricher with their source', (t) => {
  const { ctx, replay, source } = replayCtx(t);
  const controller = fakeVcsController();
  ctx.projectVcsStatusController = controller;
  assert.equal(replay.visibleSnapshot().enriched, true);
  assert.equal(replay.visibleSystem('alpha').enriched, true);
  ctx.activeSource = source;
  replay.visibleSnapshot();
  assert.deepEqual(controller.calls, [
    ['snapshot', ctx.tracker], ['system', ctx.tracker], ['snapshot', source],
  ]);
});

test('visibleSystem and visibleProject read whichever source is visible', (t) => {
  const tracker = fakeTracker({ projects: [{ id: 'alpha', name: 'Alpha' }] });
  const { ctx, replay, source } = replayCtx(t, { tracker });
  assert.equal(replay.visibleSystem('alpha').source, 'live');
  assert.deepEqual(replay.visibleProject('alpha'), { id: 'alpha', name: 'Alpha' });
  assert.equal(replay.visibleProject('beta'), null);

  ctx.activeSource = source;
  assert.equal(replay.visibleSystem('alpha').source, 'replay');
  source.snapshot = () => ({ projects: [{ id: 'alpha', name: 'Then' }] });
  assert.deepEqual(replay.visibleProject('alpha'), { id: 'alpha', name: 'Then' }, 'falls back to the snapshot list');
  source.snapshot = () => ({});
  assert.equal(replay.visibleProject('alpha'), null);
});

test('a seek enters replay paused, bumps the epoch once and pushes the new state', async (t) => {
  const { ctx, replay, source } = replayCtx(t);
  const result = await replay.handleReplayCommand({ action: 'seek', ts: 5_000 });

  assert.equal(ctx.activeSource, source);
  assert.equal(ctx.streamEpoch, 2);
  assert.deepEqual(source.calls, [['seek', 5_000], ['pause']], 'cold seek from LIVE');
  assert.equal(result.streamEpoch, 2);
  assert.equal(result.playback.mode, 'replay');
  assert.equal(result.playback.cursorTs, 5_000);
  assert.equal(result.snapshot.streamEpoch, 2);
  assert.equal(result.snapshot.playback.mode, 'replay');
  assert.deepEqual(sentOn(ctx.win, 'au:replay-state').map(([push]) => [push.mode, push.cursorTs, push.streamEpoch]), [
    ['replay', 5_000, 2],
  ]);
  assert.equal(replay.replayBoundaryOperations, 0);
});

test('seek targets are clamped to the indexed range', async (t) => {
  const { replay, source } = replayCtx(t);
  await replay.handleReplayCommand({ action: 'seek', ts: -50 });
  assert.deepEqual(source.calls[0], ['seek', 1_000]);
  source.calls.length = 0;
  await replay.handleReplayCommand({ action: 'seek', ts: 1e15 });
  assert.deepEqual(source.calls[1], ['advanceTo', 9_000, { emit: false }]);
});

test('forward scrubs reuse the source cursors; backward scrubs cold-seek', async (t) => {
  const { ctx, replay, source } = replayCtx(t);
  await enterReplay(replay, source, 5_000);

  await replay.handleReplayCommand({ action: 'seek', ts: 7_000 });
  assert.deepEqual(source.calls, [['pause'], ['advanceTo', 7_000, { emit: false }], ['pause']]);
  source.calls.length = 0;
  await replay.handleReplayCommand({ action: 'seek', ts: 3_000 });
  assert.deepEqual(source.calls, [['seek', 3_000], ['pause']]);
  assert.equal(ctx.streamEpoch, 4, 'every completed seek starts a new stream');
});

test('the history index is built on first use and shared by concurrent callers', async (t) => {
  const { replay, source } = replayCtx(t, { status: { available: false } });
  const build = deferred();
  source.gates.index = build.promise;
  const first = replay.ensureReplayIndex(false);
  const second = replay.ensureReplayIndex(false);
  const seeking = replay.handleReplayCommand({ action: 'seek', ts: 2_000 });
  build.resolve();
  await Promise.all([first, second, seeking]);
  assert.deepEqual(callNames(source), ['index', 'seek', 'pause']);

  source.calls.length = 0;
  assert.equal((await replay.ensureReplayIndex(false)).available, true);
  assert.deepEqual(source.calls, [], 'an available index is reused');
  await replay.ensureReplayIndex(true);
  assert.deepEqual(callNames(source), ['index'], 'force rebuilds');
});

test('a seek with no history fails and leaves LIVE untouched', async (t) => {
  const { ctx, replay, source } = replayCtx(t, { status: { available: false } });
  source.index = async () => { source.calls.push(['index']); };
  await assert.rejects(replay.handleReplayCommand({ action: 'seek', ts: 2_000 }), /no historical records/);
  assert.equal(ctx.activeSource, ctx.tracker);
  assert.equal(ctx.streamEpoch, 1);
  assert.equal(replay.replayBoundaryOperations, 0);
  assert.deepEqual(sentOn(ctx.win, 'au:replay-state'), []);

  ctx.replaySource = null;
  await assert.rejects(replay.handleReplayCommand({ action: 'seek', ts: 2_000 }), /history playback is unavailable/);
  assert.equal(replay.replayBoundaryOperations, 0);
});

test('a seek that throws part-way still releases the LIVE boundary', async (t) => {
  const { ctx, replay, source } = replayCtx(t);
  source.seek = async () => { throw new Error('corrupt transcript'); };
  await assert.rejects(replay.handleReplayCommand({ action: 'seek', ts: 2_000 }), /corrupt transcript/);
  assert.equal(replay.replayBoundaryOperations, 0);
  assert.equal(ctx.activeSource, ctx.tracker);
  assert.equal(ctx.streamEpoch, 1);
});

test('LIVE-only handlers answer REPLAY while a seek is in flight, before the mode flips', async (t) => {
  const { ctx, replay, source } = replayCtx(t, { flags: { controlTest: true } });
  ctx.ipc.terminal = createTerminalIpc(ctx);
  const tasks = createTasksIpc(ctx);
  const rootTasks = createRootTasksIpc(ctx);
  const projectPaths = createProjectPathsIpc(ctx, { app: { getPath: () => null }, dialog: null });
  ctx.rootTaskCoordinator = { create: () => ({ ok: true }) };
  const event = trustedEvent(ctx.win);
  const liveOnly = async () => [
    await ctx.ipc.terminal.handleOpenTerminal(event, 'alpha'),
    tasks.handleTaskAdd(event, 'alpha', 'goal'),
    rootTasks.handleRootTaskCreate(event, 'idea'),
    projectPaths.handleProjectPathApply(event, 'alpha', 'token'),
  ];

  const held = deferred();
  source.gates.seek = held.promise;
  const seeking = replay.handleReplayCommand({ action: 'seek', ts: 2_000 });
  await Promise.resolve();
  assert.equal(replay.replayBoundaryOperations, 1);
  assert.equal(ctx.activeSource, ctx.tracker, 'still LIVE');
  assert.deepEqual(await liveOnly(), [
    { ok: false, code: 'REPLAY' }, { ok: false, items: [] }, { ok: false, code: 'REPLAY' }, { ok: false, code: 'REPLAY' },
  ]);

  held.resolve();
  await seeking;
  await replay.handleReplayCommand({ action: 'live' });
  assert.equal(replay.replayBoundaryOperations, 0);
  assert.deepEqual(await liveOnly(), [
    { ok: false, code: 'NOT_FOUND' }, { ok: false, items: [] }, { ok: true }, { ok: false, code: 'NOT_FOUND' },
  ], 'back in LIVE the handlers run their own checks');
});

test('LIVE pressed during an in-flight seek wins; the stale seek does not switch', async (t) => {
  const { ctx, replay, source } = replayCtx(t);
  const held = deferred();
  source.gates.seek = held.promise;
  const seeking = replay.handleReplayCommand({ action: 'seek', ts: 2_000 });
  const live = await replay.handleReplayCommand({ action: 'live' });
  assert.equal(live.playback.mode, 'live');
  assert.equal(live.snapshot.playback.mode, 'live');

  held.resolve();
  const stale = await seeking;
  assert.equal(stale.playback.mode, 'live');
  assert.equal(stale.snapshot, undefined);
  assert.equal(ctx.activeSource, ctx.tracker);
  assert.equal(ctx.streamEpoch, 1, 'already LIVE, so no new stream');
  assert.equal(replay.replayBoundaryOperations, 0);
});

test('overlapping seeks: only the newest one switches the stream', async (t) => {
  const { ctx, replay, source } = replayCtx(t);
  const held = deferred();
  source.gates.seek = held.promise;
  const older = replay.handleReplayCommand({ action: 'seek', ts: 2_000 });
  source.gates.seek = null;
  const newer = await replay.handleReplayCommand({ action: 'seek', ts: 6_000 });
  assert.equal(newer.snapshot.playback.mode, 'replay');
  assert.equal(ctx.streamEpoch, 2);

  held.resolve();
  const stale = await older;
  assert.equal(stale.snapshot, undefined);
  assert.equal(ctx.streamEpoch, 2, 'the stale seek starts no stream');
  assert.equal(replay.replayBoundaryOperations, 0);
});

test('LIVE from replay pauses, bumps the epoch and pushes state; LIVE in LIVE keeps the epoch', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  const { ctx, replay, source } = replayCtx(t);
  await enterReplay(replay, source);
  const live = await replay.handleReplayCommand({ action: 'live' });
  assert.deepEqual(source.calls, [['pause']]);
  assert.equal(ctx.activeSource, ctx.tracker);
  assert.equal(ctx.streamEpoch, 3);
  assert.equal(live.snapshot.streamEpoch, 3);
  assert.equal(live.snapshot.playback.mode, 'live');
  t.mock.timers.tick(100);
  assert.deepEqual(sentOn(ctx.win, 'au:replay-state').map(([push]) => [push.mode, push.streamEpoch]), [
    ['replay', 2], ['live', 3],
  ]);

  await replay.handleReplayCommand({ action: 'live' });
  assert.equal(ctx.streamEpoch, 3);
});

test('play, pause and speed need replay mode and drive the source', async (t) => {
  const { replay, source } = replayCtx(t);
  for (const command of [{ action: 'play' }, { action: 'pause' }, { action: 'speed', speed: 10 }]) {
    await assert.rejects(replay.handleReplayCommand(command), new RegExp(`${command.action} requires replay mode`));
  }
  assert.deepEqual(source.calls, []);

  await enterReplay(replay, source);
  assert.equal((await replay.handleReplayCommand({ action: 'play' })).playback.playing, true);
  const faster = await replay.handleReplayCommand({ action: 'speed', speed: 100 });
  assert.equal(faster.playback.speed, 100);
  assert.equal(faster.snapshot, undefined);
  assert.equal((await replay.handleReplayCommand({ action: 'pause' })).playback.playing, false);
  assert.deepEqual(source.calls, [['play'], ['setSpeed', 100], ['pause']]);
});

test('commands are validated before anything runs', async (t) => {
  const { replay, source } = replayCtx(t);
  const invalid = [
    [null, TypeError], [[], TypeError], ['seek', TypeError], [{ action: 'rewind' }, TypeError],
    [{ action: 'seek' }, TypeError], [{ action: 'seek', ts: NaN }, TypeError],
    [{ action: 'seek', ts: '2000' }, TypeError], [{ action: 'seek', ts: Infinity }, TypeError],
    [{ action: 'speed', speed: 7 }, RangeError], [{ action: 'speed', speed: '10' }, RangeError],
  ];
  for (const [command, type] of invalid) {
    await assert.rejects(replay.handleReplayCommand(command), type, JSON.stringify(command));
  }
  assert.deepEqual(source.calls, []);
});

test('index rebuilds history on demand, but only from LIVE', async (t) => {
  const { replay, source } = replayCtx(t);
  const result = await replay.handleReplayCommand({ action: 'index' });
  assert.deepEqual(callNames(source), ['index'], 'forced even though an index exists');
  assert.equal(result.playback.mode, 'live');
  assert.equal(result.snapshot, undefined);

  await enterReplay(replay, source);
  await assert.rejects(replay.handleReplayCommand({ action: 'index' }), /return to LIVE/);
  assert.deepEqual(source.calls, []);
});

test('replay-state pushes are throttled to one per 100 ms with one trailing push', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  const { ctx, replay, source } = replayCtx(t);
  ctx.activeSource = source;
  const cursors = () => sentOn(ctx.win, 'au:replay-state').map(([push]) => push.cursorTs);

  source.raw.cursorTs = 2_000;
  replay.sendReplayState();
  source.raw.cursorTs = 3_000;
  replay.sendReplayState();
  source.raw.cursorTs = 4_000;
  replay.sendReplayState();
  assert.deepEqual(cursors(), [2_000]);
  t.mock.timers.tick(99);
  assert.deepEqual(cursors(), [2_000]);
  t.mock.timers.tick(1);
  assert.deepEqual(cursors(), [2_000, 4_000], 'the trailing push carries the latest state');
  t.mock.timers.tick(1_000);
  assert.deepEqual(cursors(), [2_000, 4_000]);

  const [push] = sentOn(ctx.win, 'au:replay-state')[0];
  assert.deepEqual(Object.keys(push).sort(), [...PLAYBACK_KEYS, 'streamEpoch'].sort());
});

test('no replay-state push without a live window', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  const { ctx, replay } = replayCtx(t);
  ctx.win.destroyed = true;
  replay.sendReplayState();
  t.mock.timers.tick(1_000);
  ctx.win.destroyed = false;
  replay.sendReplayState();
  assert.equal(sentOn(ctx.win, 'au:replay-state').length, 1, 'the destroyed call neither sent nor throttled');
  ctx.win = null;
  assert.doesNotThrow(() => replay.sendReplayState());
});

test('reset cancels the trailing push and invalidates an in-flight seek', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  const { ctx, replay, source } = replayCtx(t);
  replay.sendReplayState();
  replay.sendReplayState();
  replay.reset();
  t.mock.timers.tick(1_000);
  assert.equal(sentOn(ctx.win, 'au:replay-state').length, 1);

  const held = deferred();
  source.gates.seek = held.promise;
  const seeking = replay.handleReplayCommand({ action: 'seek', ts: 2_000 });
  replay.reset();
  assert.equal(replay.replayBoundaryOperations, 0);
  held.resolve();
  assert.equal((await seeking).snapshot, undefined);
  assert.equal(ctx.activeSource, ctx.tracker);
  assert.equal(replay.replayBoundaryOperations, 0);
});

test('git status pushes go out only while LIVE', async (t) => {
  const { ctx, replay, source } = replayCtx(t);
  const status = { projectId: 'alpha', state: 'ready' };
  replay.sendProjectVcsStatusChanged(status);
  replay.sendProjectVcsStatusChanged(null);
  assert.deepEqual(sentOn(ctx.win, 'au:project-vcs-status-changed'), [[status, { streamEpoch: 1, mode: 'live' }]]);

  await enterReplay(replay, source);
  replay.sendProjectVcsStatusChanged(status);
  ctx.activeSource = ctx.tracker;
  ctx.win.destroyed = true;
  replay.sendProjectVcsStatusChanged(status);
  assert.equal(sentOn(ctx.win, 'au:project-vcs-status-changed').length, 1);
});

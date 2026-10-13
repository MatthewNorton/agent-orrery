'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAppContext } = require('../src/main/app-context');
const { Tracker } = require('../src/main/tracker');
const { ReplaySource } = require('../src/main/replay-source');
const { fakeWindow, sentOn } = require('./support/main-wiring');

const TASK_ID = '123e4567-e89b-42d3-a456-426614174000';

// Fixture runs must never read the real userData directory.
const NO_USER_DATA = { app: { getPath(name) { throw new Error(`unexpected app.getPath(${name})`); } } };

// Empty transcript roots in a temp dir, shaped like harness/fixtures.js output.
function emptyFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'au-app-context-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir);
  const claudeProjectsDir = path.join(root, 'claude');
  const codexSessionsDir = path.join(root, 'codex');
  const providerConfigPath = path.join(stateDir, 'providers.json');
  return {
    root,
    stateDir,
    statePath: path.join(stateDir, 'universe-state.json'),
    trackerOptions: { claudeProjectsDir, codexSessionDirs: [codexSessionsDir], providerConfigPath },
    replayOptions: { claudeProjectsDir, codexSessionDirs: [codexSessionsDir] },
    options: { claudeProjectsDir, codexSessionsDir, providerConfigPath },
  };
}

function fakeFixtures(fixture) {
  const made = [];
  return {
    made,
    createProviderFixture() { made.push('provider'); return fixture; },
    createHistoryFixture() { made.push('history'); return fixture; },
    createControlFixture() { made.push('control'); return fixture; },
    createRecordingTerminalLauncher(controlFixture) {
      made.push('recording-launcher');
      return { controlFixture, async open() { return { ok: true }; } };
    },
  };
}

// Stand-ins for what main.js attaches as ctx.replay and ctx.ipc; every call is recorded.
function attachWiring(ctx) {
  const calls = [];
  const record = (name, value) => (...args) => { calls.push([name, ...args]); return value; };
  ctx.replay = {
    sendProjectVcsStatusChanged: record('replay.sendProjectVcsStatusChanged'),
    sendReplayState: record('replay.sendReplayState'),
    ensureReplayIndex: record('replay.ensureReplayIndex', Promise.resolve()),
    reset: record('replay.reset'),
  };
  ctx.ipc = {
    terminal: { liveProjectCwd: record('terminal.liveProjectCwd', null), reset: record('terminal.reset') },
    rootTasks: {
      sendRootTasksChanged: record('rootTasks.sendRootTasksChanged'),
      liveProjectShips: record('rootTasks.liveProjectShips', []),
    },
    projectPaths: {
      revokeProjectPathCandidates: record('projectPaths.revokeProjectPathCandidates'),
      reset: record('projectPaths.reset'),
    },
  };
  return calls;
}

function namesOf(calls) {
  return calls.map(([name]) => name);
}

function started(t, flags) {
  const fixture = emptyFixture(t);
  const fixtures = fakeFixtures(fixture);
  const ctx = createAppContext({ flags: { testMode: true, ...flags }, fixtures }, NO_USER_DATA);
  ctx.win = fakeWindow();
  const calls = attachWiring(ctx);
  ctx.start();
  t.after(() => { if (ctx.tracker) ctx.cleanup(); });
  return { ctx, calls, fixture, fixtures };
}

test('the wiring modules load without the electron package', () => {
  const wiring = ['flags', 'window', 'replay-control', 'ipc/guards', 'ipc/register', 'ipc/terminal',
    'ipc/tasks', 'ipc/root-tasks', 'ipc/project-paths'];
  for (const name of wiring) require(path.join(__dirname, '..', 'src', 'main', ...name.split('/')));
  const electronLoaded = Object.keys(require.cache)
    .some((file) => file.includes(`${path.sep}node_modules${path.sep}electron${path.sep}`));
  assert.equal(electronLoaded, false, 'CI installs without the Electron binary, where loading it throws');
});

test('a new context holds no services until start()', () => {
  const ctx = createAppContext({ flags: {}, fixtures: {} }, NO_USER_DATA);
  assert.equal(ctx.streamEpoch, 1);
  for (const key of ['win', 'tracker', 'replaySource', 'activeSource', 'terminalLauncher', 'taskRuns',
    'rootTasks', 'rootTaskCoordinator', 'projectVcsStatusController', 'taskRunSweepTimer']) {
    assert.equal(ctx[key], null, key);
  }
  assert.deepEqual(ctx.harness, { rendererTestErrors: [], openedProjects: [], controlFixture: null, historyFixture: null });
});

test('a test-mode run never looks for the Agent Universe Lite data folder', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  started(t, { historyTest: true });
  assert.equal(warn.mock.calls.some(({ arguments: [message] }) => String(message).startsWith('[startup]')), false);
});

test('start() and cleanup() name the wiring main.js must attach first', () => {
  const fixtures = fakeFixtures(null);
  const ctx = createAppContext({ flags: { historyTest: true, testMode: true }, fixtures }, NO_USER_DATA);
  ctx.win = fakeWindow();
  assert.throws(() => ctx.start(),
    /start\(\) needs ctx\.replay, ctx\.ipc\.terminal, ctx\.ipc\.rootTasks, ctx\.ipc\.projectPaths; attach them after createAppContext/);
  assert.deepEqual(fixtures.made, [], 'nothing was built');
  assert.equal(ctx.tracker, null);

  ctx.replay = {};
  ctx.ipc = { terminal: {}, rootTasks: {} };
  assert.throws(() => ctx.start(), (error) => error.message.startsWith('start() needs ctx.ipc.projectPaths;'));
  assert.throws(() => ctx.cleanup(), /^Error: cleanup\(\) needs ctx\.ipc\.projectPaths;/);
});

test('a history run builds every service from the fixture and starts the index', (t) => {
  const { ctx, calls, fixture, fixtures } = started(t, { historyTest: true });
  assert.deepEqual(fixtures.made, ['history']);
  assert.ok(ctx.tracker instanceof Tracker);
  assert.ok(ctx.replaySource instanceof ReplaySource);
  assert.equal(ctx.activeSource, ctx.tracker);
  assert.equal(ctx.tracker.statePath, fixture.statePath);
  assert.equal(ctx.taskRuns.statePath, path.join(fixture.stateDir, 'task-runs.json'));
  assert.equal(ctx.rootTasks.statePath, path.join(fixture.stateDir, 'root-tasks.json'));
  for (const key of ['rootTaskCoordinator', 'projectVcsStatusController', 'terminalLauncher', 'taskRunSweepTimer']) {
    assert.ok(ctx[key], key);
  }
  assert.equal(ctx.harness.historyFixture, fixture);
  assert.deepEqual(calls.filter(([name]) => name === 'replay.ensureReplayIndex'), [['replay.ensureReplayIndex', false]]);
  assert.ok(namesOf(calls).includes('terminal.reset'));
});

test('only the visible source reaches the window, stamped with the stream epoch', (t) => {
  const { ctx } = started(t, { historyTest: true });
  const live = [{ type: 'feed', seq: 1 }];
  const old = [{ type: 'feed', seq: 2 }];
  ctx.win.sent.length = 0;
  ctx.tracker.emit('events', live);
  ctx.replaySource.emit('events', old);
  assert.deepEqual(sentOn(ctx.win, 'au:events'), [[live, { streamEpoch: 1, mode: 'live' }]]);

  ctx.win.sent.length = 0;
  ctx.activeSource = ctx.replaySource;
  ctx.streamEpoch = 2;
  ctx.tracker.emit('events', live);
  ctx.replaySource.emit('events', old);
  assert.deepEqual(sentOn(ctx.win, 'au:events'), [[old, { streamEpoch: 2, mode: 'replay' }]]);

  ctx.win.sent.length = 0;
  ctx.win.destroyed = true;
  ctx.replaySource.emit('events', old);
  ctx.activeSource = ctx.tracker;
  ctx.tracker.emit('events', live);
  assert.deepEqual(ctx.win.sent, []);
});

test('live batches feed git status and task runs, and revoke tokens of projects that came back', (t) => {
  t.mock.method(console, 'warn', () => {});
  const { ctx, calls } = started(t, { historyTest: true });
  ctx.projectVcsStatusController.stop();
  const observed = { vcs: [], runs: [] };
  ctx.projectVcsStatusController = { observeEvents: (batch) => observed.vcs.push(batch), stop() {} };
  ctx.taskRuns = { observe: (batch) => observed.runs.push(batch), expire() {} };

  const batch = [
    { type: 'project-updated', project: { id: 'back', exists: true } },
    { type: 'project-updated', project: { id: 'still-gone', exists: false } },
    { type: 'project-added', project: { id: 'new', exists: true } },
  ];
  ctx.tracker.emit('events', batch);
  assert.deepEqual(observed, { vcs: [batch], runs: [batch] });
  assert.deepEqual(calls.filter(([name]) => name === 'projectPaths.revokeProjectPathCandidates'), [
    ['projectPaths.revokeProjectPathCandidates', 'back'],
  ]);

  ctx.win.sent.length = 0;
  ctx.taskRuns.observe = () => { throw new Error('bad run file'); };
  ctx.tracker.emit('events', batch);
  assert.equal(sentOn(ctx.win, 'au:events').length, 1, 'a task-run failure does not stop the push');
});

test('replay state events and window focus reach their handlers', (t) => {
  const { ctx, calls } = started(t, { historyTest: true });
  ctx.replaySource.emit('state');
  assert.ok(namesOf(calls).includes('replay.sendReplayState'));

  ctx.projectVcsStatusController.stop();
  let refreshed = 0;
  ctx.projectVcsStatusController = { refreshAll: () => { refreshed++; }, stop() {} };
  ctx.win.emit('focus');
  assert.equal(refreshed, 1);
});

test('a task run change pushes tasks-changed and an IDEAS update the queue did not claim', (t) => {
  const { ctx, calls } = started(t, { historyTest: true });
  ctx.win.sent.length = 0;
  ctx.taskRuns.start({ id: TASK_ID, projectId: 'alpha', text: 'goal', provider: 'codex', baselineShipIds: [] });
  assert.deepEqual(sentOn(ctx.win, 'au:tasks-changed'), [
    [{ projectId: 'alpha', taskId: TASK_ID, phase: 'waiting-for-agent' }],
  ]);
  const ideas = calls.filter(([name]) => name === 'rootTasks.sendRootTasksChanged');
  assert.equal(ideas.length, 1);
  assert.equal(ideas[0][1].id, TASK_ID);
});

test('cleanup stops every service, resets the wiring and removes the temp fixture', (t) => {
  const { ctx, calls, fixture } = started(t, { historyTest: true });
  const stopped = [];
  for (const key of ['tracker', 'replaySource']) {
    const service = ctx[key];
    const stop = service.stop.bind(service);
    service.stop = () => { stopped.push(key); stop(); };
  }
  calls.length = 0;
  ctx.cleanup();

  assert.deepEqual(stopped.sort(), ['replaySource', 'tracker']);
  assert.deepEqual(namesOf(calls).filter((name) => name.endsWith('.reset')), [
    'replay.reset', 'projectPaths.reset', 'terminal.reset',
  ]);
  for (const key of ['tracker', 'replaySource', 'activeSource', 'terminalLauncher', 'taskRuns', 'rootTasks',
    'rootTaskCoordinator', 'projectVcsStatusController', 'taskRunSweepTimer']) {
    assert.equal(ctx[key], null, key);
  }
  assert.equal(ctx.harness.historyFixture, null);
  assert.equal(fs.existsSync(fixture.root), false);
});

test('a provider run skips the history index and removes its fixture on cleanup', (t) => {
  const { ctx, calls, fixture, fixtures } = started(t, { providerTest: true });
  assert.deepEqual(fixtures.made, ['provider']);
  assert.equal(ctx.tracker.statePath, fixture.statePath);
  assert.ok(!namesOf(calls).includes('replay.ensureReplayIndex'));
  ctx.cleanup();
  assert.equal(fs.existsSync(fixture.root), false);
});

test('a control run reuses its fixture as history and records terminal launches', (t) => {
  const { ctx, calls, fixture, fixtures } = started(t, { controlTest: true });
  assert.deepEqual(fixtures.made, ['control', 'recording-launcher']);
  assert.equal(ctx.harness.controlFixture, fixture);
  assert.equal(ctx.harness.historyFixture, fixture);
  assert.equal(ctx.terminalLauncher.controlFixture, fixture);
  assert.ok(namesOf(calls).includes('replay.ensureReplayIndex'));
});

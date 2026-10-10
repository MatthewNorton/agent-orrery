'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { registerIpc } = require('../src/main/ipc/register');
const { createReplayControl } = require('../src/main/replay-control');
const { createTerminalIpc } = require('../src/main/ipc/terminal');
const { createTasksIpc } = require('../src/main/ipc/tasks');
const { createRootTasksIpc } = require('../src/main/ipc/root-tasks');
const { createProjectPathsIpc } = require('../src/main/ipc/project-paths');
const {
  callNames, fakeCtx, fakeTracker, liveProject, tempDir, trustedEvent, untrustedEvent,
} = require('./support/main-wiring');

const TASK_ID = '123e4567-e89b-42d3-a456-426614174000';
const INVALID = { ok: false, code: 'INVALID' };
const NO_TASKS = { ok: false, items: [] };

// Channel -> [args, what an untrusted frame gets back]. Table order is call order;
// au:replay comes last because a seek leaves LIVE.
const CALLS = {
  'au:snapshot': [[], null],
  'au:system': [['alpha'], null],
  'au:planet': [['alpha', 'src'], null],
  'au:open': [['alpha'], ''],
  'au:open-external': [['https://github.com/example/project'], { ok: false, code: 'INVALID_URL' }],
  'au:open-terminal': [['alpha'], INVALID],
  'au:tasks-get': [['alpha'], null],
  'au:task-add': [['alpha', 'second goal'], NO_TASKS],
  'au:task-set-done': [['alpha', { line: 0, text: 'goal', done: true }], NO_TASKS],
  'au:task-remove': [['alpha', { line: 0, text: 'goal' }], NO_TASKS],
  'au:root-tasks-get': [[], { items: [] }],
  'au:root-task-create': [['idea'], INVALID],
  'au:root-task-remove': [[TASK_ID], INVALID],
  'au:root-task-assign': [[TASK_ID, 'alpha'], INVALID],
  'au:root-task-retry': [[TASK_ID], INVALID],
  'au:project-paths-scan': [[], INVALID],
  'au:project-path-locate': [['lost'], INVALID],
  'au:project-path-apply': [['lost', 'token'], INVALID],
  'au:replay': [[{ action: 'seek', ts: 5_000 }], null],
};

function preloadChannels() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  return [...source.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((match) => match[1]);
}

function fakeElectron(documents) {
  const recorded = { handles: [], shell: [], dialogs: [] };
  const handlers = new Map();
  return {
    recorded,
    handlers,
    ipcMain: {
      handle(channel, handler) {
        recorded.handles.push(channel);
        handlers.set(channel, handler);
      },
    },
    shell: {
      async openExternal(url) { recorded.shell.push(['openExternal', url]); },
      async openPath(target) { recorded.shell.push(['openPath', target]); return ''; },
    },
    app: { getPath: () => documents },
    dialog: {
      async showOpenDialog(...args) {
        recorded.dialogs.push(args);
        return { canceled: true, filePaths: [] };
      },
    },
  };
}

function fakeCoordinator() {
  const calls = [];
  const ok = (name) => (...args) => { calls.push([name, ...args]); return { ok: true }; };
  return {
    calls,
    snapshot() { calls.push(['snapshot']); return { items: [{ id: TASK_ID }] }; },
    create: ok('create'),
    remove: ok('remove'),
    assign: ok('assign'),
    retry: ok('retry'),
  };
}

// The same wiring main.js does, over fakes.
function wired(t, { flags = {} } = {}) {
  const dir = tempDir(t, 'au-ipc-register-');
  fs.writeFileSync(path.join(dir, 'GOALS.md'), '- [ ] goal\n');
  const tracker = fakeTracker({
    projects: [liveProject('alpha', dir), liveProject('lost', path.join(dir, 'gone'), { exists: false })],
  });
  const ctx = fakeCtx({ tracker, flags, rootTaskCoordinator: fakeCoordinator() });
  const launches = [];
  ctx.terminalLauncher = { async open(request) { launches.push(request); return { ok: true }; } };
  const electron = fakeElectron(dir);
  ctx.replay = createReplayControl(ctx);
  ctx.ipc = {
    terminal: createTerminalIpc(ctx),
    tasks: createTasksIpc(ctx),
    rootTasks: createRootTasksIpc(ctx),
    projectPaths: createProjectPathsIpc(ctx, electron),
  };
  registerIpc(ctx, { replay: ctx.replay, ...ctx.ipc }, electron);
  t.after(() => ctx.replay.reset());
  const invoke = (channel, event, ...args) => electron.handlers.get(channel)(event, ...args);
  return { ctx, electron, invoke, launches, dir };
}

test('registers every channel the preload bridge invokes, each exactly once', (t) => {
  const { electron } = wired(t);
  const channels = preloadChannels();
  assert.equal(new Set(channels).size, channels.length, 'preload invokes each channel once');
  assert.deepEqual([...electron.recorded.handles].sort(), [...channels].sort());
  assert.deepEqual(Object.keys(CALLS).sort(), [...channels].sort(), 'this test covers every channel');
});

test('every handler rejects a call from any frame but the trusted main frame, with no side effect', async (t) => {
  const { ctx, electron, invoke, launches, dir } = wired(t);
  const event = untrustedEvent(ctx.win);
  for (const [channel, [args, rejected]] of Object.entries(CALLS)) {
    assert.deepEqual(await invoke(channel, event, ...args), rejected, channel);
  }
  assert.deepEqual(electron.recorded.shell, []);
  assert.deepEqual(electron.recorded.dialogs, []);
  assert.deepEqual(launches, []);
  assert.deepEqual(ctx.rootTaskCoordinator.calls, []);
  assert.deepEqual(ctx.tracker.remapped, []);
  assert.deepEqual(ctx.replaySource.calls, []);
  assert.deepEqual(ctx.harness.openedProjects, []);
  assert.equal(ctx.activeSource, ctx.tracker);
  assert.equal(fs.readFileSync(path.join(dir, 'GOALS.md'), 'utf8'), '- [ ] goal\n');
});

test('the same calls from the trusted main frame reach their services', async (t) => {
  const { ctx, electron, invoke, launches } = wired(t);
  const event = trustedEvent(ctx.win);
  for (const [channel, [args, rejected]] of Object.entries(CALLS)) {
    const result = await invoke(channel, event, ...args);
    if (channel !== 'au:open') assert.notDeepEqual(result, rejected, channel);
  }
  assert.deepEqual(electron.recorded.shell.map(([name]) => name), ['openPath', 'openExternal']);
  assert.equal(electron.recorded.dialogs.length, 2);
  assert.deepEqual(ctx.rootTaskCoordinator.calls.map(([name]) => name), [
    'snapshot', 'create', 'remove', 'assign', 'retry',
  ]);
  assert.equal(launches.length, process.platform === 'win32' || process.platform === 'darwin' ? 1 : 0);
  assert.deepEqual(callNames(ctx.replaySource), ['seek', 'pause']);
  assert.equal(ctx.activeSource, ctx.replaySource);
});

test('au:open-external opens only canonical GitHub repository URLs', async (t) => {
  const { ctx, electron, invoke } = wired(t);
  const event = trustedEvent(ctx.win);
  assert.deepEqual(await invoke('au:open-external', event, 'git@github.com:example/project.git'), { ok: true });
  assert.deepEqual(electron.recorded.shell, [['openExternal', 'https://github.com/example/project']]);

  for (const url of ['https://example.com/example/project', 'javascript:alert(1)', 'https://github.com/a/b/c', 42]) {
    assert.deepEqual(await invoke('au:open-external', event, url), { ok: false, code: 'INVALID_URL' }, String(url));
  }
  electron.shell.openExternal = async () => { throw new Error('no browser'); };
  assert.deepEqual(await invoke('au:open-external', event, 'https://github.com/example/project'), {
    ok: false, code: 'OPEN_FAILED',
  });
  assert.equal(electron.recorded.shell.length, 1);
});

test('au:open opens a present local project folder; harness runs only record it', async (t) => {
  const { ctx, electron, invoke, dir } = wired(t);
  const event = trustedEvent(ctx.win);
  ctx.tracker.projects.set('unc', liveProject('unc', '\\\\server\\share\\project'));
  for (const id of ['lost', 'unc', 'unknown']) assert.equal(await invoke('au:open', event, id), '', id);
  assert.deepEqual(electron.recorded.shell, []);
  await invoke('au:open', event, 'alpha');
  assert.deepEqual(electron.recorded.shell, [['openPath', dir]]);

  for (const flag of ['polishTest', 'providerTest', 'historyTest', 'controlTest']) {
    const harness = wired(t, { flags: { [flag]: true } });
    assert.equal(await harness.invoke('au:open', trustedEvent(harness.ctx.win), 'alpha'), '');
    assert.deepEqual(harness.ctx.harness.openedProjects, ['alpha'], flag);
    assert.deepEqual(harness.electron.recorded.shell, [], flag);
  }
});

test('au:planet checks its arguments and reads the visible source', async (t) => {
  const { ctx, invoke } = wired(t);
  const event = trustedEvent(ctx.win);
  for (const args of [[7, 'src'], ['alpha', null], ['alpha', 'x'.repeat(256)]]) {
    assert.equal(await invoke('au:planet', event, ...args), null, JSON.stringify(args));
  }
  assert.deepEqual(await invoke('au:planet', event, 'alpha', 'x'.repeat(255)), {
    source: 'live', id: 'alpha', name: 'x'.repeat(255),
  });
  ctx.activeSource = ctx.replaySource;
  assert.equal((await invoke('au:planet', event, 'alpha', 'src')).source, 'replay');
});

test('au:snapshot and au:system serve what replay control makes visible', async (t) => {
  const { ctx, invoke } = wired(t);
  const event = trustedEvent(ctx.win);
  assert.deepEqual(await invoke('au:snapshot', event), ctx.replay.visibleSnapshot());
  assert.deepEqual(await invoke('au:system', event, 'alpha'), ctx.replay.visibleSystem('alpha'));
  ctx.activeSource = ctx.replaySource;
  assert.equal((await invoke('au:snapshot', event)).playback.mode, 'replay');
  assert.equal((await invoke('au:system', event, 'alpha')).source, 'replay');
});

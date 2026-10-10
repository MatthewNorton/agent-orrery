'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRootTasksIpc } = require('../src/main/ipc/root-tasks');
const { fakeCtx, fakeTracker, sentOn, trustedEvent, untrustedEvent } = require('./support/main-wiring');

const TASK_ID = '123e4567-e89b-42d3-a456-426614174000';

function fakeCoordinator() {
  const calls = [];
  const coordinator = { calls, failWith: null };
  const answer = (name, ...args) => {
    calls.push([name, ...args]);
    if (coordinator.failWith) throw coordinator.failWith;
    return { ok: true, item: { id: TASK_ID, via: name } };
  };
  coordinator.snapshot = () => {
    calls.push(['snapshot']);
    if (coordinator.failWith) throw coordinator.failWith;
    return { items: [{ id: TASK_ID }] };
  };
  coordinator.create = (text) => answer('create', text);
  coordinator.remove = (taskId) => answer('remove', taskId);
  coordinator.assign = async (taskId, projectId) => answer('assign', taskId, projectId);
  coordinator.retry = async (taskId) => answer('retry', taskId);
  return coordinator;
}

function rootCtx() {
  const ctx = fakeCtx({ rootTaskCoordinator: fakeCoordinator() });
  return { ctx, rootTasks: createRootTasksIpc(ctx), coordinator: ctx.rootTaskCoordinator, event: trustedEvent(ctx.win) };
}

function mutations(rootTasks, event) {
  return [
    () => rootTasks.handleRootTaskCreate(event, 'idea'),
    () => rootTasks.handleRootTaskRemove(event, TASK_ID),
    () => rootTasks.handleRootTaskAssign(event, TASK_ID, 'alpha'),
    () => rootTasks.handleRootTaskRetry(event, TASK_ID),
  ];
}

test('mutations pass straight through to the coordinator', async () => {
  const { rootTasks, coordinator, event } = rootCtx();
  const results = await Promise.all(mutations(rootTasks, event).map((call) => call()));
  assert.deepEqual(results.map((result) => result.item.via), ['create', 'remove', 'assign', 'retry']);
  assert.deepEqual(coordinator.calls, [
    ['create', 'idea'], ['remove', TASK_ID], ['assign', TASK_ID, 'alpha'], ['retry', TASK_ID],
  ]);
});

test('mutations are refused for untrusted frames, outside LIVE and without a coordinator', async () => {
  const { ctx, rootTasks, coordinator, event } = rootCtx();
  const denials = [
    ['INVALID', untrustedEvent(ctx.win), () => {}],
    ['REPLAY', event, () => { ctx.activeSource = ctx.replaySource; }],
    ['REPLAY', event, () => { ctx.activeSource = ctx.tracker; ctx.replay.replayBoundaryOperations = 2; }],
    ['REPLAY', event, () => { ctx.replay.replayBoundaryOperations = 0; ctx.tracker = null; }],
    ['FAILED', event, () => { ctx.tracker = fakeTracker(); ctx.activeSource = ctx.tracker; ctx.rootTaskCoordinator = null; }],
  ];
  for (const [code, denialEvent, arrange] of denials) {
    arrange();
    for (const call of mutations(rootTasks, denialEvent)) {
      assert.deepEqual(await call(), { ok: false, code }, code);
    }
  }
  assert.deepEqual(coordinator.calls, []);
});

test('a throwing or rejecting coordinator becomes FAILED', async () => {
  const { rootTasks, coordinator, event } = rootCtx();
  coordinator.failWith = new Error('disk full');
  for (const call of mutations(rootTasks, event)) {
    assert.deepEqual(await call(), { ok: false, code: 'FAILED' });
  }
  assert.equal(coordinator.calls.length, 4);
});

test('the queue snapshot is readable in any mode but only by the trusted frame', () => {
  const { ctx, rootTasks, coordinator, event } = rootCtx();
  assert.deepEqual(rootTasks.handleRootTasksGet(event), { items: [{ id: TASK_ID }] });
  ctx.activeSource = ctx.replaySource;
  assert.deepEqual(rootTasks.handleRootTasksGet(event), { items: [{ id: TASK_ID }] }, 'read-only in replay');

  assert.deepEqual(rootTasks.handleRootTasksGet(untrustedEvent(ctx.win)), { items: [] });
  coordinator.failWith = new Error('corrupt store');
  assert.deepEqual(rootTasks.handleRootTasksGet(event), { items: [] });
  ctx.rootTaskCoordinator = null;
  assert.deepEqual(rootTasks.handleRootTasksGet(event), { items: [] });
});

test('root-tasks-changed carries only the id and phase, and null once removed', () => {
  const { ctx, rootTasks } = rootCtx();
  rootTasks.sendRootTasksChanged({ id: TASK_ID, phase: 'running', text: 'private idea text' });
  rootTasks.sendRootTasksChanged({ id: TASK_ID, phase: 'queued' }, 'removed');
  rootTasks.sendRootTasksChanged({ id: TASK_ID, phase: 7 });
  assert.deepEqual(sentOn(ctx.win, 'au:root-tasks-changed'), [
    [{ taskId: TASK_ID, phase: 'running' }],
    [{ taskId: TASK_ID, phase: null }],
    [{ taskId: TASK_ID, phase: null }],
  ]);

  const win = ctx.win;
  win.sent.length = 0;
  rootTasks.sendRootTasksChanged(null);
  rootTasks.sendRootTasksChanged({ id: 42, phase: 'running' });
  win.destroyed = true;
  rootTasks.sendRootTasksChanged({ id: TASK_ID, phase: 'running' });
  ctx.win = null;
  assert.doesNotThrow(() => rootTasks.sendRootTasksChanged({ id: TASK_ID, phase: 'running' }));
  assert.deepEqual(win.sent, []);
});

test('liveProjectShips lists only the live ships of one project', () => {
  const ships = [{ id: 's1', project: 'alpha' }, { id: 's2', project: 'beta' }, { id: 's3', project: 'alpha' }];
  const { ctx, rootTasks } = rootCtx();
  ctx.tracker = fakeTracker({ ships });
  assert.deepEqual(rootTasks.liveProjectShips('alpha').map((ship) => ship.id), ['s1', 's3']);
  assert.deepEqual(rootTasks.liveProjectShips('gamma'), []);
  assert.deepEqual(rootTasks.liveProjectShips(''), []);
  ctx.tracker = null;
  assert.deepEqual(rootTasks.liveProjectShips('alpha'), []);
});

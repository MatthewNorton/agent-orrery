'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProjectVcsStatusController } = require('../src/main/project-vcs-status-controller');

function trackerWithProjects() {
  return {
    projects: new Map([
      ['one', { id: 'one', path: 'C:\\workspace\\one', exists: true }],
      ['two', { id: 'two', path: 'C:\\workspace\\two', exists: true }],
    ]),
  };
}

function fakeService() {
  const statuses = new Map([
    ['one', { projectId: 'one', state: 'ready', git: { branch: 'main' }, github: null }],
  ]);
  const calls = { refresh: [], project: [], clear: 0 };
  return {
    statuses,
    calls,
    async refresh(projects, options) {
      calls.refresh.push({ projects, options });
      return projects.map((project) => statuses.get(project.id) || null);
    },
    async refreshProject(project, options) {
      calls.project.push({ project, options });
      return statuses.get(project.id) || null;
    },
    get(projectId) { return statuses.get(projectId) || null; },
    clear() { calls.clear++; statuses.clear(); },
  };
}

test('starts one bounded refresh across the current tracker projects', async () => {
  const tracker = trackerWithProjects();
  const service = fakeService();
  const controller = createProjectVcsStatusController({ tracker, service });

  await controller.start();

  assert.equal(service.calls.refresh.length, 1);
  assert.deepEqual(service.calls.refresh[0].projects, [...tracker.projects.values()]);
});

test('enriches only live tracker snapshots and systems without mutating source data', () => {
  const tracker = trackerWithProjects();
  const replay = { projects: new Map() };
  const service = fakeService();
  const controller = createProjectVcsStatusController({ tracker, service });
  const snapshot = { projects: [{ id: 'one', name: 'One' }], ships: [] };
  const system = { project: { id: 'one', name: 'One' }, planets: [] };

  const liveSnapshot = controller.enrichSnapshot(tracker, snapshot);
  const liveSystem = controller.enrichSystem(tracker, system);

  assert.equal(liveSnapshot.projects[0].vcs, service.statuses.get('one'));
  assert.equal(liveSystem.project.vcs, service.statuses.get('one'));
  assert.equal(Object.hasOwn(snapshot.projects[0], 'vcs'), false);
  assert.equal(Object.hasOwn(system.project, 'vcs'), false);
  assert.equal(controller.enrichSnapshot(replay, snapshot), snapshot);
  assert.equal(controller.enrichSystem(replay, system), system);
});

test('debounces project discovery and build events into forced project refreshes', async () => {
  const tracker = trackerWithProjects();
  const service = fakeService();
  const timers = new Map();
  let timerId = 0;
  const cancelled = [];
  const controller = createProjectVcsStatusController({
    tracker,
    service,
    debounceMs: 25,
    schedule(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    cancel(id) { cancelled.push(id); timers.delete(id); },
  });

  controller.observeEvents([
    { type: 'project-updated', project: { id: 'one' } },
    { type: 'build', project: 'one' },
    { type: 'feed', project: 'two' },
    { type: 'build', project: 'missing' },
  ]);

  assert.deepEqual(cancelled, [1]);
  assert.equal(timers.size, 1);
  const timer = [...timers.values()][0];
  assert.equal(timer.delay, 25);
  timer.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.calls.project.length, 1);
  assert.equal(service.calls.project[0].project.id, 'one');
  assert.deepEqual(service.calls.project[0].options, { force: true });
});

test('refreshProject rejects unknown IDs and returns sanitized service data', async () => {
  const tracker = trackerWithProjects();
  const service = fakeService();
  const controller = createProjectVcsStatusController({ tracker, service });

  assert.equal(await controller.refreshProject('missing'), null);
  assert.equal(await controller.refreshProject('one'), service.statuses.get('one'));
  assert.equal(service.calls.project.length, 1);
});

test('contains service and observer errors', async () => {
  const tracker = trackerWithProjects();
  const errors = [];
  const service = fakeService();
  service.refresh = async () => { throw new Error('private refresh failure'); };
  service.refreshProject = async () => { throw new Error('private project failure'); };
  const controller = createProjectVcsStatusController({
    tracker,
    service,
    onError(error) { errors.push(error.message); },
  });

  assert.deepEqual(await controller.refreshAll(), []);
  assert.equal(await controller.refreshProject('one'), null);
  assert.deepEqual(errors, ['private refresh failure', 'private project failure']);
});

test('stop cancels pending refreshes, clears status, and makes future work inert', async () => {
  const tracker = trackerWithProjects();
  const service = fakeService();
  const timers = new Map();
  let timerId = 0;
  const cancelled = [];
  const controller = createProjectVcsStatusController({
    tracker,
    service,
    schedule(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    cancel(id) { cancelled.push(id); timers.delete(id); },
  });
  controller.observeEvents([{ type: 'build', project: 'one' }]);

  controller.stop();

  assert.deepEqual(cancelled, [1]);
  assert.equal(service.calls.clear, 1);
  assert.deepEqual(await controller.refreshAll(), []);
  assert.equal(await controller.refreshProject('one'), null);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureAssignedGoal, readGoalsFile } = require('../src/main/goals');
const { RootTaskCoordinator } = require('../src/main/root-task-coordinator');
const { RootTaskStore } = require('../src/main/root-tasks');
const { TaskRunTracker } = require('../src/main/task-runs');

const TASK_ID = '123e4567-e89b-42d3-a456-426614174000';
const OTHER_ID = '223e4567-e89b-42d3-a456-426614174000';

async function withWorkflow(options, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-universe-root-workflow-'));
  const projects = new Map([
    ['project-one', path.join(root, 'project-one')],
    ['project-two', path.join(root, 'project-two')],
  ]);
  for (const project of projects.values()) fs.mkdirSync(project);
  let idIndex = 0;
  let now = 10_000;
  const ids = [TASK_ID, OTHER_ID];
  const store = new RootTaskStore({
    statePath: path.join(root, 'root-tasks.json'),
    randomUUID: () => ids[idIndex++],
    now: () => now,
  });
  const launches = [];
  const launchResults = [...(options.launchResults || [{ ok: true }])];
  const launcher = options.launcher || {
    async launch(request) {
      launches.push({ ...request });
      const result = launchResults.length > 0 ? launchResults.shift() : { ok: true };
      return typeof result === 'function' ? result(request) : result;
    },
  };
  let coordinator = null;
  const taskRuns = new TaskRunTracker({
    statePath: path.join(root, 'task-runs.json'),
    resolveProjectRoot: (projectId) => projects.get(projectId) || null,
    now: () => now,
    onChange: ({ run: changedRun }) => {
      if (options.persistRunPhases !== false && coordinator) coordinator.observeRun(changedRun);
    },
  });
  const changes = [];
  coordinator = new RootTaskCoordinator({
    store,
    taskRuns,
    launcher,
    resolveProjectRoot: (projectId) => projects.get(projectId) || null,
    listShips: () => options.ships || [],
    ensureGoal: options.ensureGoal,
    onChange: (change) => changes.push(change),
  });
  try {
    await run({
      root,
      projects,
      store,
      taskRuns,
      coordinator,
      launcher,
      launches,
      changes,
      setNow(value) { now = value; },
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function markerCount(project, taskId) {
  const source = fs.readFileSync(path.join(project, 'GOALS.md'), 'utf8');
  return source.split(`agent-universe:${taskId}`).length - 1;
}

test('removes an unlocked idea and emits a bounded deletion notification', async () => {
  await withWorkflow({}, async ({ store, coordinator, changes, projects }) => {
    const created = coordinator.create('Remove from the global queue');
    assert.equal(created.ok, true);

    const removed = coordinator.remove(TASK_ID.toUpperCase());
    assert.deepEqual(removed, { ok: true, item: created.item });
    assert.deepEqual(coordinator.snapshot(), { items: [] });
    assert.deepEqual(changes.at(-1), { reason: 'removed', item: created.item });
    assert.deepEqual(coordinator.remove('not-an-id'), { ok: false, code: 'INVALID' });
    assert.deepEqual(coordinator.remove(TASK_ID), { ok: false, code: 'NOT_FOUND' });

    const kept = coordinator.create('Keep assigned work');
    const originalRemove = store.remove.bind(store);
    store.remove = () => { throw new Error('unexpected storage failure'); };
    assert.deepEqual(coordinator.remove(OTHER_ID), { ok: false, code: 'FAILED' });
    store.remove = originalRemove;
    store.prepare(OTHER_ID, 'project-one');
    store.markGoalWritten(OTHER_ID);
    store.markLaunchRequested(OTHER_ID);
    assert.deepEqual(coordinator.remove(OTHER_ID), { ok: false, code: 'INVALID_TRANSITION' },
      'a start in flight keeps its record');
    assert.equal(coordinator.snapshot().items[0].id, kept.item.id);

    store.markRunPhase(OTHER_ID, 'project-one', 'launch-failed');
    const project = projects.get('project-one');
    ensureAssignedGoal(project, { id: OTHER_ID, text: kept.item.text });
    assert.equal(markerCount(project, OTHER_ID), 1);
    assert.equal(coordinator.remove(OTHER_ID).ok, true, 'an assigned idea goes once it is not starting');
    assert.deepEqual(coordinator.snapshot(), { items: [] });
    assert.equal(markerCount(project, OTHER_ID), 0, 'its unfinished GOALS.md line goes with it');
  });
});

test('assigns an idea with persisted ordering, a filtered baseline, and exact launch input', async () => {
  const events = [];
  await withWorkflow({
    ships: [
      { id: 'codex:old', provider: 'codex', project: 'project-one', kind: 'main' },
      { id: 'codex:old', provider: 'codex', project: 'project-one', kind: 'main' },
      { id: 'codex:drone', provider: 'codex', project: 'project-one', kind: 'drone' },
      { id: 'claude:old', provider: 'claude', project: 'project-one', kind: 'main' },
      { id: 'codex:elsewhere', provider: 'codex', project: 'project-two', kind: 'main' },
    ],
    ensureGoal(project, item) {
      events.push('goal.ensure');
      return ensureAssignedGoal(project, item);
    },
    launchResults: [() => {
      events.push('launcher.launch');
      return { ok: true };
    }],
  }, async ({ root, projects, store, taskRuns, coordinator, launches }) => {
    const created = coordinator.create('Build the root workflow');
    assert.equal(created.ok, true);

    for (const method of ['prepare', 'markGoalWritten', 'markLaunchRequested']) {
      const original = store[method].bind(store);
      store[method] = (...args) => {
        events.push(`store.${method}`);
        return original(...args);
      };
    }
    const originalStart = taskRuns.start.bind(taskRuns);
    taskRuns.start = (input) => {
      events.push('runs.start');
      return originalStart(input);
    };

    const assigned = await coordinator.assign(TASK_ID, 'project-one');
    assert.equal(assigned.ok, true);
    assert.equal(assigned.item.phase, 'agent-working');
    assert.deepEqual(events, [
      'store.prepare',
      'goal.ensure',
      'store.markGoalWritten',
      'runs.start',
      'store.markLaunchRequested',
      'launcher.launch',
    ]);
    assert.deepEqual(launches, [{
      cwd: projects.get('project-one'),
      taskId: TASK_ID,
    }]);
    assert.deepEqual(Object.keys(launches[0]), ['cwd', 'taskId']);

    const persistedRun = JSON.parse(fs.readFileSync(path.join(root, 'task-runs.json'), 'utf8'))
      .runs.find((item) => item.id === TASK_ID);
    assert.deepEqual(persistedRun.baselineShipIds, ['codex:old']);
    assert.equal(store.get(TASK_ID).phase, 'launch-requested');
    assert.equal(markerCount(projects.get('project-one'), TASK_ID), 1);

    taskRuns.observe([{
      type: 'ship-spawned',
      ship: {
        id: 'codex:new', provider: 'codex', project: 'project-one', kind: 'main',
        attention: null, lastEvent: 10_010, taskId: TASK_ID,
      },
    }]);
    assert.equal(coordinator.snapshot().items[0].phase, 'agent-working');
    taskRuns.observe([{
      type: 'ship-updated',
      ship: {
        id: 'codex:new', provider: 'codex', project: 'project-one', kind: 'main',
        attention: 'done', lastEvent: 10_020, taskId: TASK_ID,
      },
    }]);
    assert.equal(coordinator.snapshot().items[0].phase, 'ready-for-review');
    assert.equal(store.get(TASK_ID).phase, 'ready-for-review');
    assert.equal(readGoalsFile(projects.get('project-one')).items[0].done, true);

    const emptyRuns = new TaskRunTracker({
      statePath: path.join(root, 'pruned-task-runs.json'),
      resolveProjectRoot: () => projects.get('project-one'),
    });
    const afterPrune = new RootTaskCoordinator({
      store,
      taskRuns: emptyRuns,
      launcher: { launch: async () => ({ ok: true }) },
      resolveProjectRoot: () => projects.get('project-one'),
      listShips: () => [],
    });
    assert.equal(afterPrune.snapshot().items[0].phase, 'ready-for-review');
  });
});

test('resumes every pre-launch crash state without duplicating the exact goal', async (t) => {
  for (const crashPhase of ['prepared', 'goal-written', 'run-started']) {
    await t.test(crashPhase, async () => {
      await withWorkflow({}, async ({ projects, store, taskRuns, coordinator, launches }) => {
        coordinator.create(`Resume from ${crashPhase}`);
        store.prepare(TASK_ID, 'project-one');
        ensureAssignedGoal(projects.get('project-one'), {
          id: TASK_ID,
          text: `Resume from ${crashPhase}`,
        });
        if (crashPhase !== 'prepared') store.markGoalWritten(TASK_ID);
        if (crashPhase === 'run-started') {
          taskRuns.start({
            id: TASK_ID,
            projectId: 'project-one',
            text: `Resume from ${crashPhase}`,
            provider: 'codex',
            baselineShipIds: ['codex:old'],
          });
          assert.equal(coordinator.snapshot().items[0].phase, 'goal-written');
        }

        const retried = await coordinator.retry(TASK_ID);
        assert.equal(retried.ok, true);
        assert.equal(retried.item.phase, 'agent-working');
        assert.equal(markerCount(projects.get('project-one'), TASK_ID), 1);
        const goals = readGoalsFile(projects.get('project-one')).items;
        assert.deepEqual(goals.map(({ id, text, done }) => ({ id, text, done })), [{
          id: TASK_ID,
          text: `Resume from ${crashPhase}`,
          done: false,
        }]);
        assert.deepEqual(launches, [{
          cwd: projects.get('project-one'),
          taskId: TASK_ID,
        }]);
      });
    });
  }
});

test('enforces task and project locks and active-run project exclusivity', async () => {
  let releaseLaunch;
  let launchStarted;
  const started = new Promise((resolve) => { launchStarted = resolve; });
  const blockedLaunch = new Promise((resolve) => { releaseLaunch = resolve; });
  await withWorkflow({
    launcher: {
      launch(request) {
        launchStarted(request);
        return blockedLaunch;
      },
    },
  }, async ({ coordinator }) => {
    coordinator.create('First locked task');
    coordinator.create('Second locked task');
    const pending = coordinator.assign(TASK_ID, 'project-one');
    await started;

    assert.deepEqual(coordinator.remove(TASK_ID), { ok: false, code: 'BUSY' });
    assert.deepEqual(await coordinator.retry(TASK_ID), { ok: false, code: 'BUSY' });
    assert.deepEqual(await coordinator.assign(OTHER_ID, 'project-one'), {
      ok: false,
      code: 'PROJECT_BUSY',
    });
    releaseLaunch({ ok: true });
    assert.equal((await pending).ok, true);
    assert.deepEqual(coordinator.remove(TASK_ID), { ok: false, code: 'BUSY' });

    assert.deepEqual(await coordinator.assign(OTHER_ID, 'project-one'), {
      ok: false,
      code: 'PROJECT_BUSY',
    });
  });
});

test('marks launcher failures in both stores and retries without another goal', async () => {
  await withWorkflow({
    launchResults: [{ ok: false, code: 'UNAVAILABLE' }, { ok: true }],
  }, async ({ projects, store, taskRuns, coordinator, launches }) => {
    coordinator.create('Retry this launch');
    assert.deepEqual(await coordinator.assign(TASK_ID, 'project-one'), {
      ok: false,
      code: 'UNAVAILABLE',
    });
    assert.equal(store.get(TASK_ID).phase, 'launch-failed');
    assert.equal(taskRuns.get(TASK_ID).phase, 'launch-failed');
    assert.equal(coordinator.snapshot().items[0].phase, 'launch-failed');

    const retried = await coordinator.retry(TASK_ID);
    assert.equal(retried.ok, true);
    assert.equal(store.get(TASK_ID).phase, 'launch-requested');
    assert.equal(taskRuns.get(TASK_ID).phase, 'waiting-for-agent');
    assert.equal(markerCount(projects.get('project-one'), TASK_ID), 1);
    assert.deepEqual(launches, [
      { cwd: projects.get('project-one'), taskId: TASK_ID },
      { cwd: projects.get('project-one'), taskId: TASK_ID },
    ]);
  });
});

test('retries launch-requested only after its run reaches a retryable terminal phase', async () => {
  await withWorkflow({
    persistRunPhases: false,
    launchResults: [{ ok: true }, { ok: true }],
  }, async ({ store, taskRuns, coordinator, setNow }) => {
    coordinator.create('Recover a missing agent');
    assert.equal((await coordinator.assign(TASK_ID, 'project-one')).ok, true);
    assert.equal(store.get(TASK_ID).phase, 'launch-requested');
    assert.deepEqual(await coordinator.retry(TASK_ID), { ok: false, code: 'BUSY' });

    setNow(310_000);
    taskRuns.expire();
    assert.equal(taskRuns.get(TASK_ID).phase, 'agent-not-found');
    assert.equal(store.get(TASK_ID).phase, 'launch-requested');
    const retried = await coordinator.retry(TASK_ID);
    assert.equal(retried.ok, true);
    assert.equal(taskRuns.get(TASK_ID).phase, 'waiting-for-agent');
  });
});

test('returns bounded failures before assigning an idea to an unavailable project', async () => {
  await withWorkflow({}, async ({ store, coordinator }) => {
    coordinator.create('Stay global');
    assert.deepEqual(await coordinator.assign(TASK_ID, 'missing-project'), {
      ok: false,
      code: 'PROJECT_NOT_FOUND',
    });
    assert.equal(store.get(TASK_ID).phase, 'idea');
    assert.deepEqual(await coordinator.assign('not-an-id', 'project-one'), {
      ok: false,
      code: 'INVALID',
    });
    assert.deepEqual(await coordinator.retry(OTHER_ID), {
      ok: false,
      code: 'NOT_FOUND',
    });
  });
});

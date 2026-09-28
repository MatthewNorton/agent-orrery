'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  appendGoal,
  completeAssignedGoal,
  ensureAssignedGoal,
  parseGoals,
  readGoalsFile,
  removeGoal,
  serializeGoals,
  setGoalDone,
  writeGoalsFile,
} = require('../src/main/goals');
const { codexRecordToSignals } = require('../src/main/provider-adapters');
const { TaskRunTracker } = require('../src/main/task-runs');

const TASK_ID = '123e4567-e89b-42d3-a456-426614174000';
const OTHER_ID = '223e4567-e89b-42d3-a456-426614174000';

function numberedId(index) {
  return `323e4567-e89b-42d3-a456-${index.toString(16).padStart(12, '0')}`;
}

function storedRun(index, phase = 'launch-failed', text = `Task ${index}`) {
  return {
    id: numberedId(index),
    projectId: `project-${index}`,
    text,
    provider: 'codex',
    phase,
    shipId: null,
    baselineShipIds: [],
    startedAt: index,
    updatedAt: index,
    completedAt: null,
  };
}

function markerCountForGoal(project, id) {
  const source = fs.readFileSync(path.join(project, 'GOALS.md'), 'utf8');
  return source.split(`agent-universe:${id}`).length - 1;
}

function withTempProject(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-universe-task-runs-'));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  try {
    return run({ root, project, statePath: path.join(root, 'task-runs.json') });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function ship(overrides = {}) {
  return {
    id: 'codex:new-session', project: 'project-1', provider: 'codex', kind: 'main',
    attention: null, lastEvent: 10_010, taskId: TASK_ID,
    ...overrides,
  };
}

test('assigned goal markers stay hidden, round-trip, and append idempotently', () => {
  withTempProject(({ project }) => {
    const created = ensureAssignedGoal(project, { id: TASK_ID, text: 'Ship the workflow' });
    assert.equal(created.created, true);
    const source = fs.readFileSync(path.join(project, 'GOALS.md'), 'utf8');
    assert.match(source, new RegExp(`agent-universe:${TASK_ID}`));
    assert.deepEqual(parseGoals(source).items, [{
      id: TASK_ID, text: 'Ship the workflow', done: false, line: 2,
    }]);
    assert.equal(serializeGoals(source, parseGoals(source).items), source);
    assert.equal(
      ensureAssignedGoal(project, { id: TASK_ID, text: 'Ship the workflow' }).created,
      false
    );
    assert.equal(parseGoals(fs.readFileSync(path.join(project, 'GOALS.md'), 'utf8')).items.length, 1);
  });
});

test('goal IDs can be attached but never changed or duplicated', () => {
  withTempProject(({ project }) => {
    const source = '- [ ] Existing task\n';
    const withId = serializeGoals(source, [{
      ...parseGoals(source).items[0],
      id: TASK_ID,
    }]);
    assert.match(withId, new RegExp(`agent-universe:${TASK_ID}`));
    assert.throws(() => serializeGoals(withId, [{
      ...parseGoals(withId).items[0],
      id: OTHER_ID,
    }]), /cannot be changed/);
    assert.throws(() => writeGoalsFile(project, [
      { id: TASK_ID, text: 'One', done: false },
      { id: TASK_ID, text: 'Two', done: false },
    ]), /Duplicate goal id/);
  });
});

test('a claimed Codex session checks only its tagged goal and marks it ready for review', () => {
  withTempProject(({ project, statePath }) => {
    fs.writeFileSync(path.join(project, 'GOALS.md'), '# Goals\r\n\r\nKeep this prose.\r\n');
    ensureAssignedGoal(project, { id: TASK_ID, text: 'Ship the workflow' });
    ensureAssignedGoal(project, { id: OTHER_ID, text: 'Leave this open' });
    let now = 10_000;
    const changes = [];
    const tracker = new TaskRunTracker({
      statePath,
      resolveProjectRoot: (projectId) => projectId === 'project-1' ? project : null,
      now: () => now,
      onChange: (change) => changes.push(change),
    });
    tracker.start({
      id: TASK_ID, projectId: 'project-1', text: 'Ship the workflow', provider: 'codex',
      baselineShipIds: ['codex:old-session'],
    });
    tracker.observe([{ type: 'ship-spawned', ship: ship() }]);
    assert.equal(tracker.get(TASK_ID).phase, 'running');
    assert.equal(
      tracker.decorate('project-1', readGoalsFile(project).items)[0].agentStatus,
      'agent-working'
    );

    now = 20_000;
    tracker.observe([{ type: 'ship-updated', ship: ship({ attention: 'done', lastEvent: 19_000 }) }]);
    const goals = readGoalsFile(project).items;
    assert.equal(goals.find((goal) => goal.id === TASK_ID).done, true);
    assert.equal(goals.find((goal) => goal.id === OTHER_ID).done, false);
    assert.equal(tracker.decorate('project-1', goals)[0].agentStatus, 'ready-for-review');
    assert.match(fs.readFileSync(path.join(project, 'GOALS.md'), 'utf8'), /Keep this prose\.\r\n/);
    assert.equal(changes.filter((change) => change.reason === 'ready-for-review').length, 1);
    assert.equal(new TaskRunTracker({
      statePath,
      resolveProjectRoot: () => project,
    }).get(TASK_ID).phase, 'ready-for-review');

    tracker.observe([{ type: 'ship-updated', ship: ship({ attention: 'done', lastEvent: 19_000 }) }]);
    assert.equal(changes.filter((change) => change.reason === 'ready-for-review').length, 1);

    const edited = readGoalsFile(project).items.map((goal) => (
      goal.id === TASK_ID ? { ...goal, text: 'Changed after completion' } : goal
    ));
    writeGoalsFile(project, edited);
    tracker.reconcile('project-1', readGoalsFile(project).items);
    assert.equal(tracker.get(TASK_ID).phase, 'reopened');
    assert.equal(
      tracker.decorate('project-1', readGoalsFile(project).items)[0].agentStatus,
      undefined
    );
  });
});

test('targeted task updates preserve an automatic completion from a stale view', () => {
  withTempProject(({ project }) => {
    ensureAssignedGoal(project, { id: TASK_ID, text: 'Agent task' });
    appendGoal(project, 'Manual task');
    const staleManual = readGoalsFile(project).items.find((goal) => goal.text === 'Manual task');
    completeAssignedGoal(project, { id: TASK_ID, text: 'Agent task' });
    setGoalDone(project, {
      line: staleManual.line,
      text: staleManual.text,
      done: true,
    });
    const goals = readGoalsFile(project).items;
    assert.equal(goals.find((goal) => goal.id === TASK_ID).done, true);
    assert.equal(goals.find((goal) => goal.text === 'Manual task').done, true);
  });
});

test('manual goal removal preserves prose and line endings and rejects stale or assigned targets', () => {
  withTempProject(({ project }) => {
    const source = '# Goals\r\n\r\nKeep this prose.\r\n' +
      '- [ ] Duplicate task\r\n' +
      `- [x] Agent task <!-- agent-universe:${TASK_ID} -->\r\n` +
      '- [ ] Duplicate task\r\n' +
      'Keep this footer too.\r\n';
    const goalsPath = path.join(project, 'GOALS.md');
    fs.writeFileSync(goalsPath, source);
    const before = readGoalsFile(project);
    const target = before.items.at(-1);

    const removed = removeGoal(project, { line: target.line, text: target.text });
    assert.deepEqual(removed.item, target);
    assert.equal(fs.readFileSync(goalsPath, 'utf8'), '# Goals\r\n\r\nKeep this prose.\r\n' +
      '- [ ] Duplicate task\r\n' +
      `- [x] Agent task <!-- agent-universe:${TASK_ID} -->\r\n` +
      'Keep this footer too.\r\n');
    assert.deepEqual(removed.items.map(({ id, text, done }) => ({ id, text, done })), [
      { id: undefined, text: 'Duplicate task', done: false },
      { id: TASK_ID, text: 'Agent task', done: true },
    ]);

    const unchanged = fs.readFileSync(goalsPath, 'utf8');
    const assigned = removed.items.find((item) => item.id === TASK_ID);
    assert.throws(() => removeGoal(project, {
      line: assigned.line,
      text: assigned.text,
    }), /Goal changed/);
    assert.throws(() => removeGoal(project, {
      line: target.line,
      text: target.text,
    }), /Goal changed/);
    assert.throws(() => removeGoal(project, {
      id: TASK_ID,
      line: assigned.line,
      text: assigned.text,
    }), /Invalid goal removal/);
    assert.equal(fs.readFileSync(goalsPath, 'utf8'), unchanged);
  });
});

test('only one active task run can wait in a project', () => {
  withTempProject(({ project, statePath }) => {
    const tracker = new TaskRunTracker({
      statePath,
      resolveProjectRoot: () => project,
      now: () => 10_000,
    });
    tracker.start({
      id: TASK_ID, projectId: 'project-1', text: 'First', provider: 'codex',
      baselineShipIds: [],
    });
    assert.throws(() => tracker.start({
      id: OTHER_ID, projectId: 'project-1', text: 'Second', provider: 'codex',
      baselineShipIds: [],
    }), (error) => error && error.code === 'PROJECT_BUSY');
    assert.equal(tracker.get(OTHER_ID), null);
  });
});

test('a failed start persistence leaves no in-memory run to launch', () => {
  withTempProject(({ project, statePath }) => {
    let failRename = true;
    const fsImpl = {
      ...fs,
      renameSync(from, to) {
        if (failRename) {
          const error = new Error('simulated task-run rename failure');
          error.code = 'EIO';
          throw error;
        }
        return fs.renameSync(from, to);
      },
    };
    const tracker = new TaskRunTracker({
      statePath,
      resolveProjectRoot: () => project,
      now: () => 10_000,
      fsImpl,
    });
    const input = {
      id: TASK_ID, projectId: 'project-1', text: 'Durable first', provider: 'codex',
      baselineShipIds: [],
    };
    assert.throws(() => tracker.start(input), /simulated task-run rename failure/);
    assert.equal(tracker.get(TASK_ID), null);
    assert.equal(tracker.activeForProject('project-1'), null);

    failRename = false;
    assert.equal(tracker.start(input).phase, 'waiting-for-agent');
    assert.equal(new TaskRunTracker({
      statePath,
      resolveProjectRoot: () => project,
    }).get(TASK_ID).phase, 'waiting-for-agent');
  });
});

test('claim and terminal transitions roll back when persistence fails', () => {
  withTempProject(({ project, statePath }) => {
    let failRename = false;
    const changes = [];
    const fsImpl = {
      ...fs,
      renameSync(from, to) {
        if (failRename) {
          const error = new Error('simulated transition failure');
          error.code = 'EIO';
          throw error;
        }
        return fs.renameSync(from, to);
      },
    };
    const tracker = new TaskRunTracker({
      statePath,
      resolveProjectRoot: () => project,
      now: () => 10_000,
      fsImpl,
      onChange: (change) => changes.push(change),
    });
    tracker.start({
      id: TASK_ID, projectId: 'project-1', text: 'Transactional run', provider: 'codex',
      baselineShipIds: [],
    });
    changes.length = 0;
    failRename = true;
    assert.throws(() => tracker.observe([{
      type: 'ship-spawned',
      ship: ship(),
    }]), /simulated transition failure/);
    assert.equal(tracker.get(TASK_ID).phase, 'waiting-for-agent');
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).runs[0].phase,
      'waiting-for-agent');
    assert.deepEqual(changes, []);

    failRename = false;
    tracker.observe([{ type: 'ship-spawned', ship: ship() }]);
    assert.equal(tracker.get(TASK_ID).phase, 'running');
    changes.length = 0;
    failRename = true;
    assert.throws(() => tracker.failLaunch(TASK_ID), /simulated transition failure/);
    assert.equal(tracker.get(TASK_ID).phase, 'running');
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).runs[0].phase, 'running');
    assert.deepEqual(changes, []);

    failRename = false;
    assert.equal(tracker.failLaunch(TASK_ID).phase, 'launch-failed');
    assert.equal(changes[0].reason, 'launch-failed');
  });
});

test('completion does not check the goal until completing state is durable', () => {
  withTempProject(({ project, statePath }) => {
    ensureAssignedGoal(project, { id: TASK_ID, text: 'Durable completion' });
    let failRename = false;
    const fsImpl = {
      ...fs,
      renameSync(from, to) {
        if (failRename) {
          const error = new Error('simulated completing failure');
          error.code = 'EIO';
          throw error;
        }
        return fs.renameSync(from, to);
      },
    };
    const tracker = new TaskRunTracker({
      statePath,
      resolveProjectRoot: () => project,
      now: () => 10_000,
      fsImpl,
    });
    tracker.start({
      id: TASK_ID, projectId: 'project-1', text: 'Durable completion', provider: 'codex',
      baselineShipIds: [],
    });
    tracker.observe([{ type: 'ship-spawned', ship: ship() }]);

    failRename = true;
    assert.throws(() => tracker.observe([{
      type: 'ship-updated', ship: ship({ attention: 'done' }),
    }]), /simulated completing failure/);
    assert.equal(tracker.get(TASK_ID).phase, 'running');
    assert.equal(readGoalsFile(project).items[0].done, false);
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).runs[0].phase, 'running');

    failRename = false;
    tracker.observe([{
      type: 'ship-updated', ship: ship({ attention: 'done' }),
    }]);
    assert.equal(tracker.get(TASK_ID).phase, 'ready-for-review');
    assert.equal(readGoalsFile(project).items[0].done, true);
  });
});

test('a durable completing run recovers after the final ready write fails', () => {
  withTempProject(({ project, statePath }) => {
    ensureAssignedGoal(project, { id: TASK_ID, text: 'Recover completion' });
    let renameCount = 0;
    let failOnRename = -1;
    const changes = [];
    const fsImpl = {
      ...fs,
      renameSync(from, to) {
        renameCount++;
        if (renameCount === failOnRename) {
          const error = new Error('simulated ready failure');
          error.code = 'EIO';
          throw error;
        }
        return fs.renameSync(from, to);
      },
    };
    const tracker = new TaskRunTracker({
      statePath,
      resolveProjectRoot: () => project,
      now: () => 10_000,
      fsImpl,
      onChange: (change) => changes.push(change),
    });
    tracker.start({
      id: TASK_ID, projectId: 'project-1', text: 'Recover completion', provider: 'codex',
      baselineShipIds: [],
    });
    tracker.observe([{ type: 'ship-spawned', ship: ship() }]);
    changes.length = 0;
    failOnRename = renameCount + 2;

    assert.throws(() => tracker.observe([{
      type: 'ship-updated', ship: ship({ attention: 'done' }),
    }]), /simulated ready failure/);
    assert.equal(readGoalsFile(project).items[0].done, true);
    assert.equal(tracker.get(TASK_ID).phase, 'completing');
    assert.equal(tracker.activeForProject('project-1').phase, 'completing');
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).runs[0].phase, 'completing');
    assert.deepEqual(changes, []);
    assert.throws(() => tracker.start({
      id: OTHER_ID, projectId: 'project-1', text: 'Must wait', provider: 'codex',
      baselineShipIds: [],
    }), (error) => error && error.code === 'PROJECT_BUSY');

    const recoveryChanges = [];
    const recovered = new TaskRunTracker({
      statePath,
      resolveProjectRoot: () => project,
      now: () => 20_000,
      onChange: (change) => recoveryChanges.push(change),
    });
    assert.equal(recovered.get(TASK_ID).phase, 'ready-for-review');
    assert.equal(recovered.activeForProject('project-1'), null);
    assert.equal(recoveryChanges.length, 1);
    assert.equal(recoveryChanges[0].reason, 'ready-for-review');
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).runs[0].phase,
      'ready-for-review');
    assert.equal(markerCountForGoal(project, TASK_ID), 1);
  });
});

test('pruning keeps an old active run ahead of newer terminal history', () => {
  withTempProject(({ project, statePath }) => {
    const runs = [
      storedRun(1, 'waiting-for-agent'),
      ...Array.from({ length: 499 }, (_, index) => storedRun(index + 2)),
    ];
    fs.writeFileSync(statePath, JSON.stringify({ version: 1, runs }));
    const tracker = new TaskRunTracker({
      statePath,
      resolveProjectRoot: () => project,
      now: () => 1_000,
    });
    tracker.start({
      id: numberedId(501), projectId: 'project-501', text: 'Newest active', provider: 'codex',
      baselineShipIds: [],
    });

    assert.equal(tracker.get(numberedId(1)).phase, 'waiting-for-agent');
    assert.equal(tracker.get(numberedId(501)).phase, 'waiting-for-agent');
    assert.equal(tracker.get(numberedId(2)), null);
    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8')).runs;
    assert.equal(persisted.length, 500);
    assert.ok(persisted.some((run) => run.id === numberedId(1)));
    assert.ok(persisted.some((run) => run.id === numberedId(501)));
  });
});

test('loading oversized legacy history keeps old active correlation state', () => {
  withTempProject(({ project, statePath }) => {
    const runs = [
      storedRun(1, 'waiting-for-agent'),
      ...Array.from({ length: 500 }, (_, index) => storedRun(index + 2)),
    ];
    fs.writeFileSync(statePath, JSON.stringify({ version: 1, runs }));
    const tracker = new TaskRunTracker({
      statePath,
      resolveProjectRoot: () => project,
    });
    assert.equal(tracker.runs.length, 500);
    assert.equal(tracker.get(numberedId(1)).phase, 'waiting-for-agent');
    assert.equal(tracker.get(numberedId(2)), null);
    assert.equal(tracker.get(numberedId(501)).phase, 'launch-failed');
  });
});

test('a start cannot create task-run state too large to reload', () => {
  withTempProject(({ project, statePath }) => {
    const maxBytes = 2 * 1024 * 1024;
    const runs = [];
    while (runs.length < 500) {
      const next = storedRun(runs.length + 1, 'launch-failed', 'x'.repeat(10_000));
      const serialized = JSON.stringify({ version: 1, runs: [...runs, next] });
      if (Buffer.byteLength(serialized, 'utf8') > maxBytes) break;
      runs.push(next);
    }
    assert.ok(runs.length > 0 && runs.length < 500);
    const original = JSON.stringify({ version: 1, runs });
    fs.writeFileSync(statePath, original);
    const tracker = new TaskRunTracker({
      statePath,
      resolveProjectRoot: () => project,
      now: () => 10_000,
    });
    assert.throws(() => tracker.start({
      id: numberedId(runs.length + 1),
      projectId: `project-${runs.length + 1}`,
      text: 'y'.repeat(10_000),
      provider: 'codex',
      baselineShipIds: [],
    }), (error) => error && error.code === 'LIMIT_REACHED');
    assert.equal(tracker.get(numberedId(runs.length + 1)), null);
    assert.equal(fs.readFileSync(statePath, 'utf8'), original);
    assert.equal(new TaskRunTracker({
      statePath,
      resolveProjectRoot: () => project,
    }).runs.length, runs.length);
  });
});

test('reconcile persists reopened state before notifying observers', () => {
  withTempProject(({ project, statePath }) => {
    const ready = storedRun(1, 'ready-for-review', 'Completed task');
    fs.writeFileSync(statePath, JSON.stringify({ version: 1, runs: [ready] }));
    let failRename = true;
    const changes = [];
    const fsImpl = {
      ...fs,
      renameSync(from, to) {
        if (failRename) {
          const error = new Error('simulated reconcile failure');
          error.code = 'EIO';
          throw error;
        }
        return fs.renameSync(from, to);
      },
    };
    const tracker = new TaskRunTracker({
      statePath,
      resolveProjectRoot: () => project,
      now: () => 20_000,
      fsImpl,
      onChange: (change) => changes.push(change),
    });

    assert.throws(() => tracker.reconcile('project-1', []), /simulated reconcile failure/);
    assert.equal(tracker.get(numberedId(1)).phase, 'ready-for-review');
    assert.deepEqual(changes, []);
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).runs[0].phase, 'ready-for-review');

    failRename = false;
    tracker.reconcile('project-1', []);
    assert.equal(tracker.get(numberedId(1)).phase, 'reopened');
    assert.equal(changes.length, 1);
    assert.equal(changes[0].reason, 'reopened');
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).runs[0].phase, 'reopened');
  });
});

test('an unrelated Codex session cannot claim an assigned task run', () => {
  withTempProject(({ project, statePath }) => {
    ensureAssignedGoal(project, { id: TASK_ID, text: 'Assigned task' });
    const tracker = new TaskRunTracker({
      statePath,
      resolveProjectRoot: () => project,
      now: () => 10_000,
    });
    tracker.start({
      id: TASK_ID, projectId: 'project-1', text: 'Assigned task', provider: 'codex',
      baselineShipIds: [],
    });
    tracker.observe([{
      type: 'ship-updated',
      ship: ship({ id: 'codex:unrelated', taskId: OTHER_ID, attention: 'done' }),
    }]);
    assert.equal(tracker.get(TASK_ID).phase, 'waiting-for-agent');
    assert.equal(readGoalsFile(project).items[0].done, false);
  });
});

test('aborted, departed, and undiscovered agents release the project run lock', () => {
  withTempProject(({ project, statePath }) => {
    ensureAssignedGoal(project, { id: TASK_ID, text: 'Assigned task' });
    let now = 10_000;
    const tracker = new TaskRunTracker({
      statePath,
      resolveProjectRoot: () => project,
      now: () => now,
    });
    tracker.start({
      id: TASK_ID, projectId: 'project-1', text: 'Assigned task', provider: 'codex',
      baselineShipIds: [],
    });
    tracker.observe([{ type: 'ship-updated', ship: ship() }]);
    tracker.observe([{ type: 'ship-updated', ship: ship({ turnOutcome: 'aborted' }) }]);
    assert.equal(tracker.get(TASK_ID).phase, 'agent-aborted');
    assert.equal(tracker.activeForProject('project-1'), null);

    tracker.start({
      id: OTHER_ID, projectId: 'project-1', text: 'Replacement', provider: 'codex',
      baselineShipIds: [],
    });
    tracker.observe([{ type: 'ship-updated', ship: ship({
      id: 'codex:replacement', taskId: OTHER_ID,
    }) }]);
    tracker.observe([{ type: 'ship-departed', shipId: 'codex:replacement' }]);
    assert.equal(tracker.get(OTHER_ID).phase, 'agent-departed');

    const thirdId = '323e4567-e89b-42d3-a456-426614174000';
    tracker.start({
      id: thirdId, projectId: 'project-1', text: 'Never appeared', provider: 'codex',
      baselineShipIds: [],
    });
    now += 5 * 60 * 1000;
    tracker.expire();
    assert.equal(tracker.get(thirdId).phase, 'agent-not-found');
    assert.equal(tracker.activeForProject('project-1'), null);
  });
});

test('completion fails closed when the tagged goal text changed', () => {
  withTempProject(({ project, statePath }) => {
    ensureAssignedGoal(project, { id: TASK_ID, text: 'Original task' });
    const tracker = new TaskRunTracker({
      statePath,
      resolveProjectRoot: () => project,
      now: () => 10_000,
    });
    tracker.start({
      id: TASK_ID, projectId: 'project-1', text: 'Original task', provider: 'codex',
      baselineShipIds: [],
    });
    tracker.observe([{ type: 'ship-spawned', ship: ship() }]);
    const edited = readGoalsFile(project).items.map((goal) => ({ ...goal, text: 'Edited task' }));
    writeGoalsFile(project, edited);
    tracker.observe([{ type: 'ship-updated', ship: ship({ attention: 'done' }) }]);
    assert.equal(tracker.get(TASK_ID).phase, 'completion-failed');
    assert.equal(readGoalsFile(project).items[0].done, false);
  });
});

test('baseline ships cannot claim a run and Codex aborts are not completions', () => {
  withTempProject(({ project, statePath }) => {
    ensureAssignedGoal(project, { id: TASK_ID, text: 'Do not complete' });
    const tracker = new TaskRunTracker({
      statePath,
      resolveProjectRoot: () => project,
      now: () => 10_000,
    });
    tracker.start({
      id: TASK_ID, projectId: 'project-1', text: 'Do not complete', provider: 'codex',
      baselineShipIds: ['codex:old-session'],
    });
    tracker.observe([{
      type: 'ship-updated',
      ship: ship({ id: 'codex:old-session', attention: 'done' }),
    }]);
    assert.equal(tracker.get(TASK_ID).phase, 'waiting-for-agent');
    assert.equal(readGoalsFile(project).items[0].done, false);

    const record = {
      timestamp: '2026-08-02T00:00:00.000Z',
      type: 'event_msg',
      payload: { type: 'turn_aborted' },
    };
    assert.equal(codexRecordToSignals(record)[0].type, 'turn-aborted');

    const claim = codexRecordToSignals({
      timestamp: '2026-08-02T00:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'message', role: 'user',
        content: [{ type: 'input_text', text: `Work on agent-universe:${TASK_ID} now.` }],
      },
    })[0];
    assert.deepEqual({ type: claim.type, taskId: claim.taskId }, {
      type: 'task-claim', taskId: TASK_ID,
    });
  });
});

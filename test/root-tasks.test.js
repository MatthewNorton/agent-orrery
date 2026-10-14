'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RootTaskStore } = require('../src/main/root-tasks');

const TASK_ID = '123e4567-e89b-42d3-a456-426614174000';
const OTHER_ID = '223e4567-e89b-42d3-a456-426614174000';

function withTempStore(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-universe-root-tasks-'));
  const statePath = path.join(root, 'state', 'root-tasks.json');
  try {
    return run({ root, statePath });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function makeStore(statePath, overrides = {}) {
  return new RootTaskStore({
    statePath,
    now: () => 1_000,
    randomUUID: () => TASK_ID,
    ...overrides,
  });
}

function uuidFor(index) {
  return `123e4567-e89b-42d3-a456-${index.toString(16).padStart(12, '0')}`;
}

test('requires an absolute state path and creates normalized public records', () => {
  assert.throws(() => new RootTaskStore('relative.json'), /absolute state path/);
  withTempStore(({ statePath }) => {
    const store = makeStore(statePath);
    const record = store.create('  Explore a new idea  ');
    assert.deepEqual(record, {
      id: TASK_ID,
      text: 'Explore a new idea',
      projectId: null,
      phase: 'idea',
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    assert.deepEqual(Object.keys(record), [
      'id', 'text', 'projectId', 'phase', 'createdAt', 'updatedAt',
    ]);
    assert.equal('statePath' in record, false);
  });
});

test('rejects invalid text, IDs, clocks, and project IDs', () => {
  withTempStore(({ statePath }) => {
    const invalidText = ['', '   ', 'two\nlines', 'trailing newline\n', '\tleading tab',
      'tab\there', 'nul\0here',
      'agent-universe:123e4567-e89b-42d3-a456-426614174000', 'x'.repeat(10_001)];
    for (const text of invalidText) {
      assert.throws(() => makeStore(statePath).create(text), /Invalid root task text/);
    }
    assert.throws(() => makeStore(statePath, { randomUUID: () => 'not-a-uuid' }).create('Idea'),
      /Invalid root task id/);
    assert.throws(() => makeStore(statePath, { now: () => Number.NaN }).create('Idea'),
      /non-negative finite/);

    const store = makeStore(statePath);
    store.create('Idea');
    for (const projectId of ['', ' ', 'bad\nproject', 'x'.repeat(257)]) {
      assert.throws(() => store.prepare(TASK_ID, projectId), /Invalid project id/);
    }
    assert.equal(store.get(TASK_ID).phase, 'idea');
  });
});

test('persists records atomically and reloads defensive public copies', () => {
  withTempStore(({ statePath }) => {
    const store = makeStore(statePath);
    const created = store.create('Persistent idea');
    created.text = 'mutated caller value';
    const listed = store.list();
    listed[0].phase = 'launch-requested';
    assert.equal(store.get(TASK_ID).text, 'Persistent idea');
    assert.equal(store.get(TASK_ID).phase, 'idea');

    const reloaded = new RootTaskStore(statePath);
    assert.deepEqual(reloaded.list(), [{
      id: TASK_ID,
      text: 'Persistent idea',
      projectId: null,
      phase: 'idea',
      createdAt: 1_000,
      updatedAt: 1_000,
    }]);
    const document = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(document.version, 1);
    assert.equal(document.records.length, 1);
    assert.deepEqual(fs.readdirSync(path.dirname(statePath)), ['root-tasks.json']);
  });
});

test('removes ideas unless their start is in flight, and persists the remaining order', () => {
  withTempStore(({ statePath }) => {
    const ids = [TASK_ID, OTHER_ID];
    let idIndex = 0;
    const store = makeStore(statePath, { randomUUID: () => ids[idIndex++] });
    const first = store.create('Remove this idea');
    const second = store.create('Keep this idea');

    assert.deepEqual(store.remove(TASK_ID.toUpperCase()), first);
    assert.deepEqual(store.list(), [second]);
    assert.deepEqual(new RootTaskStore(statePath).list(), [second]);
    assert.throws(() => store.remove('not-an-id'), /Invalid root task id/);
    assert.throws(() => store.remove(TASK_ID), (error) => error && error.code === 'NOT_FOUND');

    store.prepare(OTHER_ID, 'project-one');
    store.markGoalWritten(OTHER_ID);
    store.markLaunchRequested(OTHER_ID);
    assert.throws(() => store.remove(OTHER_ID), (error) => (
      error && error.code === 'INVALID_TRANSITION'
    ), 'a start in flight keeps its record');
    store.markRunPhase(OTHER_ID, 'project-one', 'launch-failed');
    assert.equal(store.remove(OTHER_ID).phase, 'launch-failed', 'an assigned idea goes once it is not starting');
    assert.deepEqual(store.list(), []);
  });
});

test('enforces ordered transitions and makes repeated operations idempotent', () => {
  withTempStore(({ statePath }) => {
    let now = 100;
    const store = makeStore(statePath, { now: () => ++now });
    store.create('Run this idea');

    assert.equal(store.prepare(TASK_ID, 'project-one').phase, 'prepared');
    const preparedAt = store.get(TASK_ID).updatedAt;
    assert.deepEqual(store.prepare(TASK_ID, 'project-one'), store.get(TASK_ID));
    assert.equal(store.get(TASK_ID).updatedAt, preparedAt);

    assert.equal(store.markGoalWritten(TASK_ID).phase, 'goal-written');
    const writtenAt = store.get(TASK_ID).updatedAt;
    assert.equal(store.markGoalWritten(TASK_ID).updatedAt, writtenAt);
    assert.equal(store.markLaunchFailed(TASK_ID).phase, 'launch-failed');
    const failedAt = store.get(TASK_ID).updatedAt;
    assert.equal(store.markLaunchFailed(TASK_ID).updatedAt, failedAt);
    assert.equal(store.prepareRetry(TASK_ID).phase, 'goal-written');
    const retryAt = store.get(TASK_ID).updatedAt;
    assert.equal(store.prepareRetry(TASK_ID).updatedAt, retryAt);
    assert.equal(store.markLaunchRequested(TASK_ID).phase, 'launch-requested');
    const launchedAt = store.get(TASK_ID).updatedAt;
    assert.equal(store.markLaunchRequested(TASK_ID).updatedAt, launchedAt);
    assert.equal(store.markGoalWritten(TASK_ID).phase, 'launch-requested');
    assert.equal(store.prepareRetry(TASK_ID).phase, 'goal-written');
    assert.equal(store.markLaunchRequested(TASK_ID).phase, 'launch-requested');

    assert.equal(new RootTaskStore(statePath).get(TASK_ID).phase, 'launch-requested');
  });
});

test('keeps project assignment immutable and rejects skipped transitions', () => {
  withTempStore(({ statePath }) => {
    const store = makeStore(statePath);
    store.create('Assigned idea');
    assert.throws(() => store.markGoalWritten(TASK_ID), (error) => (
      error && error.code === 'INVALID_TRANSITION'
    ));
    store.prepare(TASK_ID, 'project-one');
    assert.throws(() => store.prepare(TASK_ID, 'project-two'), (error) => (
      error && error.code === 'PROJECT_IMMUTABLE'
    ));
    assert.equal(store.get(TASK_ID).projectId, 'project-one');
    assert.throws(() => store.markLaunchRequested(TASK_ID), (error) => (
      error && error.code === 'INVALID_TRANSITION'
    ));
    assert.equal(store.get('223e4567-e89b-42d3-a456-426614174000'), null);
    assert.throws(() => store.prepareRetry('223e4567-e89b-42d3-a456-426614174000'),
      (error) => error && error.code === 'NOT_FOUND');
  });
});

test('persists terminal run phases and permits only retryable outcomes to resume', () => {
  withTempStore(({ statePath }) => {
    let now = 200;
    const store = makeStore(statePath, { now: () => ++now });
    store.create('Observed run');
    store.prepare(TASK_ID, 'project-one');
    store.markGoalWritten(TASK_ID);
    store.markLaunchRequested(TASK_ID);

    assert.equal(
      store.markRunPhase(TASK_ID, 'project-one', 'agent-aborted').phase,
      'agent-aborted'
    );
    assert.equal(store.prepareRetry(TASK_ID).phase, 'goal-written');
    store.markLaunchRequested(TASK_ID);
    assert.equal(
      store.markRunPhase(TASK_ID, 'project-one', 'ready-for-review').phase,
      'ready-for-review'
    );
    assert.throws(
      () => store.markRunPhase(TASK_ID, 'project-one', 'agent-departed'),
      (error) => error && error.code === 'INVALID_TRANSITION'
    );
    assert.equal(
      store.markRunPhase(TASK_ID, 'project-one', 'reopened').phase,
      'reopened'
    );
    assert.equal(new RootTaskStore(statePath).get(TASK_ID).phase, 'reopened');
    assert.equal(store.prepareRetry(TASK_ID).phase, 'goal-written');

    assert.throws(
      () => store.markRunPhase(TASK_ID, 'project-two', 'launch-failed'),
      (error) => error && error.code === 'PROJECT_IMMUTABLE'
    );
    assert.throws(() => store.markRunPhase(TASK_ID, 'project-one', 'running'),
      /Invalid task run phase/);
  });
});

test('loads corrupt, oversized, and over-limit state as empty and filters invalid records', () => {
  withTempStore(({ statePath }) => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, '{bad json');
    assert.deepEqual(new RootTaskStore(statePath).list(), []);

    fs.writeFileSync(statePath, Buffer.alloc(2 * 1024 * 1024 + 1, 0x20));
    assert.deepEqual(new RootTaskStore(statePath).list(), []);

    const valid = {
      id: TASK_ID, text: 'Valid idea', projectId: null, phase: 'idea',
      createdAt: 1, updatedAt: 1,
    };
    fs.writeFileSync(statePath, JSON.stringify({
      version: 1,
      records: [valid, { ...valid, id: uuidFor(2), text: 'bad\ntext' }],
    }));
    assert.deepEqual(new RootTaskStore(statePath).list(), [valid]);

    fs.writeFileSync(statePath, JSON.stringify({
      version: 1,
      records: Array.from({ length: 1_001 }, (_, index) => ({
        ...valid,
        id: uuidFor(index + 1),
      })),
    }));
    assert.deepEqual(new RootTaskStore(statePath).list(), []);

    fs.writeFileSync(statePath, JSON.stringify({
      version: 1,
      records: Array.from({ length: 1_000 }, (_, index) => ({
        ...valid,
        id: uuidFor(index + 1),
      })),
    }));
    const fullStore = makeStore(statePath, { randomUUID: () => uuidFor(1_001) });
    assert.throws(() => fullStore.create('One too many'), (error) => (
      error && error.code === 'LIMIT_REACHED'
    ));
  });
});

test('cleans an atomic temp file and keeps state unchanged when rename fails', () => {
  withTempStore(({ statePath }) => {
    makeStore(statePath).create('Survives a failed update');
    const original = fs.readFileSync(statePath, 'utf8');
    const failingFs = {
      ...fs,
      renameSync() {
        const error = new Error('simulated rename failure');
        error.code = 'EIO';
        throw error;
      },
    };
    const store = makeStore(statePath, { fsImpl: failingFs });
    assert.throws(() => store.prepare(TASK_ID, 'project-one'), /simulated rename failure/);
    assert.equal(store.get(TASK_ID).phase, 'idea');
    assert.equal(fs.readFileSync(statePath, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(path.dirname(statePath)), ['root-tasks.json']);
  });
});

test('keeps a removable idea in memory and on disk when deletion persistence fails', () => {
  withTempStore(({ statePath }) => {
    makeStore(statePath).create('Survives a failed removal');
    const original = fs.readFileSync(statePath, 'utf8');
    const failingFs = {
      ...fs,
      renameSync() {
        const error = new Error('simulated removal failure');
        error.code = 'EIO';
        throw error;
      },
    };
    const store = makeStore(statePath, { fsImpl: failingFs });

    assert.throws(() => store.remove(TASK_ID), /simulated removal failure/);
    assert.equal(store.get(TASK_ID).text, 'Survives a failed removal');
    assert.equal(fs.readFileSync(statePath, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(path.dirname(statePath)), ['root-tasks.json']);
  });
});

test('rejects a write that would exceed the reload size limit', () => {
  withTempStore(({ statePath }) => {
    const maxBytes = 2 * 1024 * 1024;
    const records = [];
    let oversizedDocument = null;
    while (records.length < 1_000) {
      const next = {
        id: uuidFor(records.length + 1),
        text: 'x'.repeat(10_000),
        projectId: null,
        phase: 'idea',
        createdAt: 1,
        updatedAt: 1,
      };
      const serialized = JSON.stringify({ version: 1, records: [...records, next] });
      if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
        oversizedDocument = serialized;
        break;
      }
      records.push(next);
    }
    assert.ok(records.length > 0 && records.length < 1_000);
    assert.ok(oversizedDocument);

    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const original = JSON.stringify({ version: 1, records });
    fs.writeFileSync(statePath, original);
    const store = makeStore(statePath, {
      randomUUID: () => uuidFor(records.length + 1),
    });
    assert.equal(store.list().length, records.length);
    assert.throws(() => store.create('y'.repeat(10_000)), (error) => (
      error && error.code === 'LIMIT_REACHED'
    ));
    assert.equal(fs.readFileSync(statePath, 'utf8'), original);
    assert.equal(new RootTaskStore(statePath).list().length, records.length);
  });
});

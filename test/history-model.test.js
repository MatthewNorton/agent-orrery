'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { createHistoryModel, FEED_LIMIT } = require('../src/main/history/model');

const T0 = Date.UTC(2026, 6, 21, 12, 0, 0);
const MIN = 60 * 1000;
const PROJECT_DIR = path.join(os.tmpdir(), 'au-history-model', 'workspace', 'demo');

function createModel(size = 3) {
  const batches = [];
  const batchSize = { value: size };
  const model = createHistoryModel({
    batchSize: () => batchSize.value,
    onBatch: (batch) => batches.push(batch),
    preferredProjectId: () => undefined,
  });
  return { model, batches, batchSize };
}

const entry = {
  provider: 'claude', sourceKey: 'claude:demo:s1', filePath: 'unused', sessionId: 's1',
  projectPath: PROJECT_DIR, projectName: 'demo', projectIdHint: 'demo', kind: 'main',
  parentSessionId: null, startMs: T0, endMs: T0, size: 0, priority: 0,
};
const record = (ts, signal, offset = 0, ordinal = 0) => ({
  ts, provider: 'claude', sourceKey: entry.sourceKey, offset, ordinal, entry,
  signal: { provider: 'claude', sessionId: 's1', ts, ...signal },
});

test('history model: emitted events are numbered from 1 and split into maxBatch batches', () => {
  const { model, batches, batchSize } = createModel(3);
  for (let index = 0; index < 7; index++) model.queue({ type: 'probe', index }, true);
  assert.deepEqual(batches.map((batch) => batch.length), [3, 3], 'a full batch flushes at once');
  model.flush();
  assert.deepEqual(batches.map((batch) => batch.length), [3, 3, 1]);
  assert.deepEqual(batches.flat().map((event) => [event.seq, event.index]),
    Array.from({ length: 7 }, (_, index) => [index + 1, index]));

  model.queue({ type: 'silent' }, false);
  assert.equal(model.snapshot().eventSequence, 7, 'a silent event takes no number');

  batchSize.value = 10;
  for (let index = 0; index < 5; index++) model.queue({ type: 'probe' }, true);
  batchSize.value = 2;
  model.flush();
  assert.deepEqual(batches.slice(3).map((batch) => batch.length), [2, 2, 1], 'flush drains in batch-size pieces');

  model.clearEvents();
  assert.equal(model.snapshot().eventSequence, 0);
  model.flush();
  assert.equal(batches.length, 6);
});

test('history model: the feed keeps the last FEED_LIMIT entries', () => {
  const { model } = createModel(1000);
  model.ensureProject(PROJECT_DIR, T0, false, 'demo');
  for (let index = 0; index < FEED_LIMIT + 10; index++) {
    model.ensureShip({
      provider: 'claude', sessionId: `s${index}`, projectPath: PROJECT_DIR, kind: 'main',
      parentSessionId: null, projectIdHint: 'demo', projectId: 'demo', local: false,
    }, T0 + index, false);
  }
  const { feed } = model.snapshot();
  assert.equal(feed.length, FEED_LIMIT);
  assert.equal(feed[0].text, 'Claude-11 entered demo');
  assert.equal(feed.at(-1).text, `Claude-${FEED_LIMIT + 10} entered demo`);
  assert.equal(model.state.feed.length, FEED_LIMIT);
});

test('history model: a Claude Task call launches a drone that returns with its result', () => {
  const { model, batches } = createModel(256);
  model.applyRecord(record(T0, { type: 'session', cwd: PROJECT_DIR }), true);
  model.applyRecord(record(T0 + 1, { type: 'tool-start', callId: 'toolu_task', tool: 'Task' }), true);
  assert.deepEqual(model.snapshot().ships.map((ship) => [ship.id, ship.name, ship.kind]), [
    ['ship:demo:s1', 'Claude-1', 'main'],
    ['drone:claude:s1:toolu_task', 'Claude-2', 'drone'],
  ]);
  model.applyRecord(record(T0 + 2, { type: 'tool-end', callId: 'toolu_task' }), true);
  model.applyRecord(record(T0 + 3, { type: 'tool-start', tool: 'Agent' }, 0x1f, 2), true);
  model.flush();
  const events = batches.flat();
  assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index + 1));
  assert.deepEqual(model.snapshot().ships.map((ship) => ship.id),
    ['ship:demo:s1', 'drone:claude:s1:line-1f-2'], 'an id-less call falls back to its line offset');
  assert.deepEqual(model.snapshot().feed.map((item) => item.text), [
    'Claude-1 entered demo',
    'Claude-1 launched Claude-2 in demo',
    'Claude-2 returned to Claude-1',
    'Claude-1 launched Claude-3 in demo',
  ]);
});

test('history model: idle ships depart at their deadline; reset empties everything', () => {
  const { model } = createModel(256);
  model.applyRecord(record(T0, { type: 'session', cwd: PROJECT_DIR }), false);
  model.advanceLifecycle(T0 + 5 * MIN, false);
  assert.equal(model.snapshot().ships.length, 1, 'still inside the active window');
  model.advanceLifecycle(T0 + 5 * MIN + 1, false);
  assert.deepEqual(model.snapshot().ships, []);
  assert.deepEqual(model.snapshot().feed.at(-1), {
    kind: 'depart', text: 'Claude-1 warped out', project: 'demo', ts: T0 + 5 * MIN,
  });
  model.reset();
  assert.deepEqual(model.snapshot(), { projects: [], ships: [], feed: [], eventSequence: 0 });
});

'use strict';

// src/main/live/events.js: seq stamping, batching and the feed ring buffer.

const test = require('node:test');
const assert = require('node:assert/strict');
const { FEED_LIMIT, queue, pushFeed, flush, recentFeed } = require('../src/main/live/events');

function stream() {
  const published = [];
  const model = { pending: [], feed: [], eventSequence: 0, publish: (batch) => published.push(batch) };
  return { model, published };
}

test('live events: seq follows call order, and a feed entry takes the next seq when it is pushed', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const { model } = stream();
  queue(model, { type: 'project-added' });
  pushFeed(model, 'spawn', 'Claude-1 entered demo', 'demo');
  queue(model, { type: 'ship-updated' });

  assert.deepEqual(model.pending.map((event) => [event.type, event.seq]),
    [['project-added', 1], ['feed', 2], ['ship-updated', 3]]);
  assert.deepEqual(model.pending[1].entry, { kind: 'spawn', text: 'Claude-1 entered demo', project: 'demo', ts: 1_000 });
  assert.equal(model.eventSequence, 3);
});

test('live events: flush publishes the batch once and starts a new one; seq keeps counting', () => {
  const { model, published } = stream();
  flush(model);
  assert.deepEqual(published, [], 'nothing queued, nothing published');

  queue(model, { type: 'a' });
  queue(model, { type: 'b' });
  const batch = model.pending;
  flush(model);
  flush(model);
  assert.equal(published.length, 1);
  assert.equal(published[0], batch);
  assert.deepEqual(model.pending, []);

  queue(model, { type: 'c' });
  flush(model);
  assert.deepEqual(published.map((sent) => sent.map((event) => event.seq)), [[1, 2], [3]]);
});

test('live events: the feed grows to twice its limit, then drops back to the newest 60; snapshots see 60', () => {
  assert.equal(FEED_LIMIT, 60);
  const { model } = stream();
  for (let index = 1; index <= FEED_LIMIT * 2; index++) pushFeed(model, 'info', `entry ${index}`, 'p');
  assert.equal(model.feed.length, 120);
  assert.equal(recentFeed(model).length, 60);
  assert.equal(recentFeed(model)[0].text, 'entry 61');

  pushFeed(model, 'info', 'entry 121', 'p');
  assert.equal(model.feed.length, 60);
  assert.deepEqual([model.feed[0].text, model.feed.at(-1).text], ['entry 62', 'entry 121']);
  assert.equal(model.pending.length, 121, 'every entry is still queued as a feed event');
});

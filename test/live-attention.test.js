'use strict';

// src/main/live/attention.js evaluateAttention: what a change in attention announces.

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateAttention } = require('../src/main/live/attention');
const { createShipRecord } = require('../src/main/universe/ships');

function world() {
  const model = {
    projects: new Map([['p', { id: 'p', name: 'demo' }]]),
    ships: new Map(), pending: [], feed: [], eventSequence: 0, publish() {},
  };
  const addShip = (id, fields = {}) => {
    const ship = createShipRecord({ id, name: id, provider: 'claude', project: 'p', kind: 'main', lastEvent: 0, ...fields });
    model.ships.set(id, ship);
    return ship;
  };
  const take = () => model.pending.splice(0).map((event) => event.type === 'feed'
    ? ['feed', event.entry.kind, event.entry.text]
    : [event.type, event.ship.id, event.ship.attention, event.ship.attentionSince]);
  return { model, addShip, take };
}

test('live attention: each new attention is announced once, with its own feed line', () => {
  const { model, addShip, take } = world();
  addShip('Asker').pending.set('q', { tool: 'AskUserQuestion', ts: 0 });
  addShip('Editor').pending.set('e', { tool: 'Edit', ts: 0 });
  addShip('Runner').pending.set('b', { tool: 'Bash', ts: 0 });
  addShip('Finisher', { project: 'gone' }).turnDone = true;

  evaluateAttention(model, 1_999);
  assert.deepEqual(take(), []);
  evaluateAttention(model, 10_000);
  assert.deepEqual(take(), [
    ['ship-updated', 'Asker', 'question', 10_000],
    ['feed', 'attention', 'Asker is asking you something in demo'],
    ['ship-updated', 'Editor', 'permission', 10_000],
    ['feed', 'attention', 'Editor needs permission in demo'],
    ['ship-updated', 'Finisher', 'done', 10_000],
    ['feed', 'done', 'Finisher finished its task in gone'],
  ]);
  evaluateAttention(model, 20_000);
  assert.deepEqual(take(), [], 'unchanged attention stays quiet');
  evaluateAttention(model, 180_000);
  assert.deepEqual(take(), [
    ['ship-updated', 'Runner', 'stalled', 180_000],
    ['feed', 'info', 'Runner may be stuck in demo'],
  ]);
});

test('live attention: clearing attention updates the ship without a feed line; drones never page', () => {
  const { model, addShip, take } = world();
  const ship = addShip('Asker');
  ship.pending.set('q', { tool: 'AskUserQuestion', ts: 0 });
  addShip('Drone', { kind: 'drone' }).pending.set('q2', { tool: 'AskUserQuestion', ts: 0 });

  evaluateAttention(model, 5_000);
  assert.deepEqual(take().map((entry) => entry.slice(0, 3)),
    [['ship-updated', 'Asker', 'question'], ['feed', 'attention', 'Asker is asking you something in demo']]);
  ship.pending.clear();
  evaluateAttention(model, 6_000);
  assert.deepEqual(take(), [['ship-updated', 'Asker', null, null]]);
  assert.equal(model.ships.get('Drone').attention, null);
});

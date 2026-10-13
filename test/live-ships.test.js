'use strict';

// src/main/live/ships.js: ship names, open tool calls and departures.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ensureShip, spawnDrone, ensureProviderShip, addPending, clearPending, departIdleShips,
} = require('../src/main/live/ships');

const MIN = 60 * 1000;

function world() {
  const project = { id: 'p', name: 'demo' };
  const model = {
    projects: new Map([['p', project]]), ships: new Map(), pendingIndex: new Map(),
    shipCounter: 0, providerCounters: new Map(),
    pending: [], feed: [], eventSequence: 0, publish() {},
  };
  const take = () => model.pending.splice(0).map((event) => event.type === 'feed'
    ? ['feed', event.entry.text] : [event.type, event.shipId || event.ship.id]);
  return { model, project, take };
}

test('live ships: Claude ships and drones share one name counter; each provider counts its own', () => {
  const { model, project, take } = world();
  const claude = ensureShip(model, 'p', 's1', false, 1);
  const codex = ensureProviderShip(model, 'codex', 'p', 'c1', 'main', 2, null);
  spawnDrone(model, project, claude, 'toolu_1', 3);
  const child = ensureProviderShip(model, 'codex', 'p', 'c2', 'drone', 4, 'c1');
  const signal = ensureProviderShip(model, 'signal', 'p', 'w1', 'main', 5, null);

  assert.deepEqual([...model.ships.values()].map((ship) => [ship.id, ship.name, ship.kind, ship.parentName]), [
    ['ship:p:s1', 'Claude-1', 'main', null],
    ['ship:codex:c1', 'Codex-1', 'main', null],
    ['drone:toolu_1', 'Claude-2', 'drone', 'Claude-1'],
    ['ship:codex:c2', 'Codex-2', 'drone', 'Codex-1'],
    ['ship:generic:w1', 'Signal-1', 'main', null],
  ]);
  assert.deepEqual(take().filter(([type]) => type === 'feed'), [
    ['feed', 'Claude-1 entered demo'], ['feed', 'Codex-1 entered demo'],
    ['feed', 'Claude-1 launched Claude-2 in demo'], ['feed', 'Codex-2 entered demo'], ['feed', 'Signal-1 entered demo'],
  ]);

  assert.equal(ensureShip(model, 'p', 's1', false, 9), claude);
  assert.equal(ensureProviderShip(model, 'codex', 'p', 'c1', 'drone', 9, null), codex);
  assert.equal(codex.kind, 'drone', 'a later drone signal reclassifies the ship');
  spawnDrone(model, project, claude, 'toolu_1', 9);
  spawnDrone(model, project, claude, null, 9);
  assert.equal(ensureProviderShip(model, 'codex', 'unknown', 'c3', 'main', 9, null), null);
  assert.deepEqual(take(), [], 'known ships and repeated drones announce nothing');
  assert.equal(signal.provider, 'generic');
  assert.equal(child.project, 'p');
});

test('live ships: a ship keeps at most 12 open calls; the oldest leaves the index too', () => {
  const { model, take } = world();
  const ship = ensureShip(model, 'p', 's1', false, 1);
  take();
  for (let index = 0; index < 13; index++) addPending(model, ship, `call-${index}`, 'Read', index);
  assert.equal(ship.pending.size, 12);
  assert.equal(ship.pending.has('call-0'), false);
  assert.equal(model.pendingIndex.has('call-0'), false);
  assert.equal(model.pendingIndex.size, 12);

  clearPending(model, 'call-5', 99);
  clearPending(model, 'never-opened', 100);
  assert.deepEqual([ship.pending.has('call-5'), model.pendingIndex.has('call-5'), ship.lastEvent], [false, false, 99]);
  assert.deepEqual(take(), [['ship-updated', 'ship:p:s1']]);
});

test('live ships: idle ships warp out; a ship waiting on the user lingers up to an hour', () => {
  const { model, project, take } = world();
  const asker = ensureShip(model, 'p', 'asker', false, 0);
  asker.attention = 'question';
  const idle = ensureShip(model, 'p', 'idle', false, 0);
  spawnDrone(model, project, idle, 'toolu_d', 0);
  addPending(model, idle, 'call-idle', 'Read', 0);
  addPending(model, idle, 'call-moved', 'Read', 0);
  model.pendingIndex.set('call-moved', 'ship:p:asker');
  take();

  departIdleShips(model, 5 * MIN);
  assert.deepEqual(take(), []);
  departIdleShips(model, 5 * MIN + 1);
  assert.deepEqual(take(), [['ship-departed', 'ship:p:idle'], ['feed', 'Claude-2 warped out']]);
  assert.deepEqual([...model.pendingIndex.keys()], ['call-moved'], 'only calls the ship still owns are dropped');
  departIdleShips(model, 15 * MIN + 1);
  assert.deepEqual(take(), [['ship-departed', 'drone:toolu_d'], ['feed', 'Claude-3 warped out']]);
  departIdleShips(model, 60 * MIN);
  assert.deepEqual(take(), []);
  departIdleShips(model, 60 * MIN + 1);
  assert.deepEqual(take(), [['ship-departed', 'ship:p:asker'], ['feed', 'Claude-1 warped out']]);
});

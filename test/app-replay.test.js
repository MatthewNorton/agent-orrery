'use strict';

// src/renderer/app/replay.js: what a reset of the stream leaves of the open view.

const test = require('node:test');
const assert = require('node:assert/strict');
const { runRenderer } = require('./support/renderer-source');

function setup() {
  const calls = [];
  const state = { viewEpoch: 7, streamEpoch: 7, store: { projects: new Map([['p', { id: 'p' }]]) } };
  const window = { AUR: { app: {
    state, const: { CHROME: {} },
    showUniverse: () => calls.push('universe ' + state.viewEpoch),
    openSystem: (id) => calls.push(`system ${id} ${state.viewEpoch}`),
    openPlanet: (id, name) => calls.push(`planet ${id} ${name} ${state.viewEpoch}`),
  } }, AU: {} };
  runRenderer('app/replay.js', { window });
  return { app: window.AUR.app, state, calls };
}

test('rebuildRoute: the route is opened again, with nothing of the open view reused', () => {
  const { app, state, calls } = setup();
  app.rebuildRoute({ view: 'planet', projectId: 'p', planetName: 'src' });
  state.viewEpoch = 7;
  app.rebuildRoute({ view: 'system', projectId: 'p' });
  state.viewEpoch = 7;
  app.rebuildRoute({ view: 'planet', projectId: 'gone', planetName: 'src' });
  state.viewEpoch = 7;
  app.rebuildRoute({ view: 'universe' });
  // The view's data is from before the reset, in the same stream epoch or not: its epoch is cleared
  // before the route opens, so the planet card's system is fetched again (app/project/control.js).
  assert.deepEqual(calls, ['planet p src null', 'system p null', 'universe null', 'universe null']);
});

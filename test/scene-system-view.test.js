'use strict';

// The system view (src/renderer/scene/system/view.js) building its first planets through the real
// planets part. Babylon, the helpers that draw and the other parts are stand-ins that accept
// anything; the worlds part's makeWorld is the one thing that can fail.

const assert = require('node:assert/strict');
const test = require('node:test');
const { runRenderer } = require('./support/renderer-source');
const { anything } = require('./support/scene-fakes');

// Opens the system view on `planets`; a planet named in `failing` has no world.
function openSystem(planets, failing = []) {
  const window = { AUR_POLISH: anything() }, logged = [], asked = [], disposed = [];
  runRenderer('util.js', { window, document: {} });
  const real = Object.assign(window.AUR, { views: {}, log: (...args) => logged.push(args.join(' ')) });
  const none = () => ({});
  real.sceneParts = {
    system: {
      exhaust: none, focus: none, belt: anything(),
      ships: () => ({ buildShip() {}, animateShips() {}, update() {} }),
      worlds: () => ({
        makeWorld(name) {
          asked.push(name);
          if (failing.includes(name)) throw new Error('no globe');
          return { spec: { cls: 'rocky' }, globe: { position: {} }, dispose: () => disposed.push(name) };
        },
        prefetchDetail() {}, worldStats() {}, sunFx: anything(),
      }),
    },
  };
  // What util.js does not define (the Babylon-facing helpers) accepts anything.
  window.AUR = new Proxy(real, { get: (target, key) => (key in target ? target[key] : (target[key] = anything())) });
  const BABYLON = anything();
  runRenderer('scene/system/planets.js', { window, BABYLON });
  runRenderer('scene/system/view.js', { window, BABYLON });
  const engine = { getRenderingCanvas: () => ({ style: {} }) };
  const data = { projectId: 'p', system: { project: { id: 'p', seed: 1, totalBytes: 0 }, planets: planets.map((name) => ({ name, key: name, files: 1 })) } };
  const ctx = { store: { ships: new Map() }, quality: { sky: 1 }, orbitRings: true, shown: () => '1', openPlanet() {} };
  const view = real.views.system(engine, data, ctx);
  return { view, logged, asked, disposed };
}

test('system view: a planet that cannot be built at first does not stop the view or the planets after it', () => {
  const { view, logged, asked, disposed } = openSystem(['src', 'bad', 'docs'], ['bad']);
  assert.ok(view.scene, 'the view opens');
  assert.deepEqual([asked, disposed, logged], [['src', 'bad', 'docs'], [], ['planet not drawn bad no globe']]);
  assert.equal(view.systemData.planets.length, 3, 'the system is as it was read; the next refetch tries the planet again');
});

'use strict';

// The system view's ships part (src/renderer/scene/system/ships.js): which planet a build goes to.

const assert = require('node:assert/strict');
const test = require('node:test');
const { runRenderer } = require('./support/renderer-source');
const { deferred } = require('./support/main-wiring');

// The part over `planets` ({ name, key } each, by name as the view keeps them); getSystem() calls
// wait in `asked` to be answered.
function loadPart(planets) {
  const asked = [], built = [];
  const window = { AU: { getSystem: () => { asked.push(deferred()); return asked.at(-1).promise; } } };
  runRenderer('util.js', { window, document: {} });
  Object.assign(window.AUR, { sceneParts: { system: {} }, SHIP_SIZE: { system: 1 } });
  runRenderer('scene/system/ships.js', { window, BABYLON: { Vector3: function Vector3() {} } });
  const view = {
    scene: { isDisposed: false }, gui: {}, ships: new Map(), projectId: 'p', outer: 10, beltR: 6, beltWidth: 3, sys: null, sysBehind: false,
    planets: new Map(planets.map((planet) => [planet.name, { ...planet, pulseUntil: 0 }])),
    buildPlanet(pd) {
      built.push(pd.name);
      const rec = { name: pd.name, key: pd.key, pulseUntil: 0 };
      view.planets.set(pd.name, rec);
      return rec;
    },
  };
  const part = window.AUR.sceneParts.system.ships(view);
  const build = (bucket, key, more = {}) => part.update([{ type: 'build', project: 'p', shipId: 's', bucket, key, isNew: false, ts: 1, ...more }]);
  // The names of the planets a build has pulsed since the last call.
  const pulsed = () => [...view.planets.values()].filter((rec) => rec.pulseUntil > 0).map((rec) => { rec.pulseUntil = 0; return rec.name; });
  return { view, asked, built, build, pulsed };
}

const settled = () => new Promise((done) => setImmediate(done));
const systemOf = (...names) => ({ project: { id: 'p' }, planets: names.map((name) => ({ name, key: name.toLowerCase() })) });

test('system ships: a build goes to the planet with its key; of two that share one, to the one it spelled', () => {
  const { view, build, pulsed } = loadPart([{ name: 'Docs', key: 'docs' }, { name: 'docs', key: 'docs' }, { name: 'src', key: 'src' }]);
  assert.equal(view.planets.size, 3, 'two folders that differ only in case are two planets');
  build('docs', 'docs');
  assert.deepEqual(pulsed(), ['docs']);
  build('Docs', 'docs');
  assert.deepEqual(pulsed(), ['Docs']);
  build('DOCS', 'docs');
  assert.deepEqual(pulsed(), ['Docs'], 'a third spelling: the first of them');
  build('SRC', 'src');
  assert.deepEqual(pulsed(), ['src'], 'the key decides, not the spelling');
  build('src', 'src', { project: 'other' });
  build('lib', 'lib');
  assert.deepEqual(pulsed(), []);
});

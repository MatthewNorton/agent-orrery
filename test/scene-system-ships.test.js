'use strict';

// The system view's ships part (src/renderer/scene/system/ships.js): which planet a build goes to,
// and the system fetched again when a build starts a planet the view does not draw.

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

test('system ships: a build that starts a planet fetches the system again, and it is behind until the answer', async () => {
  const { view, asked, built, build } = loadPart([{ name: 'src', key: 'src' }]);
  build('src', 'src', { isNew: true });
  assert.deepEqual([asked.length, view.sysBehind], [0, false], 'a planet the view already draws is no news');

  build('docs', 'docs', { isNew: true });
  assert.deepEqual([asked.length, view.sysBehind], [1, true]);
  build('lib', 'lib', { isNew: true });
  assert.equal(asked.length, 1, 'one request at a time');
  asked[0].resolve(systemOf('src', 'docs'));
  await settled();
  assert.deepEqual([asked.length, view.sysBehind, built], [2, true, ['docs']], 'an answer from before the later planet is asked for again');
  build('web', 'web', { isNew: true });
  asked[1].resolve(systemOf('src', 'docs', 'lib'));
  await settled();
  asked[2].resolve(systemOf('src', 'docs', 'lib', 'web'));
  await settled();
  assert.deepEqual([asked.length, view.sysBehind, built, view.sys.planets.length], [3, false, ['docs', 'lib', 'web'], 4]);

  // No answer: the system stays behind, and the next such build asks again.
  build('api', 'api', { isNew: true });
  asked[3].reject(new Error('main is away'));
  await settled();
  assert.deepEqual([view.sysBehind, view.sys.planets.length], [true, 4]);
  build('cli', 'cli', { isNew: true });
  assert.equal(asked.length, 5);

  // An answer for a view that has closed builds nothing.
  view.scene.isDisposed = true;
  asked[4].resolve(systemOf('src', 'docs', 'lib', 'web', 'api', 'cli'));
  await settled();
  assert.deepEqual([built.length, view.sys.planets.length, asked.length], [3, 4, 5]);
});

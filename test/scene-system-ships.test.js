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
  const asked = [], built = [], logged = [];
  const window = { AU: { getSystem: () => { asked.push(deferred()); return asked.at(-1).promise; } } };
  runRenderer('util.js', { window, document: {} });
  Object.assign(window.AUR, { sceneParts: { system: {} }, SHIP_SIZE: { system: 1 }, log: (...args) => logged.push(args.join(' ')) });
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
  return { view, asked, built, logged, build, pulsed };
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

test('system ships: a planet that cannot be built stops neither the others nor the next refetch', async () => {
  const { view, asked, built, logged, build } = loadPart([{ name: 'src', key: 'src' }]);
  const buildPlanet = view.buildPlanet;
  view.buildPlanet = (pd, i) => {
    if (pd.name === 'bad') throw new Error('no globe');
    return buildPlanet(pd, i);
  };
  build('bad', 'bad', { isNew: true });
  asked[0].resolve(systemOf('src', 'bad', 'docs'));
  await settled();
  assert.deepEqual([built, view.sysBehind, logged], [['docs'], false, ['planet not drawn bad no globe']]);

  build('lib', 'lib', { isNew: true });
  assert.equal(asked.length, 2, 'the refetch is not left fetching');
  asked[1].resolve(systemOf('src', 'bad', 'docs', 'lib'));
  await settled();
  assert.deepEqual([built, view.sysBehind], [['docs', 'lib'], false]);
});

test('system ships: a folder renamed in case only stays its one globe; two folders that share a key are two', async () => {
  const { view, asked, built, build } = loadPart([{ name: 'docs', key: 'docs' }, { name: 'src', key: 'src' }]);
  const answer = async (...names) => {
    build('new-' + asked.length, 'new-' + asked.length, { isNew: true });
    asked.at(-1).resolve(systemOf(...names));
    await settled();
    return [...view.planets.keys()];
  };
  // docs was renamed Docs under a Windows path: one folder, the globe that is drawn.
  assert.deepEqual(await answer('Docs', 'src', 'lib'), ['docs', 'src', 'lib']);
  assert.deepEqual(view.sys.planets.map((planet) => planet.name), ['Docs', 'src', 'lib'], 'the system is as main has it');
  // A case-sensitive directory holds Docs and docs: two planets, and one of them is drawn.
  assert.deepEqual(await answer('Docs', 'docs', 'src', 'lib'), ['docs', 'src', 'lib', 'Docs']);
  // One of those renamed in case: still two folders, and two globes.
  assert.deepEqual(await answer('DOCS', 'docs', 'src', 'lib', 'web'), ['docs', 'src', 'lib', 'Docs', 'web']);
  assert.deepEqual(built, ['lib', 'Docs', 'web']);
});

test('system ships: a failed fetch keeps the refetch queued behind it, three failures in a row at most', async () => {
  const { view, asked, built, build } = loadPart([{ name: 'src', key: 'src' }]);
  const fail = async (request) => { asked[request].reject(new Error('main is away')); await settled(); };
  build('docs', 'docs', { isNew: true });
  build('lib', 'lib', { isNew: true });
  await fail(0);
  assert.equal(asked.length, 2, 'the planet that started while the fetch was out is still asked for');
  build('web', 'web', { isNew: true });
  await fail(1);
  build('api', 'api', { isNew: true });
  await fail(2);
  assert.deepEqual([asked.length, view.sysBehind, built], [3, true, []], 'three in a row: it rests');

  // The next planet starts it again, and an answer clears the count.
  build('cli', 'cli', { isNew: true });
  assert.equal(asked.length, 4);
  build('app', 'app', { isNew: true });
  await fail(3);
  asked[4].resolve(systemOf('src', 'docs', 'lib', 'web', 'api', 'cli', 'app'));
  await settled();
  assert.deepEqual([asked.length, view.sysBehind, built], [5, false, ['docs', 'lib', 'web', 'api', 'cli', 'app']]);
});

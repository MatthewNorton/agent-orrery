'use strict';

// The system view's planets part (src/renderer/scene/system/planets.js): a planet is built whole,
// or leaves nothing in the scene. The ring, the world and the label are faked.

const assert = require('node:assert/strict');
const test = require('node:test');
const { runRenderer } = require('./support/renderer-source');

// The part with the three things a planet is made of, each of which `refuse(kind, name)` can make
// throw. `live(kind)` is what the scene still holds of that kind.
function loadPart(refuse = () => false) {
  const made = [], logged = [];
  const thing = (kind, name, more = {}) => {
    if (refuse(kind, name)) throw new Error(`no ${kind}`);
    const part = { kind, name, disposed: false, dispose(...args) { part.disposed = true; part.disposedWith = args; }, ...more };
    made.push(part);
    return part;
  };
  const window = {};
  runRenderer('util.js', { window, document: {} });
  const AUR = Object.assign(window.AUR, {
    sceneParts: { system: {} },
    log: (...args) => logged.push(args.join(' ')),
    orbitRing: (scene, radius) => thing('ring', `r${radius}`),
    orbitPoint: (angle, radius, y, out) => Object.assign(out, { x: radius, y, z: 0 }),
    label: (gui, text) => thing('label', text),
  });
  runRenderer('scene/system/planets.js', { window });
  const view = {
    scene: {}, gui: {}, projectId: 'p', orbitR: (i) => 11 + i * 6, planets: new Map(), topNames: ['src'], ringRoot: { name: 'orbitRings' },
    makeWorld: (name) => ({ spec: { cls: 'rocky' }, globe: thing('globe', name, { position: {} }) }),
  };
  const { buildPlanet } = AUR.sceneParts.system.planets(view);
  const live = (kind) => made.filter((part) => part.kind === kind && !part.disposed).map((part) => part.name);
  return { view, buildPlanet, made, logged, live };
}

test('system planets: a planet is its ring, its world and its label, kept by name with its key', () => {
  const { view, buildPlanet, live } = loadPart();
  const rec = buildPlanet({ name: 'src', key: 'src', files: 40, builds: 2 }, 0);
  const docs = buildPlanet({ name: 'Docs', key: 'docs', files: 1 }, 1);
  assert.deepEqual([...view.planets.keys()], ['src', 'Docs']);
  assert.deepEqual([rec.name, rec.key, rec.r, rec.persistent, rec.label.isVisible, rec.ring.parent, rec.appear], ['src', 'src', 11, true, true, view.ringRoot, 1]);
  assert.deepEqual([docs.key, docs.r, docs.persistent, docs.label.isVisible], ['docs', 17, false, false], 'only the heaviest planets keep their labels up');
  assert.deepEqual(rec.mesh.metadata, { planetName: 'src', isPlanet: true, worldType: 'rocky' });
  assert.deepEqual([live('ring'), live('globe'), live('label')], [['r11', 'r17'], ['src', 'Docs'], ['src', 'Docs']]);
  assert.equal(buildPlanet({ name: 'src', key: 'src', files: 40, builds: 2 }, 0).a, rec.a, 'the same planet starts at the same place on its orbit');
});

test('system planets: a planet that cannot be finished leaves nothing behind, and built again has one ring', () => {
  for (const failing of ['ring', 'globe', 'label']) {
    let refusals = 1;
    const { view, buildPlanet, made, logged, live } = loadPart((kind, name) => kind === failing && name !== 'r11' && name !== 'src' && refusals-- > 0);
    buildPlanet({ name: 'src', key: 'src' }, 0);
    assert.throws(() => buildPlanet({ name: 'docs', key: 'docs' }, 1), new RegExp(`no ${failing}`));
    assert.deepEqual([[...view.planets.keys()], live('ring'), live('globe'), live('label')], [['src'], ['r11'], ['src'], ['src']],
      `${failing}: what was made of the planet is taken back`);
    // The globe goes with its materials and maps, and its shells, which are its children.
    for (const globe of made.filter((part) => part.kind === 'globe' && part.disposed)) assert.deepEqual(globe.disposedWith, [false, true]);

    // The next refetch builds it again.
    const rec = buildPlanet({ name: 'docs', key: 'docs' }, 1);
    assert.deepEqual([[...view.planets.keys()], live('ring'), live('globe'), live('label')], [['src', 'docs'], ['r11', 'r17'], ['src', 'docs'], ['src', 'docs']],
      `${failing}: exactly one ring, one globe and one label for each planet`);
    assert.equal(rec.ring.disposed, false);
    assert.deepEqual(logged, []);
  }
});

test('system planets: a part that cannot be taken back does not keep the others', () => {
  // The globe's own dispose throws: the ring is still taken back, and the build's error is the one thrown.
  const { view, buildPlanet, made, logged, live } = loadPart((kind) => kind === 'label');
  view.makeWorld = () => ({ spec: { cls: 'rocky' }, globe: { position: {}, dispose() { throw new Error('stuck'); } } });
  assert.throws(() => buildPlanet({ name: 'docs', key: 'docs' }, 0), /no label/);
  assert.deepEqual([live('ring'), made.length, logged], [[], 1, ['planet part not removed docs stuck']]);
});

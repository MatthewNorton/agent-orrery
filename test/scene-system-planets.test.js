'use strict';

// The system view's planets part (src/renderer/scene/system/planets.js): a planet is built whole,
// or leaves nothing in the scene. First with the ring, the world and the label faked; then with
// the view's own worlds (scene/system/worlds.js, worlds/material.js and the map service) over a
// Babylon that disposes as Babylon does.

const assert = require('node:assert/strict');
const test = require('node:test');
const { runRenderer } = require('./support/renderer-source');
const { fakeBabylon } = require('./support/fake-babylon');

// The part with the three things a planet is made of, each of which `refuse(kind, name)` can make
// throw. `live(kind)` is what the scene still holds of that kind.
function loadPart(refuse = () => false) {
  const made = [], logged = [];
  const thing = (kind, name, more = {}) => {
    if (refuse(kind, name)) throw new Error(`no ${kind}`);
    const part = { kind, name, disposed: false, dispose() { part.disposed = true; }, ...more };
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
    scene: {}, gui: {}, projectId: 'p', orbitR: (i) => 11 + i * 6, planets: new Map(), ringRoot: { name: 'orbitRings' },
    // The system as it opened: its three heaviest planets keep their labels up.
    sys: { planets: [{ name: 'Docs', files: 1 }, { name: 'lib', files: 30 }, { name: 'src', files: 40, builds: 2 }, { name: 'app', files: 20 }] },
    // The world owns its globe: only world.dispose() takes it out of the scene.
    makeWorld: (name) => thing('world', name, { spec: { cls: 'rocky' }, globe: { position: {}, dispose() { throw new Error('the globe is the world\'s to dispose'); } } }),
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
  assert.deepEqual([live('ring'), live('world'), live('label')], [['r11', 'r17'], ['src', 'Docs'], ['src', 'Docs']]);
  assert.equal(buildPlanet({ name: 'src', key: 'src', files: 40, builds: 2 }, 0).a, rec.a, 'the same planet starts at the same place on its orbit');
});

test('system planets: a planet that cannot be finished is answered with null and leaves nothing behind; built again it has one ring', () => {
  for (const failing of ['ring', 'world', 'label']) {
    let refusals = 1;
    const { view, buildPlanet, logged, live } = loadPart((kind, name) => kind === failing && name !== 'r11' && name !== 'src' && refusals-- > 0);
    buildPlanet({ name: 'src', key: 'src' }, 0);
    assert.equal(buildPlanet({ name: 'docs', key: 'docs' }, 1), null, `${failing}: no throw, so the planets after it are still built`);
    assert.deepEqual([[...view.planets.keys()], live('ring'), live('world'), live('label')], [['src'], ['r11'], ['src'], ['src']],
      `${failing}: what was made of the planet is taken back, the world by its own dispose()`);
    assert.deepEqual(logged, [`planet not drawn docs no ${failing}`], `${failing}: logged once`);

    // The next refetch builds it again.
    const rec = buildPlanet({ name: 'docs', key: 'docs' }, 1);
    assert.deepEqual([[...view.planets.keys()], live('ring'), live('world'), live('label')], [['src', 'docs'], ['r11', 'r17'], ['src', 'docs'], ['src', 'docs']],
      `${failing}: exactly one ring, one world and one label for each planet`);
    assert.equal(rec.ring.disposed, false);
  }
});

test('system planets: a part that cannot be taken back does not keep the others', () => {
  // The world's own dispose throws: the ring is still taken back.
  const { view, buildPlanet, made, logged, live } = loadPart((kind) => kind === 'label');
  view.makeWorld = () => ({ spec: { cls: 'rocky' }, globe: { position: {} }, dispose() { throw new Error('stuck'); } });
  assert.equal(buildPlanet({ name: 'docs', key: 'docs' }, 0), null);
  assert.deepEqual([live('ring'), made.length, logged], [[], 1, ['planet part not removed docs stuck', 'planet not drawn docs no label']]);
});

// The planets and worlds parts over the real world material and map service. `refuseLabel(name)`
// makes that planet's label throw, `refuseMaps(job)` makes its map fail. docs and web are rocky
// worlds: their maps have no emission layer, so both sample the scene's one blank texture.
function loadSystem(t, { refuseLabel = () => false, refuseMaps = () => false } = {}) {
  const babylon = fakeBabylon();
  const { BABYLON } = babylon;
  const window = {}, logged = [], posted = [], workers = [];
  runRenderer('util.js', { window, document: {} });
  const AUR = window.AUR;
  for (const file of ['noise.js', 'classes.js', 'maps.js']) runRenderer(`worlds/${file}`, { self: window });
  runRenderer('procedural-worlds.js', { window, BABYLON });
  // A worker that answers on demand, with a surface and an emission layer of the size asked for.
  class FakeWorker {
    constructor() { workers.push(this); }
    postMessage(job) { posted.push(job.key); this.job = job; }
    answer() {
      const job = this.job;
      this.job = null;
      const layer = () => new Uint8Array(job.width * job.height * 4);
      this.onmessage({ data: { key: job.key, ok: true, ms: 1, width: job.width, height: job.height, surface: layer(), emission: layer(), clouds: null, rings: null } });
    }
    terminate() {}
  }
  const run = AUR.worlds.run;
  AUR.worlds.run = (job) => (refuseMaps(job) ? { key: job.key, ok: false, error: 'no map' } : run(job));
  Object.assign(AUR, {
    sceneParts: { system: {} },
    log: (...args) => logged.push(args.join(' ')),
    color3: () => ({}),
    orbitRing: () => new BABYLON.Mesh('ring'),
    orbitPoint: () => {},
    label: (gui, text) => {
      if (refuseLabel(text)) throw new Error('no label');
      return { dispose() {} };
    },
  });
  runRenderer('worlds/textures.js', { window, navigator: { hardwareConcurrency: 3 }, Worker: FakeWorker, BABYLON });
  Object.assign(AUR.worlds, { shaders: {}, createSun: () => ({ setTier() {}, update() {} }) });
  runRenderer('worlds/material.js', { window, BABYLON });
  runRenderer('scene/system/worlds.js', { window, BABYLON });
  runRenderer('scene/system/planets.js', { window });
  const service = AUR.worlds.textures.create();
  const scene = { isDisposed: false, getEngine: () => ({ getCaps: () => ({ maxAnisotropy: 16 }) }), onDisposeObservable: { addOnce() {} } };
  const view = {
    scene, gui: {}, projectId: 'p', orbitR: (i) => 11 + i * 6, planets: new Map(), sys: { planets: [] }, ringRoot: {},
    glow: babylon.glow(), sun: { material: {} }, sunHex: '#ffffff', sunDia: 6, worldMaps: service, quality: { key: 'high' },
  };
  Object.assign(view, AUR.sceneParts.system.worlds(view), AUR.sceneParts.system.planets(view));
  const build = (name, i) => view.buildPlanet({ name, key: name }, i);
  // Every map the workers were asked for, made.
  const answerAll = () => { for (const worker of workers) while (worker.job) worker.answer(); };
  t.after(answerAll); // a job left running would hold the service's worker timeout open
  const specOf = (name) => AUR.worlds.worldSpec('p', name, '#ffffff');
  return { babylon, view, service, scene, build, logged, posted, answerAll, specOf, placeholderWidth: AUR.worlds.textures.PLACEHOLDER.system };
}
const settled = () => new Promise((done) => setImmediate(done));
const surfaceOf = (babylon, name) => babylon.materials.find((material) => material.name === `pl_${name}-surface`);

test('system planets: a planet whose first map cannot be made leaves no globe, and the others stand', (t) => {
  const { babylon, view, build, logged, specOf } = loadSystem(t, { refuseMaps: (job) => job.seed === specOf('web').seed });
  assert.ok(build('docs', 0), logged.join());
  assert.equal(build('web', 1), null, 'the service\'s best() threw inside makeWorld');
  assert.ok(build('lib', 2));
  assert.deepEqual([...view.planets.keys()], ['docs', 'lib']);
  assert.deepEqual(babylon.live().meshes.filter((name) => /web|^ring$/.test(name)), ['ring', 'ring'], 'no globe, shell or ring of web stays');
  assert.deepEqual(babylon.live().materials.filter((name) => name.includes('web')), []);
  assert.deepEqual(logged, ['planet not drawn web no map']);
});

test('system planets: taking a planet back leaves the scene\'s shared blank texture to the globes that sample it', (t) => {
  const { babylon, build } = loadSystem(t, { refuseLabel: (name) => name === 'web' });
  assert.ok(build('docs', 0));
  const blank = surfaceOf(babylon, 'docs').textures.nightMap;
  assert.deepEqual([blank.width, blank.height], [1, 1], 'a rocky world has no emission layer');
  assert.equal(build('web', 1), null);
  assert.equal(surfaceOf(babylon, 'web').textures.nightMap, blank, 'web sampled the same blank texture');
  assert.equal(blank.disposed, false, 'the blank texture is the scene\'s, not the planet\'s');
  assert.deepEqual([surfaceOf(babylon, 'docs').textures.nightMap, surfaceOf(babylon, 'docs').textures.surfaceMap.disposed], [blank, false]);
  assert.equal(surfaceOf(babylon, 'web').textures.surfaceMap.disposed, true, 'its own map textures go');
});

test('system planets: a planet that was taken back no longer pins its maps in the cache', async (t) => {
  const { view, service, scene, build, posted, answerAll, specOf, placeholderWidth } = loadSystem(t, { refuseLabel: (name) => name === 'web' });
  build('docs', 0);
  assert.equal(build('web', 1), null);
  const epoch = service.open(scene);
  answerAll(); // the system-size maps both planets asked for
  await settled();
  assert.equal(view.planets.get('docs').world.mapWidth, 512);
  // Eleven 16 MB maps, past the 160 MB budget: every map that no texture pins is evicted, oldest first.
  const filled = Array.from({ length: 11 }, (unused, i) => service.request({ ...specOf('docs'), seed: 1000 + i }, 2048, 1, epoch));
  answerAll();
  await Promise.all(filled);
  posted.length = 0;
  service.request(specOf('web'), placeholderWidth, 1, epoch);
  assert.equal(posted.length, 1, 'web\'s placeholder was evicted: it is made again');
  const kept = await service.request(specOf('docs'), 512, 1, epoch);
  assert.equal(kept.source, 'cache', 'the map docs shows stays');
});

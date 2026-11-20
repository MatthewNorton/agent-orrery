'use strict';

// A generated world (src/renderer/worlds/material.js), with Babylon and the map service faked: no
// material may keep a texture that a later bind() disposed, and a world that is taken out of the
// scene, or cannot be made, leaves nothing in it.

const assert = require('node:assert/strict');
const test = require('node:test');
const { runRenderer } = require('./support/renderer-source');
const { fakeBabylon } = require('./support/fake-babylon');

const CLOUDY = { relief: 0, flattening: 1, rings: false, clouds: true, haze: 0, shell: 1 }; // clouds, no air or rings
const FULL = { ...CLOUDY, rings: true, haze: 0.2 }; // every shell a world can have

// A world of `spec`. `refuse(kind, name)` makes Babylon throw while it makes that mesh or material.
function loadWorld({ spec = CLOUDY, refuse = () => false } = {}) {
  const babylon = fakeBabylon(refuse);
  const logged = [];
  const AUR = { color3: () => ({}), worlds: { shaders: {} }, log: (...args) => logged.push(args.join(' ')) };
  runRenderer('worlds/material.js', { window: { AUR }, BABYLON: babylon.BABYLON });

  const pending = new Map(); // width → resolve, for the latest request at that width
  const uploaded = []; // the textures of each upload, whether disposed or not
  const mapsOf = (width) => ({ width, height: width / 2 });
  const service = {
    widthFor: (width) => width,
    best: (wanted, maxWidth, placeholderWidth) => ({ maps: mapsOf(placeholderWidth), source: 'placeholder' }),
    request: (wanted, width) => new Promise((resolve) => pending.set(width, resolve)),
    upload(scene, maps) {
      const own = [];
      const texture = (layer) => { const made = { layer, width: maps.width, disposed: false }; own.push(made); return made; };
      let clouds = null;
      const textures = {
        width: maps.width, height: maps.height, surface: texture('surface'), emission: texture('emission'), rings: null,
        clouds: () => clouds || (clouds = texture('clouds')),
        released: false,
        dispose() { textures.released = true; for (const made of own) made.disposed = true; },
      };
      uploaded.push(textures);
      return textures;
    },
  };
  const glow = babylon.glow();
  const make = () => AUR.worlds.createWorld({ isDisposed: false }, spec, {
    name: 'planet', radius: 1, segments: 8, clouds: true, glow, maps: service, epoch: 1,
  });
  const finish = (width) => pending.get(width)({ maps: mapsOf(width), source: 'worker' });
  // Every texture a material still holds after its maps were disposed, as 'material.sampler: layer width'.
  const stale = () => babylon.materials.flatMap((material) => Object.entries(material.textures)
    .filter(([, texture]) => texture.disposed)
    .map(([sampler, texture]) => `${material.name}.${sampler}: ${texture.layer} ${texture.width}`));
  const cloudMap = (name) => babylon.materials.find((material) => material.name === name).textures.cloudMap;
  return { make, finish, stale, cloudMap, uploaded, glow, logged, live: babylon.live, pending };
}

test('hiding the clouds after the detail map binds leaves no disposed texture on the shell', async () => {
  const { make, finish, stale, cloudMap } = loadWorld();
  const world = make();
  const opened = world.show(2048, 3, 128); // the high tier: clouds on, the placeholder bound
  finish(2048);
  assert.equal(await opened, true);
  assert.equal(cloudMap('planet-clouds').layer, 'clouds');

  world.setClouds(false); // the switch to low, as setQuality() makes it
  const lowered = world.show(1024, 3, 128);
  finish(1024);
  assert.equal(await lowered, true);
  assert.deepEqual(stale(), [], 'the hidden shell gave up the 2048 cloud layer when the 1024 replaced it');

  world.setClouds(true); // back to high: the shell and the surface show the bound maps' clouds
  for (const name of ['planet-clouds', 'planet-surface']) {
    assert.deepEqual(cloudMap(name), { layer: 'clouds', width: 1024, disposed: false });
  }
});

test('hiding the clouds while the placeholder is bound leaves no disposed texture on the shell', async () => {
  const { make, finish, stale } = loadWorld();
  const world = make();
  world.show(2048, 3, 128); // the high tier, with the placeholder's cloud layer on the shell
  world.setClouds(false); // the switch to balanced, before the detail map lands
  const balanced = world.show(2048, 3, 128);
  finish(2048);
  assert.equal(await balanced, true);
  assert.deepEqual(stale(), [], 'the hidden shell gave up the placeholder\'s cloud layer when the 2048 replaced it');
});


test('a world taken out of the scene gives back its maps, and a map that lands later is not bound', async () => {
  const { make, finish, uploaded, glow, live, pending, logged } = loadWorld({ spec: FULL });
  const world = make();
  assert.deepEqual(live(), {
    meshes: ['planet', 'planet-clouds', 'planet-atmo', 'planet-ring'],
    materials: ['planet-surface', 'planet-clouds', 'planet-atmo', 'planet-ring'],
  });
  assert.deepEqual([...glow.excluded], ['planet-clouds', 'planet-atmo', 'planet-ring']);
  const opened = world.show(2048, 3, 128); // the placeholder is bound and the 2048 is on its way
  assert.deepEqual(uploaded.map((textures) => textures.released), [false]);

  world.dispose(); // a planet that could not be finished: its builder takes the world back
  world.dispose(); // a second time changes nothing
  assert.deepEqual([live(), [...glow.excluded]], [{ meshes: [], materials: [] }, []], 'no globe, shell or material stays');
  assert.deepEqual(uploaded.map((textures) => textures.released), [true], 'its maps go back to the service');
  finish(2048);
  assert.equal(await opened, false);
  pending.clear();
  assert.equal(await world.show(2048, 3, 128), false);
  assert.deepEqual([uploaded.length, pending.size, world.mapWidth, logged], [1, 0, 128, []], 'no texture is made for it, and nothing more is asked');
});

test('a world that cannot be made leaves no mesh or material in the scene', () => {
  const steps = [
    ['material', 'planet-clouds'], ['mesh', 'planet-clouds'], ['glow', 'planet-clouds'], ['material', 'planet-atmo'],
    ['mesh', 'planet-atmo'], ['glow', 'planet-atmo'], ['material', 'planet-ring'], ['mesh', 'planet-ring'], ['glow', 'planet-ring'],
  ];
  for (const [kind, name] of steps) {
    const { make, glow, live, logged } = loadWorld({ spec: FULL, refuse: (k, n) => k === kind && n === name });
    assert.throws(make, new RegExp(`no ${kind} ${name}`));
    assert.deepEqual([live(), [...glow.excluded], logged], [{ meshes: [], materials: [] }, [], []], `${kind} ${name}: what was made is taken back`);
  }
});

test('a world part that will not go does not keep the others', () => {
  const { make, live, logged } = loadWorld({ spec: FULL });
  const world = make();
  world.globe.material.dispose = () => { throw new Error('stuck'); };
  world.dispose();
  assert.deepEqual([live(), logged], [{ meshes: [], materials: ['planet-surface'] }, ['[worlds] a world part was not removed: planet-surface stuck']]);
});

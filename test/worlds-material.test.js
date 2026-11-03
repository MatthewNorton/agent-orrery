'use strict';

// A generated world's texture bindings (src/renderer/worlds/material.js), with Babylon and the map
// service faked. scene.isReady() checks every material, a hidden shell's too, so none may keep a
// texture from maps that a later bind() disposed.

const assert = require('node:assert/strict');
const test = require('node:test');
const { runRenderer } = require('./support/renderer-source');

function loadWorld() {
  const materials = [];
  class ShaderMaterial {
    constructor(name) { this.name = name; this.textures = {}; materials.push(this); }
    setTexture(sampler, texture) { this.textures[sampler] = texture; }
    setFloat() {}
    setColor3() {}
    setVector2() {}
    setVector3() {}
    setMatrix() {}
  }
  class Matrix { static Scaling() { return new Matrix(); } static Identity() { return new Matrix(); } }
  const BABYLON = {
    ShaderMaterial, Matrix, Vector2: class {}, Constants: { ALPHA_COMBINE: 2 },
    Color3: { White: () => ({}), Lerp: () => ({}) },
    MeshBuilder: { CreateSphere: (name) => ({ name, setEnabled() {} }) },
  };
  const AUR = { color3: () => ({}), worlds: { shaders: {} } };
  runRenderer('worlds/material.js', { window: { AUR }, BABYLON });

  // One job per width, shared by every request for it, as in the real service; finish() lands it.
  const jobs = new Map();
  const job = (width) => {
    if (!jobs.has(width)) {
      let resolve = () => {};
      const promise = new Promise((done) => { resolve = done; });
      jobs.set(width, { promise, resolve });
    }
    return jobs.get(width);
  };
  const mapsOf = (width) => ({ key: `oceanic:${width}`, width, height: width / 2 });
  const service = {
    widthFor: (width) => width,
    best: (spec, maxWidth, placeholderWidth) => ({ maps: mapsOf(placeholderWidth), source: 'placeholder' }),
    request: (spec, width) => job(width).promise,
    upload(scene, maps) {
      const own = [];
      const texture = (layer) => { const made = { layer, width: maps.width, disposed: false }; own.push(made); return made; };
      let clouds = null;
      return {
        width: maps.width, height: maps.height, surface: texture('surface'), emission: texture('emission'), rings: null,
        clouds: () => clouds || (clouds = texture('clouds')),
        dispose() { for (const made of own) made.disposed = true; },
      };
    },
  };
  const spec = {
    cls: 'oceanic', relief: 0.11, glowDay: 0, flattening: 0.995, sunHex: '#ffffff',
    rings: false, clouds: true, haze: 0, shell: 1.016, air: '#000000',
  };
  const world = AUR.worlds.createWorld({ isDisposed: false }, spec, {
    name: 'planet', radius: 1, segments: 8, clouds: true, glow: null, maps: service, epoch: 1,
  });
  const finish = (width) => job(width).resolve({ maps: mapsOf(width), source: 'worker' });
  // Every texture a material still holds after its maps were disposed, as 'material.sampler: layer width'.
  const stale = () => materials.flatMap((material) => Object.entries(material.textures)
    .filter(([, texture]) => texture.disposed)
    .map(([sampler, texture]) => `${material.name}.${sampler}: ${texture.layer} ${texture.width}`));
  const cloudMap = (name) => materials.find((material) => material.name === name).textures.cloudMap;
  return { world, finish, stale, cloudMap };
}

test('hiding the clouds after the detail map binds leaves no disposed texture on the shell', async () => {
  const { world, finish, stale, cloudMap } = loadWorld();
  const opened = world.show(2048, 3, 128); // the high tier: clouds on, the 128 placeholder bound
  assert.equal(cloudMap('planet-clouds').layer, 'clouds');
  finish(512);
  finish(2048);
  assert.equal(await opened, true);
  assert.deepEqual(stale(), []);

  world.setClouds(false); // the switch to low, as setQuality() makes it
  const lowered = world.show(1024, 3, 128);
  finish(1024);
  assert.equal(await lowered, true);
  assert.equal(world.mapWidth, 1024);
  assert.deepEqual(stale(), [], 'the hidden shell gave up the 2048 cloud layer when the 1024 replaced it');

  world.setClouds(true); // back to high: the shell and the surface show the bound maps' clouds
  for (const name of ['planet-clouds', 'planet-surface']) {
    assert.deepEqual(cloudMap(name), { layer: 'clouds', width: 1024, disposed: false });
  }
});

test('hiding the clouds while the placeholder is bound leaves no disposed texture on the shell', async () => {
  const { world, finish, stale } = loadWorld();
  world.show(2048, 3, 128); // the high tier, with the placeholder's cloud layer on the shell
  world.setClouds(false); // the switch to balanced, before any map lands
  const balanced = world.show(2048, 3, 128);
  finish(512);
  await new Promise((resolve) => setImmediate(resolve)); // the interim 512 binds
  assert.equal(world.mapWidth, 512);
  assert.deepEqual(stale(), [], 'the hidden shell gave up the placeholder\'s cloud layer when the 512 replaced it');
  finish(2048);
  assert.equal(await balanced, true);
  assert.equal(world.mapWidth, 2048);
  assert.deepEqual(stale(), []);
});

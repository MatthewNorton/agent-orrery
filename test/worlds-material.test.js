'use strict';

// A generated world's texture bindings (src/renderer/worlds/material.js), with Babylon and the map
// service faked: no material may keep a texture that a later bind() disposed.

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

  const pending = new Map(); // width → resolve, for the latest request at that width
  const mapsOf = (width) => ({ width, height: width / 2 });
  const service = {
    widthFor: (width) => width,
    best: (spec, maxWidth, placeholderWidth) => ({ maps: mapsOf(placeholderWidth), source: 'placeholder' }),
    request: (spec, width) => new Promise((resolve) => pending.set(width, resolve)),
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
  const spec = { relief: 0, flattening: 1, rings: false, clouds: true, haze: 0, shell: 1 }; // clouds, no air or rings
  const world = AUR.worlds.createWorld({ isDisposed: false }, spec, {
    name: 'planet', radius: 1, segments: 8, clouds: true, glow: null, maps: service, epoch: 1,
  });
  const finish = (width) => pending.get(width)({ maps: mapsOf(width), source: 'worker' });
  // Every texture a material still holds after its maps were disposed, as 'material.sampler: layer width'.
  const stale = () => materials.flatMap((material) => Object.entries(material.textures)
    .filter(([, texture]) => texture.disposed)
    .map(([sampler, texture]) => `${material.name}.${sampler}: ${texture.layer} ${texture.width}`));
  const cloudMap = (name) => materials.find((material) => material.name === name).textures.cloudMap;
  return { world, finish, stale, cloudMap };
}

test('hiding the clouds after the detail map binds leaves no disposed texture on the shell', async () => {
  const { world, finish, stale, cloudMap } = loadWorld();
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
  const { world, finish, stale } = loadWorld();
  world.show(2048, 3, 128); // the high tier, with the placeholder's cloud layer on the shell
  world.setClouds(false); // the switch to balanced, before the detail map lands
  const balanced = world.show(2048, 3, 128);
  finish(2048);
  assert.equal(await balanced, true);
  assert.deepEqual(stale(), [], 'the hidden shell gave up the placeholder\'s cloud layer when the 2048 replaced it');
});

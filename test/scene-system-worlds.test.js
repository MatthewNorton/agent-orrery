'use strict';

// The system view's worlds part (src/renderer/scene/system/worlds.js): the hovered planet's
// detail-map prefetch, with the map service, the sun and the timers faked.

const assert = require('node:assert/strict');
const test = require('node:test');
const { runRenderer } = require('./support/renderer-source');

function loadPart() {
  const requests = [], closed = [], foreground = [];
  let nextEpoch = 1;
  const service = {
    open: () => nextEpoch++,
    close: (epoch) => closed.push(epoch),
    request: (spec, width, priority, epoch, { background = false } = {}) => {
      requests.push(`${spec.name}:${width}`);
      if (!background) foreground.push(spec.name);
      return Promise.resolve(null);
    },
  };
  const AUR = {
    sceneParts: { system: {} },
    worlds: {
      textures: { SIZES: { low: { system: 256, detail: 1024 }, high: { system: 512, detail: 2048 } }, PLACEHOLDER: { system: 64 } },
      createSun: () => ({ setTier() {}, update() {} }),
    },
  };
  const BABYLON = { Vector3: { Zero: () => ({ x: 0, y: 0, z: 0 }) } };
  runRenderer('scene/system/worlds.js', { window: { AUR }, BABYLON });
  const scene = { isDisposed: false };
  const part = AUR.sceneParts.system.worlds({
    scene, projectId: 'p', planets: new Map(), glow: {}, sun: { material: {} }, sunHex: '#ffffff', sunDia: 6,
    worldMaps: service, quality: { key: 'high' },
  });
  const planet = (name) => ({ name, world: { spec: { name } } });
  return { part, requests, closed, foreground, scene, planet };
}

test('the hover prefetch waits for the pointer to rest, once per planet and tier', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { part, requests, closed, foreground, planet } = loadPart();
  part.prefetchDetail(planet('a'));
  part.prefetchDetail(null); // the pointer only crossed a
  part.prefetchDetail(planet('b'));
  t.mock.timers.tick(249);
  assert.deepEqual(requests, []);
  t.mock.timers.tick(1);
  assert.deepEqual(requests, ['b:2048']);
  part.prefetchDetail(null);
  part.prefetchDetail(planet('b')); // back on b: its map is already on the way
  t.mock.timers.tick(1000);
  assert.deepEqual(requests, ['b:2048']);
  part.setWorldsQuality({ key: 'low' });
  part.prefetchDetail(planet('b')); // a new tier asks again, at its own width
  t.mock.timers.tick(250);
  assert.deepEqual(requests, ['b:2048', 'b:1024']);
  assert.deepEqual(closed.filter(Boolean), [2], 'the superseded prefetch closed its epoch (1 is the view\'s own)');
  assert.deepEqual(foreground, [], 'prefetches ask in the background, so the service never makes them on the main thread');
});

test('no prefetch once the scene is gone', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { part, requests, scene, planet } = loadPart();
  part.prefetchDetail(planet('a'));
  scene.isDisposed = true;
  t.mock.timers.tick(1000);
  assert.deepEqual(requests, []);
});

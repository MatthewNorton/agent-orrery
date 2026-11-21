'use strict';

// What a hull wears (src/renderer/ships/livery.js): a fleet hull's livery materials and the studio
// reflections. A livery that cannot be made is test/ship-assets.test.js, with the build it fails.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Color, loadShipAssets, LADDER_MANIFEST, ship, partMaterial, logsOf } = require('./support/ship-assets');

test('a fleet hull keeps its baked tones and glass, and its trim lights and nozzles emit the ship color', async () => {
  const assets = loadShipAssets(LADDER_MANIFEST, {}, [
    { name: 'hull_white', textured: true, albedo: '#f2f2f2' }, { name: 'hull_grey', textured: true, albedo: '#f2f2f2' },
    { name: 'canopy_glass', albedo: '#06101c' }, 'accent_livery', 'engine_glow', 'window_light',
  ]);
  const scene = assets.scene('system');
  const claude = await assets.ships.upgrade(scene, ship('a', 0), assets.fallback('a'));
  const codex = await assets.ships.upgrade(scene, ship('b', 0, { provider: 'codex' }), assets.fallback('b'));

  for (const tone of ['hull_white', 'hull_grey']) {
    assert.equal(partMaterial(claude, tone).albedoColor.toHexString(), '#f2f2f2', tone + ' stays as baked');
  }
  assert.equal(partMaterial(claude, 'canopy_glass').albedoColor.toHexString(), '#06101c', 'the glass keeps its smoke');
  assert.equal(partMaterial(claude, 'canopy_glass').emissiveColor.toHexString(), '#000000');
  for (const light of ['accent_livery', 'engine_glow']) {
    assert.deepEqual(partMaterial(claude, light).emissiveColor, new Color('#d97757').toLinearSpace(), light + ' emits terracotta, linear, so the frame shows the hex');
    assert.deepEqual(partMaterial(codex, light).emissiveColor, new Color('#f2f0ea').toLinearSpace(), light + ' emits pearl on Codex');
    assert.ok(partMaterial(claude, light).albedoColor.r < 0.1, light + ' is a dark surface under its light');
    assert.ok(partMaterial(claude, light).emissiveIntensity > 1, light + ' outshines the lit hull');
  }
  assert.equal(partMaterial(claude, 'window_light').emissiveIntensity, undefined, 'only the trim runs hot');
  assert.ok(partMaterial(claude, 'window_light').emissiveColor.r < 0.3, 'a lit pane, not a white block');
  assert.equal(partMaterial(claude, 'engine_glow').metadata.role, 'glow', 'every fleet material carries its role');
  assert.equal(claude.material.emissiveColor.toHexString(), '#d97757', 'the root emits the exact hex as evidence');
});

test('ship reflections that cannot be prefiltered log the cause once per cause, in whichever scene', async () => {
  const assets = loadShipAssets(LADDER_MANIFEST, {});
  const logs = logsOf(assets);
  let cause = 'no float render targets';
  Object.assign(assets.BABYLON, {
    Constants: {}, RawCubeTexture: class {}, HDRFiltering: class { prefilter() { return Promise.reject(new Error(cause)); } },
  });
  assets.BABYLON.Material.prototype.environmentIntensity = 1; // a PBR finish, which takes the studio reflections
  for (const next of ['no float render targets', 'no float render targets', 'context lost']) {
    cause = next;
    const scene = Object.assign(assets.scene('system'), { getEngine: () => ({}) }); // each prefilters its own copy
    assert.ok(await assets.ships.upgrade(scene, ship('a', 0), assets.fallback('a')));
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(logs, [
    'Ship environment could not be prefiltered (no float render targets); it is used unfiltered.',
    'Ship environment could not be prefiltered (context lost); it is used unfiltered.',
  ]);
});

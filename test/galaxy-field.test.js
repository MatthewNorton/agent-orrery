'use strict';

// galaxy-field.js is the pure light of a galaxy: an emission/dust atlas and the stars drawn from
// it, in a fixed local frame, with arms on the spiral galaxy-layout.js gives the galaxy's systems.
const test = require('node:test');
const assert = require('node:assert/strict');
const FIELD = require('../src/renderer/galaxy-field.js');
const GALAXY = require('../src/renderer/galaxy-layout.js');

const spiral = GALAXY.layoutGalaxyProjects(
  Array.from({ length: 9 }, (_, i) => ({ id: 'p' + i, seed: i + 1, galaxy: { key: 'k', label: 'K' } })),
).galaxies[0].spiral;
const tint = [0.4, 0.6, 1];

test('the atlas is deterministic, bounded and brightest along the spiral arms', () => {
  const a = FIELD.buildAtlas(spiral, 7, tint, 64);
  const b = FIELD.buildAtlas(spiral, 7, tint, 64);
  assert.deepEqual(a, b);
  assert.equal(a.length, 64 * 64 * 4);
  assert.notDeepEqual(a, FIELD.buildAtlas(spiral, 8, tint, 64));
  // At a radius of the disc, the light on an arm beats the light between two arms.
  const localRadius = 12;
  const galaxyRadius = localRadius * spiral.radius / FIELD.DISC;
  const onArm = GALAXY.armAngle(spiral, 0, galaxyRadius);
  const between = onArm + Math.PI / spiral.arms;
  const luma = (angle) => {
    const [r, g, b] = FIELD.emissionAt(spiral, 0, tint, Math.cos(angle) * localRadius, Math.sin(angle) * localRadius);
    return r + g + b;
  };
  assert.ok(luma(onArm) > luma(between) * 1.5, `${luma(onArm)} vs ${luma(between)}`);
  assert.deepEqual(FIELD.emissionAt(spiral, 0, tint, FIELD.EXTENT, FIELD.EXTENT), [0, 0, 0, 0]);
});

test('stars are finite, inside the disc, and reproduce from the seed', () => {
  const atlas = FIELD.buildAtlas(spiral, 3, tint, 64);
  const stars = FIELD.sampleStars(atlas, 64, 11, 500, 1);
  assert.deepEqual(stars, FIELD.sampleStars(atlas, 64, 11, 500, 1));
  assert.equal(stars.positions.length, 1500);
  assert.equal(stars.colors.length, 2000);
  for (let i = 0; i < 500; i++) {
    const [x, y, z] = stars.positions.subarray(i * 3, i * 3 + 3);
    assert.ok(Math.hypot(x, z) <= FIELD.DISC + 1e-6 && Math.abs(y) < FIELD.BOX.height / 2, `star ${i} escapes`);
    assert.ok(stars.sizes[i] > 0 && stars.sizes[i] < 0.2);
    assert.ok(stars.colors[i * 4 + 3] >= 0 && stars.colors[i * 4 + 3] <= 1);
  }
  const faded = FIELD.sampleStars(atlas, 64, 11, 500, 0.5);
  assert.ok(faded.colors[3] < stars.colors[3]);
});

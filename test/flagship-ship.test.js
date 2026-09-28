'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MODEL_PATH = path.join(ROOT, 'assets', 'ships', 'aur-vanta-seraph.glb');

function readGlbJson(buffer) {
  assert.equal(buffer.readUInt32LE(0), 0x46546c67, 'GLB magic');
  assert.equal(buffer.readUInt32LE(4), 2, 'GLB version');
  assert.equal(buffer.readUInt32LE(8), buffer.length, 'declared GLB length');
  const jsonLength = buffer.readUInt32LE(12);
  assert.equal(buffer.readUInt32LE(16), 0x4e4f534a, 'first chunk is JSON');
  return JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8').trim());
}

test('Vanta Seraph is the textured high-detail fleet benchmark', () => {
  const bytes = fs.readFileSync(MODEL_PATH);
  const model = readGlbJson(bytes);
  const manifest = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'assets', 'ships', 'manifest.json'), 'utf8'));
  const entry = manifest.hulls.find((hull) => hull.id === 'aur-vanta-seraph');
  const triangleCount = model.meshes.reduce((sum, mesh) => {
    const accessor = model.accessors[mesh.primitives[0].indices];
    return sum + accessor.count / 3;
  }, 0);

  assert.ok(bytes.length < 2 * 1024 * 1024, 'flagship remains below runtime cap');
  assert.match(model.asset.generator, /Vanta Seraph flagship generator/);
  assert.ok(triangleCount >= 4_000, `expected high-detail geometry, found ${triangleCount}`);
  assert.ok(triangleCount < 20_000, 'flagship respects the per-scene triangle budget');
  assert.equal(model.images.length, 2);
  assert.deepEqual(model.images.map((image) => image.mimeType), ['image/jpeg', 'image/jpeg']);
  assert.equal(model.materials[0].normalTexture.index, 1);
  assert.deepEqual(model.materials.map((material) => material.name), [
    'hull_primary', 'armor_secondary', 'structure_ivory', 'mechanical_gunmetal',
    'accent_energy', 'canopy_glass', 'engine_glow',
  ]);
  assert.ok(model.extras.features.includes('twin gravitic ring drives'));

  const positions = model.meshes.map((mesh) =>
    model.accessors[mesh.primitives[0].attributes.POSITION]);
  const width = Math.max(...positions.map((value) => value.max[0])) -
    Math.min(...positions.map((value) => value.min[0]));
  const length = Math.max(...positions.map((value) => value.max[2])) -
    Math.min(...positions.map((value) => value.min[2]));
  assert.ok(width > 7.3, 'wide layered silhouette');
  assert.ok(length > 5.7, 'long spearhead silhouette');

  assert.equal(manifest.providerFamilies.claude, 'aur-shared-fleet');
  assert.equal(manifest.providerFamilies.codex, 'aur-shared-fleet');
  assert.equal(entry.family, 'aur-shared-fleet');
  assert.equal(entry.file, 'aur-vanta-seraph.glb');
  assert.equal(entry.license, 'CC0');
});

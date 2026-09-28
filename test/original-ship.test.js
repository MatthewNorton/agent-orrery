'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MODEL_PATH = path.join(ROOT, 'assets', 'ships', 'aur-aster-kite.glb');

function readGlbJson(buffer) {
  assert.equal(buffer.readUInt32LE(0), 0x46546c67, 'GLB magic');
  assert.equal(buffer.readUInt32LE(4), 2, 'GLB version');
  assert.equal(buffer.readUInt32LE(8), buffer.length, 'declared GLB length');
  const jsonLength = buffer.readUInt32LE(12);
  assert.equal(buffer.readUInt32LE(16), 0x4e4f534a, 'first chunk is JSON');
  return JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8').trim());
}

test('Aster Kite is an original textured, recognizable-scale GLB', () => {
  const bytes = fs.readFileSync(MODEL_PATH);
  const model = readGlbJson(bytes);
  const manifest = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'assets', 'ships', 'manifest.json'), 'utf8'));
  const entry = manifest.hulls.find((hull) => hull.id === 'aur-aster-kite');

  assert.ok(bytes.length < 2 * 1024 * 1024, 'model remains below runtime cap');
  assert.match(model.asset.generator, /Agent Universe original ship generator/);
  assert.equal(model.images[0].mimeType, 'image/jpeg');
  assert.equal(model.textures.length, 1);
  assert.deepEqual(model.materials.map((material) => material.name), [
    'hull_textured', 'accent_energy', 'canopy_glass', 'engine_glow',
  ]);
  assert.equal(model.meshes.length, 4);

  const positionAccessors = model.meshes.map((mesh) =>
    model.accessors[mesh.primitives[0].attributes.POSITION]);
  const minX = Math.min(...positionAccessors.map((accessor) => accessor.min[0]));
  const maxX = Math.max(...positionAccessors.map((accessor) => accessor.max[0]));
  const minZ = Math.min(...positionAccessors.map((accessor) => accessor.min[2]));
  const maxZ = Math.max(...positionAccessors.map((accessor) => accessor.max[2]));
  assert.ok(maxX - minX > 5.5, 'wide split-wing silhouette');
  assert.ok(maxZ - minZ > 4, 'long spear-hull silhouette');

  assert.equal(entry.file, 'aur-aster-kite.glb');
  assert.equal(entry.family, 'aur-original');
  assert.equal(entry.license, 'CC0');
  assert.equal(entry.correction.rotateY, 0);
  assert.ok(entry.correction.scale >= 0.5, 'asset stays recognizable in the system view');
});

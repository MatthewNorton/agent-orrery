'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SHIP_ROOT = path.join(ROOT, 'assets', 'ships');

function readGlbJson(filePath) {
  const bytes = fs.readFileSync(filePath);
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, 'GLB magic');
  assert.equal(bytes.readUInt32LE(4), 2, 'GLB version');
  assert.equal(bytes.readUInt32LE(8), bytes.length, 'declared GLB length');
  const jsonLength = bytes.readUInt32LE(12);
  return {
    bytes,
    model: JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8').trim()),
  };
}

test('active shared fleet contains six original textured hulls and no Kenney or drone models', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(SHIP_ROOT, 'manifest.json'), 'utf8'));
  const activeFamily = manifest.providerFamilies.claude;
  const active = manifest.hulls.filter((hull) => hull.family === activeFamily);

  assert.equal(activeFamily, 'aur-shared-fleet');
  assert.equal(manifest.providerFamilies.codex, activeFamily);
  assert.deepEqual(manifest.nonModelProviders, ['signal']);
  assert.deepEqual(manifest.nonModelKinds, ['drone']);
  assert.equal(active.length, 6);
  assert.equal(active.filter((hull) => hull.role === 'main-s').length, 2);
  assert.equal(active.filter((hull) => hull.role === 'main-m').length, 2);
  assert.equal(active.filter((hull) => hull.role === 'main-l').length, 2);
  assert.equal(manifest.hulls.filter((hull) => hull.role === 'drone').length, 0);
  assert.equal(manifest.hulls.filter((hull) => /kenney/i.test(hull.id + hull.file + hull.source)).length, 0);
  assert.equal(fs.readdirSync(SHIP_ROOT).filter((file) => /^kenney-.*\.glb$/i.test(file)).length, 0);

  for (const hull of active) {
    assert.equal(hull.license, 'CC0');
    assert.match(hull.source, /Agent Universe original/);
    const { bytes, model } = readGlbJson(path.join(SHIP_ROOT, hull.file));
    assert.ok(bytes.length < 2 * 1024 * 1024, `${hull.id} remains below the runtime cap`);
    const triangles = model.meshes.reduce((sum, mesh) =>
      sum + model.accessors[mesh.primitives[0].indices].count / 3, 0);
    assert.ok(triangles >= 1_000, `${hull.id} has production geometry (${triangles} triangles)`);
    assert.ok(triangles < 20_000, `${hull.id} respects the scene budget`);
    assert.ok(model.materials.some((material) => /accent|energy/.test(material.name)));
  }
});

test('provider colors are fixed fleet identities in renderer source', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'util.js'), 'utf8');
  assert.match(source, /shipTint = \(_shipId, provider\) => AUR\.providerMeta\(provider\)\.color/);
  assert.match(source, /kind === 'drone'/);
  assert.match(source, /providerKey\(ship\.provider\) === 'generic'/);
});

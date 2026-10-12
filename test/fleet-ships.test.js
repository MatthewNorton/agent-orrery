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

const readManifest = () => JSON.parse(fs.readFileSync(path.join(SHIP_ROOT, 'manifest.json'), 'utf8'));

function glbTriangles(model) {
  return model.meshes.reduce((sum, mesh) => sum + mesh.primitives.reduce((total, primitive) =>
    total + model.accessors[primitive.indices].count / 3, 0), 0);
}

function glbLength(model) {
  const positions = model.meshes.flatMap((mesh) =>
    mesh.primitives.map((primitive) => model.accessors[primitive.attributes.POSITION]));
  return Math.max(...positions.map((accessor) => accessor.max[2])) -
    Math.min(...positions.map((accessor) => accessor.min[2]));
}

test('the legacy shared fleet keeps six original textured hulls and no Kenney or drone models', () => {
  const manifest = readManifest();
  const legacy = manifest.hulls.filter((hull) => hull.family === 'aur-shared-fleet');

  assert.deepEqual(manifest.nonModelProviders, ['signal']);
  assert.deepEqual(manifest.nonModelKinds, ['drone']);
  assert.equal(legacy.length, 6);
  assert.equal(legacy.filter((hull) => hull.role === 'main-s').length, 2);
  assert.equal(legacy.filter((hull) => hull.role === 'main-m').length, 2);
  assert.equal(legacy.filter((hull) => hull.role === 'main-l').length, 2);
  assert.equal(manifest.hulls.filter((hull) => hull.role === 'drone').length, 0);
  assert.equal(manifest.hulls.filter((hull) => /kenney/i.test(hull.id + hull.file + hull.source)).length, 0);
  assert.equal(fs.readdirSync(SHIP_ROOT).filter((file) => /^kenney-.*\.glb$/i.test(file)).length, 0);

  for (const hull of legacy) {
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

test('Claude and Codex fly the fleet-v2 rank ladder, promoted by build count', () => {
  const manifest = readManifest();
  const family = manifest.hulls.filter((hull) => hull.family === 'aur-fleet-v2');
  const ranks = family.filter((hull) => Number.isFinite(hull.minBuilds))
    .sort((a, b) => a.minBuilds - b.minBuilds);

  assert.equal(manifest.providerFamilies.claude, 'aur-fleet-v2');
  assert.equal(manifest.providerFamilies.codex, 'aur-fleet-v2');
  assert.deepEqual(family.filter((hull) => !ranks.includes(hull)).map((hull) => [hull.id, hull.role]),
    [['aur-wisp-drone', 'escort']], 'the drone is reserved for subagents, not a rank');
  assert.deepEqual(ranks.map((hull) => [hull.id, hull.minBuilds]), [
    ['aur-lance-interceptor', 0], ['aur-wayfarer-shuttle', 3], ['aur-bastion-corvette', 10],
    ['aur-vigil-frigate', 25], ['aur-helix-destroyer', 50], ['aur-atlas-cruiser', 100],
    ['aur-ark-carrier', 200],
  ]);
  assert.ok(ranks.every((hull) => hull.role === 'main'));
  assert.ok(!family.some((hull) => /aur-citadel-station/.test(hull.id)), 'the station has no role yet');
});

test('every fleet-v2 hull ships a far and a near runtime file within budget', () => {
  const manifest = readManifest();
  for (const hull of manifest.hulls.filter((entry) => entry.family === 'aur-fleet-v2')) {
    assert.equal(hull.license, 'CC0');
    assert.match(hull.source, /Agent Universe original fleet-scale-v2/);
    assert.ok(Math.abs(hull.correction.rotateY - Math.PI) < 1e-6, `${hull.id} turns its -Z nose to +Z`);
    assert.deepEqual(hull.correction.offset, [0, 0, 0], `${hull.id} is centred by the build`);
    const lods = { far: hull.lods.far, near: hull.file };
    const triangles = {};
    for (const [lod, file] of Object.entries(lods)) {
      assert.match(file, new RegExp(`^fleet-v2/${hull.id}-${lod}\\.glb$`));
      const { bytes, model } = readGlbJson(path.join(SHIP_ROOT, file));
      assert.ok(bytes.length < 2 * 1024 * 1024, `${file} remains below the runtime cap`);
      assert.ok(model.meshes.length <= 8, `${file} draws at most eight meshes`);
      assert.deepEqual(model.extensionsUsed || [], [], `${file} needs no glTF extension or decoder`);
      assert.equal((model.images || []).length, 0, `${file} is untextured; the provider tint owns colour`);
      const accent = model.materials.findIndex((material) => material.name === 'accent_energy');
      assert.ok(model.meshes.some((mesh) => mesh.primitives.some((primitive) => primitive.material === accent)),
        `${file} keeps accent geometry for the provider tint`);
      triangles[lod] = glbTriangles(model);
    }
    assert.ok(triangles.far <= 4_500, `${hull.id} far LOD ${triangles.far} triangles`);
    assert.ok(triangles.near <= 20_000 && triangles.near > triangles.far, `${hull.id} near LOD ${triangles.near}`);
  }
});

test('fleet-v2 display size grows gently with rank, from today\'s hull size', () => {
  const manifest = readManifest();
  const ranks = manifest.hulls.filter((hull) => hull.family === 'aur-fleet-v2' && Number.isFinite(hull.minBuilds))
    .sort((a, b) => a.minBuilds - b.minBuilds);
  const lengths = ranks.map((hull) =>
    hull.correction.scale * glbLength(readGlbJson(path.join(SHIP_ROOT, hull.file)).model));
  for (let i = 1; i < lengths.length; i++) assert.ok(lengths[i] > lengths[i - 1], 'each rank is larger');
  assert.ok(Math.abs(lengths[0] - 3) < 0.05, `interceptor displays ${lengths[0]} long, like today's hulls`);
  const growth = lengths.at(-1) / lengths[0];
  assert.ok(growth > 1.7 && growth < 1.9, `carrier is ${growth}x the interceptor`);
});

test('provider colors are fixed fleet identities in renderer source; a local model flies red', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'util.js'), 'utf8');
  assert.match(source, /key: 'claude', label: 'Claude', color: '#b026ff'/);
  assert.match(source, /key: 'codex', label: 'Codex', color: '#2f7dff'/);
  assert.match(source, /LOCAL_MODEL = Object\.freeze\(\{ key: 'local', label: 'Local model', color: '#ff3344' \}\)/);
  assert.match(source, /AUR\.shipTint = \(shipId, provider\) =>/);
  assert.match(source, /ship\.local === true/);
  assert.match(source, /kind === 'drone'/);
  assert.match(source, /providerKey\(ship\.provider\) === 'generic'/);
});

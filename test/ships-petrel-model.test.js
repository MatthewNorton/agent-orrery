'use strict';

// Petrel's adapter (src/renderer/ships/petrel/model.js) on the real Babylon build (a NullEngine and
// a stand-in canvas): the bare ship flies the Scout rank, and the same build with its survey ring
// fitted flies the Workhorse and Capital ranks.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const BABYLON = require('babylonjs');
const { withCanvas, onNullScene, fingerprintOf } = require('../scripts/lib/ship-fingerprint.js');
const { readRenderer } = require('./support/renderer-source');
const { readGlbJson, glbLength } = require('./support/glb');
const { hullOf, ship } = require('./support/ship-assets');
const { manifest, loadShipModels: load, onSystem } = require('./support/ships-models');

const record = JSON.parse(readRenderer('ships/petrel/source/source.json'));
const rank = (minBuilds) => manifest.hulls.find((hull) => hull.family === manifest.providerFamilies.claude && hull.minBuilds === minBuilds);
const [SCOUT, WORKHORSE, CAPITAL] = [0, 5, 20].map(rank);
const onScene = (work) => withCanvas(() => onNullScene(BABYLON, (scene) => work(scene, load().shipModels)));
const near = (a, b, epsilon = 1e-9) => Math.abs(a - b) < epsilon;

test('ringed, Petrel flies the Workhorse and Capital ranks: one container for both, a hull of its own in each', () => {
  const models = load().shipModels;
  const [workhorse, capital] = [WORKHORSE, CAPITAL].map((hull) => models.inPlaceOf(hull));
  const named = ({ id, file, role, minBuilds }) => ({ id, file, role, minBuilds });
  assert.deepEqual(named(workhorse), { id: 'petrel-ring', file: 'model:petrel-ring', role: WORKHORSE.role, minBuilds: 5 });
  assert.deepEqual(named(capital), { id: 'petrel-ring-2', file: 'model:petrel-ring', role: CAPITAL.role, minBuilds: 20 },
    'the file keys one container and template; the id names the rank, so a promotion between them refreshes');
  assert.equal(workhorse.model, capital.model, 'one model');
  assert.notEqual(workhorse.model, models.inPlaceOf(SCOUT).model, 'the Scout flies the bare ship');
  assert.equal(models.inPlaceOf(CAPITAL), capital, 'one hull entry per rank');
});

// The fleet's ladder grows by display length; the ringed ship's longest side is its ring.
test('each ringed rank flies at the size the fleet\'s hull for that rank is shown at', () => {
  const models = load().shipModels;
  for (const hull of [WORKHORSE, CAPITAL]) {
    const shown = hull.correction.scale * glbLength(readGlbJson(path.join(__dirname, '..', 'assets', 'ships', hull.file)).model);
    const { correction, model } = models.inPlaceOf(hull);
    assert.ok(Math.abs(correction.scale / model.correction.scale - shown) < 0.01, `${hull.id}: shown ${shown} long`);
    assert.deepEqual(correction.offset, model.correction.offset);
  }
});

test('the ringed model is the build the Scout flies with its ring fitted: the variant source.json records', () => {
  const models = load().shipModels;
  assert.deepEqual(fingerprintOf(BABYLON, (scene) => models.inPlaceOf(SCOUT).model.build(scene)), record.geometry);
  assert.deepEqual(fingerprintOf(BABYLON, (scene) => models.inPlaceOf(WORKHORSE).model.build(scene)), record.variants.ring.geometry);
});

test('the ringed ship sits in the fleet frame its correction claims: its ring, its longest side, one unit across, centred', () => {
  onScene((scene, models) => {
    const ringed = models.inPlaceOf(WORKHORSE).model;
    const { scale, offset } = ringed.correction;
    const root = ringed.build(scene);
    root.computeWorldMatrix(true);
    const { min, max } = root.getHierarchyBoundingVectors(true);
    const size = max.subtract(min);
    assert.ok(size.x > size.z && near(size.x, size.y, 0.01), 'the ring is wider than the hull is long');
    assert.ok(Math.abs(size.x * scale - 1) < 0.005, `the ring is ${size.x * scale} across`);
    assert.ok(Math.abs((max.z + min.z) / 2 + offset[2]) * scale < 0.005, 'centred along its length');
    assert.ok(Math.abs(max.x + min.x) * scale < 0.005 && offset[0] === 0, 'centred across its span');
  });
});

// The scene's triangle budget counts a container's indices, not the fingerprint's meshes.
test('a ringed container holds the triangles the variant records, as one mesh', () => {
  onScene((scene, models) => {
    const held = models.container(scene, models.inPlaceOf(CAPITAL).model);
    assert.equal(held.meshes.length, 1);
    assert.equal(held.meshes[0].getTotalIndices() / 3, record.variants.ring.geometry.triangles);
  });
});

test('the nozzles follow the rank\'s size', () => {
  const models = load().shipModels;
  const [scout, workhorse, capital] = [SCOUT, WORKHORSE, CAPITAL].map((hull) => models.inPlaceOf(hull));
  const [bare, small, large] = [scout, workhorse, capital].map((hull) => models.nozzles(hull.id));
  const grows = (from, to, ratio) => from.every((nozzle, i) =>
    nozzle.position.scale(ratio).equalsWithEpsilon(to[i].position, 1e-9) && near(nozzle.radius * ratio, to[i].radius));
  assert.ok(grows(bare, small, workhorse.correction.scale / scout.correction.scale), 'the same stern, at the Workhorse size');
  assert.ok(grows(small, large, 1.55 / 1.25), 'and at the Capital size');
});

test('in a system both ringed ranks of a provider draw from one template, and a promotion between them grows the hull', () =>
  onSystem(async (scene, AUR) => {
    AUR.shipModels.lights(scene);
    const fly = (id, builds) => AUR.ships.upgrade(scene, ship(id, builds), new BABYLON.Mesh('dart ' + id, scene));
    const [w, c, s] = [await fly('w', 5), await fly('c', 20), await fly('s', 0)];
    assert.deepEqual([w, c, s].map((root) => root.metadata.assetHullId), ['petrel-ring', 'petrel-ring-2', 'petrel']);
    assert.equal(hullOf(w).sourceMesh, hullOf(c).sourceMesh, 'one template for both ranks');
    assert.notEqual(hullOf(w).sourceMesh, hullOf(s).sourceMesh, 'and another for the Scout');
    const { ships } = AUR.shipAssets.sceneStates.get(scene);
    const sizeOf = (id) => ships.get(id).correction.scaling.x;
    assert.ok(near(sizeOf('c') / sizeOf('w'), 1.55 / 1.25));

    const workhorse = sizeOf('w');
    assert.equal(await AUR.ships.refresh(scene, ship('w', 20)), w);
    assert.equal(w.metadata.assetHullId, 'petrel-ring-2');
    assert.ok(near(sizeOf('w'), sizeOf('c')) && sizeOf('w') > workhorse, 'promoted to the Capital size');
    assert.equal(hullOf(w).sourceMesh, hullOf(c).sourceMesh, 'on the same template');
  }));

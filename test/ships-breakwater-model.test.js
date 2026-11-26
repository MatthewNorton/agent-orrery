'use strict';

// Breakwater's adapter (src/renderer/ships/breakwater/model.js) on the real Babylon build (a
// NullEngine and a stand-in canvas): the drydock flies the Flagship rank, four Petrels parked on it.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const BABYLON = require('babylonjs');
const { fingerprintOf } = require('../scripts/lib/ship-fingerprint.js');
const { readRenderer } = require('./support/renderer-source');
const { readGlbJson, glbLength } = require('./support/glb');
const { ship } = require('./support/ship-assets');
const { rank, loadShipModels: load, onModelScene: onScene, onSystem } = require('./support/ships-models');

const record = JSON.parse(readRenderer('ships/breakwater/source/source.json'));
const [SCOUT, CAPITAL, FLAGSHIP] = [0, 20, 60].map(rank);
const near = (a, b, epsilon = 1e-9) => Math.abs(a - b) < epsilon;
const trianglesOf = (mesh) => mesh.getTotalIndices() / 3;

test('Breakwater flies the Flagship rank, as wide as the fleet shows its Flagship long', () => {
  const models = load().shipModels;
  const hull = models.inPlaceOf(FLAGSHIP);
  assert.deepEqual({ id: hull.id, file: hull.file, role: hull.role, minBuilds: hull.minBuilds },
    { id: 'breakwater', file: 'model:breakwater', role: FLAGSHIP.role, minBuilds: 60 });
  const shown = FLAGSHIP.correction.scale * glbLength(readGlbJson(path.join(__dirname, '..', 'assets', 'ships', FLAGSHIP.file)).model);
  assert.ok(near(hull.correction.scale / hull.model.correction.scale, shown, 0.01), `shown ${shown} long`);
  assert.deepEqual(fingerprintOf(BABYLON, (scene) => hull.model.build(scene)), record.geometry, 'the build source.json records');
});

test('the yard sits in the fleet frame its correction claims: one unit across its berths, centred, its decks up', () => {
  onScene((scene, models) => {
    const { model } = models.inPlaceOf(FLAGSHIP);
    const { scale, offset } = model.correction;
    const root = model.build(scene);
    root.computeWorldMatrix(true);
    const { min, max } = root.getHierarchyBoundingVectors(true);
    const size = max.subtract(min);
    assert.ok(near(size.x, size.z, 0.01) && size.x > size.y, 'as wide as it is long, and wider than it is tall');
    assert.ok(near(size.x * scale, 1, 0.005), `it is ${size.x * scale} across`);
    assert.ok(near((max.x + min.x) * scale, 0, 0.005) && near((max.z + min.z) * scale, 0, 0.005), 'centred on its axis');
    assert.deepEqual(offset, [0, 0, 0]);
    assert.ok(max.y > 0 && min.y < -max.y, 'its bridge above the decks and its keel, the longer, below');
  });
});

// The yard builds one quadrant and one Petrel and instances each three times; a merge takes no
// instance, and it builds a finish from many parts.
test('its container holds the whole yard as one mesh: every quadrant and Petrel where it stands, a sub-mesh per finish', () => {
  onScene((scene, models) => {
    const { model } = models.inPlaceOf(FLAGSHIP);
    const built = model.build(scene);
    built.computeWorldMatrix(true);
    const parts = built.getChildMeshes(false);
    assert.ok(parts.some((part) => part.isAnInstance), 'the build instances its repeated parts');
    const finishes = new Set(parts.map((part) => part.material.name));
    const stands = built.getHierarchyBoundingVectors(true);
    built.dispose(false, true);

    const held = models.container(scene, model);
    const [hull] = held.meshes;
    assert.equal(held.meshes.length, 1);
    assert.deepEqual([scene.meshes.length, scene.transformNodes.length], [0, 0], 'the built yard is not drawn, and its parts are gone');
    assert.equal(trianglesOf(hull), record.geometry.triangles);
    assert.deepEqual(new Set(hull.material.subMaterials.map((finish) => finish.name)), finishes);
    assert.equal(hull.subMeshes.length, finishes.size, 'one draw per finish');
    hull.refreshBoundingInfo();
    const { minimum, maximum } = hull.getBoundingInfo().boundingBox;
    assert.ok(minimum.equalsWithEpsilon(stands.min, 1e-3) && maximum.equalsWithEpsilon(stands.max, 1e-3), 'nothing moved in the merge');
    // The four Petrels' tires, alone in their finish, stand on the four berths.
    const tires = hull.subMeshes[hull.material.subMaterials.findIndex((finish) => finish.name === 'Landing tires')];
    tires.refreshBoundingInfo(hull.getVerticesData('position'));
    const reach = tires.getBoundingInfo().boundingBox;
    for (const side of [reach.minimum.x, reach.maximum.x, reach.minimum.z, reach.maximum.z]) {
      assert.ok(Math.abs(side) > 20 && Math.abs(side) < 25, `a berth ${side} from the axis`);
    }
  });
});

test('its work lights are lamps in the ship color, its parked Petrels wear the trim they fly in, its windows stay lit as painted', () => {
  onScene((scene, models, AUR) => {
    const { model } = models.inPlaceOf(FLAGSHIP);
    const petrel = models.inPlaceOf(SCOUT).model;
    for (const [name, role] of Object.entries(petrel.trim)) assert.deepEqual(model.trim[name], role, name);
    assert.equal(model.trim['Work lights'], models.TRIM_LIGHT);

    const finishes = models.container(scene, model).meshes[0].material.subMaterials;
    const named = (name) => finishes.find((finish) => finish.name === name);
    for (const name of Object.keys(model.trim)) assert.ok(named(name), name + ' is a finish of the yard');
    const materials = new Map();
    for (const [palette, hex] of [['claude', AUR.PROVIDERS.claude.color], ['codex', AUR.PROVIDERS.codex.color], ['local', AUR.LOCAL_MODEL.color]]) {
      const lamp = models.material(materials, model, palette, hex, named('Work lights'));
      assert.notEqual(lamp, named('Work lights'), palette);
      assert.ok(lamp.emissiveColor.equalsWithEpsilon(BABYLON.Color3.FromHexString(hex).toLinearSpace(), 1e-6), `${palette}: lit in the ship color`);
      assert.equal(lamp.emissiveIntensity, models.TRIM_LIGHT);
      const windows = named('Inhabited pressure windows');
      assert.equal(models.material(materials, model, palette, hex, windows), windows, `${palette}: the windows are the art's`);
    }
    assert.ok(named('Inhabited pressure windows').emissiveTexture, 'the rooms the art lights');
  });
});

test('a yard has no drive: it names no nozzle, where a hull that is no model\'s has none to name', () => {
  const models = load().shipModels;
  const nozzles = models.nozzles(models.inPlaceOf(FLAGSHIP).id);
  assert.ok(Array.isArray(nozzles) && nozzles.length === 0, 'the system view trails nothing from it');
  assert.equal(models.nozzles(FLAGSHIP.id), null);
});

test('in a system a ship of sixty builds flies the yard, and a Capital is promoted onto it', () =>
  onSystem(async (scene, AUR) => {
    AUR.shipModels.lights(scene);
    const fly = (id, builds) => AUR.ships.upgrade(scene, ship(id, builds), new BABYLON.Mesh('dart ' + id, scene));
    const [f, c] = [await fly('f', 60), await fly('c', 20)];
    assert.deepEqual([f, c].map((root) => root.metadata.assetHullId), ['breakwater', models(AUR).inPlaceOf(CAPITAL).id]);
    assert.equal(await AUR.ships.refresh(scene, ship('c', 60)), c);
    assert.equal(c.metadata.assetHullId, 'breakwater');
    const { ships } = AUR.shipAssets.sceneStates.get(scene);
    assert.ok(near(ships.get('c').correction.scaling.x, ships.get('f').correction.scaling.x), 'at the Flagship size');
  }));

function models(AUR) { return AUR.shipModels; }

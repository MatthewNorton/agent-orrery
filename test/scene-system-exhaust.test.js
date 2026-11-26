'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const BABYLON = require('babylonjs');
const { readRenderer: renderer, runRenderer } = require('./support/renderer-source');
const { rank, onModelScene } = require('./support/ships-models');

test('the system view trails a plume from each stern nozzle of a hull, read off its glow discs', () => {
  const exhaust = renderer('scene/system/exhaust.js');
  const ships = renderer('scene/system/ships.js');
  const focus = renderer('scene/system/focus.js');
  const view = renderer('scene/system/view.js');

  assert.match(view, /parts\.exhaust\(view\)/);
  assert.match(exhaust, /mesh\.material\.metadata\.role !== 'glow'/, 'nozzles are the glow material');
  assert.match(exhaust, /AUR\.meshIslands\(positions, indices\)/, 'one plume per disc, not one per mesh');
  assert.match(exhaust, /AUR\.sternIslands\(islands, length, PLUME\.sternShare\)/, 'lit intakes forward of the stern get no plume');
  assert.match(exhaust, /AUR\.memo\(hulls, rec\.hull/, 'nozzles are found once per hull, not once per ship');
  assert.match(exhaust, /const named = AUR\.shipModels\.nozzles\(rec\.hull\);\s+if \(named\) return named;/, 'a ship model names its own nozzles');
  assert.match(exhaust, /new BABYLON\.TrailMesh\([^)]*anchor/, 'the ribbon trails a nozzle anchor under the root, not the root');
  assert.match(exhaust, /plumeMaterial\(rec\.tint\)/, 'one material per tint, shared by every plume');
  assert.match(exhaust, /glow\.addExcludedMesh\(trail\)/, 'additive plumes skip the glow pass');
  assert.match(exhaust, /rec\.hull === hull/, 'the part re-anchors when the hull under the record changes');
  assert.doesNotMatch(ships, /TrailMesh/, 'the ships part no longer trails from the ship origin');
  assert.match(ships, /if \(view\.refreshExhaust\(r\)\) view\.applyShipFocusVisual\(r\);/, 'each frame the plumes follow the hull and the focus fade covers them');
  assert.match(ships, /view\.detachExhaust\(r\);/);
  assert.match(focus, /rec\.plumes/, 'focus fades the plumes with the ship');
});

// On the real Babylon build (a NullEngine): the part itself, over a dart, a Petrel and the yard.
test('a dart trails from its tail and a Petrel from its two nozzles; a yard names no nozzle, trails nothing and is asked once', () =>
  onModelScene((scene, models, AUR) => {
    AUR.sceneParts = { system: {} };
    runRenderer('scene/system/exhaust.js', { window: { AUR }, BABYLON });
    const part = AUR.sceneParts.system.exhaust({ scene, glow: { addExcludedMesh() {} } });
    const [petrel, yard] = [0, 60].map((builds) => models.inPlaceOf(rank(builds)).id);
    // A ship record as the ships part makes it, flying the hull named (none: a dart).
    const flying = (hull) => {
      const mesh = new BABYLON.Mesh('ship', scene);
      mesh.metadata = hull ? { assetHullId: hull } : null;
      return { id: 'ship', mesh, tint: '#ffffff', hull: undefined, plumes: [] };
    };
    const trails = (rec) => [part.refreshExhaust(rec), rec.plumes.length, part.refreshExhaust(rec)];

    assert.deepEqual(trails(flying(null)), [true, 1, false], 'a dart');
    assert.deepEqual(trails(flying(petrel)), [true, 2, false], 'a Petrel');
    const station = flying(yard);
    assert.equal(models.nozzles(yard).length, 0);
    assert.deepEqual(trails(station), [true, 0, false], 'no plume, and not hung again each frame');

    station.mesh.metadata.assetHullId = petrel; // another hull under the same record
    assert.deepEqual(trails(station), [true, 2, false], 'the plumes follow the hull');
    station.mesh.metadata.assetHullId = yard;
    assert.deepEqual(trails(station), [true, 0, false], 'and leave with it');
    assert.equal(scene.meshes.filter((mesh) => mesh.name.startsWith('t_')).length, 3, 'the dart\'s and the Petrel\'s are all that is left');
  }));

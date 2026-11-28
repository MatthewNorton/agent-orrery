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
  assert.match(exhaust, /rec\.hull === AUR\.shipHullId\(rec\.mesh\)/, 'the part re-anchors when the hull under the record changes');
  assert.match(ships, /view\.attachExhaust\(rec\);/, 'a new ship gets its plumes when it is built');
  assert.doesNotMatch(ships, /TrailMesh/, 'the ships part no longer trails from the ship origin');
  assert.match(ships, /if \(view\.refreshExhaust\(r\)\) view\.applyShipFocusVisual\(r\);/, 'each frame the plumes follow the hull and the focus fade covers them');
  assert.match(ships, /view\.detachExhaust\(r\);/);
  assert.match(focus, /rec\.plumes/, 'focus fades the plumes with the ship');
});

// On the real Babylon build (a NullEngine): the part itself, over a dart, a Petrel and the yard.
test('a dart trails from its tail and a Petrel from its two nozzles; a yard names no nozzle and trails nothing', () =>
  onModelScene((scene, models, AUR) => {
    AUR.sceneParts = { system: {} };
    runRenderer('scene/system/exhaust.js', { window: { AUR }, BABYLON });
    const part = AUR.sceneParts.system.exhaust({ scene, glow: { addExcludedMesh() {} } });
    const [petrel, yard] = [0, 60].map((builds) => models.inPlaceOf(rank(builds)).id);
    // A ship record as the ships part makes it and hangs its plumes, flying the hull named (none: a dart).
    const flying = (hull, dress = () => {}) => {
      const mesh = new BABYLON.Mesh('ship', scene);
      mesh.metadata = hull ? { assetHullId: hull } : null;
      dress(mesh);
      const rec = { id: 'ship', mesh, tint: '#ffffff', hull: null, plumes: [] };
      part.attachExhaust(rec);
      return rec;
    };
    // The plumes it trails, and whether a later frame hangs them again.
    const trails = (rec) => [rec.plumes.length, part.refreshExhaust(rec)];

    const dart = flying(null);
    assert.deepEqual(trails(dart), [1, false], 'a dart');
    // The dart stands in for a Scout: about a Scout and a half across, its plume from inside its tail.
    const shape = AUR.dartMesh(scene, 'dart', '#ffffff');
    shape.refreshBoundingInfo();
    const { minimum, maximum } = shape.getBoundingInfo().boundingBox;
    const across = (maximum.z - minimum.z) / AUR.SCOUT_LENGTH;
    assert.ok(across > 1.3 && across < 1.5, `the dart is ${across} Scouts across`);
    const tail = dart.plumes[0].anchor.position;
    assert.ok(tail.z < 0 && tail.z > minimum.z && tail.x === 0 && tail.y === 0, 'from inside its tail');
    shape.dispose(false, true);
    assert.deepEqual(trails(flying(petrel)), [2, false], 'a Petrel');
    const station = flying(yard);
    assert.deepEqual(trails(station), [0, false], 'no plume, and not hung again each frame');

    station.mesh.metadata.assetHullId = petrel; // another hull under the same record
    assert.deepEqual([part.refreshExhaust(station), ...trails(station)], [true, 2, false], 'the plumes follow the hull');
    station.mesh.metadata.assetHullId = yard;
    assert.deepEqual([part.refreshExhaust(station), ...trails(station)], [true, 0, false], 'and leave with it');
    assert.equal(scene.meshes.filter((mesh) => mesh.name.startsWith('t_')).length, 3, 'the dart\'s and the Petrel\'s are all that is left');

    // A hull file that shows no nozzle trails from the end of its own hull, wherever the hull sits
    // on its root, not from a dart's tail.
    const bare = flying('a-hull-file', (mesh) => {
      const part = BABYLON.MeshBuilder.CreateBox('part', { width: 0.4, height: 0.2, depth: 2 }, scene);
      part.parent = mesh;
      part.position.z = 0.5;
    });
    assert.equal(bare.plumes.length, 1);
    assert.ok(bare.plumes[0].anchor.position.equalsWithEpsilon(new BABYLON.Vector3(0, 0, -0.5), 1e-6), 'at the stern of a hull two units long, set half a unit forward');
  }));

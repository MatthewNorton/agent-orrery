'use strict';

// The system view's focus part (src/renderer/scene/system/focus.js) on the real Babylon build: what
// focus mode shows of each ship. AUR.ships records the fades it is asked for: the hulls are its own.
const test = require('node:test');
const assert = require('node:assert/strict');
const BABYLON = require('babylonjs');
const { onNullScene } = require('../scripts/lib/ship-fingerprint.js');
const { loadUtilLayer, runRenderer } = require('./support/renderer-source');

function loadFocus(scene) {
  const window = { matchMedia: () => ({ matches: false }) };
  const AUR = loadUtilLayer(window, BABYLON);
  AUR.sceneParts = { system: {} };
  const fades = []; // [visibility, apart] per AUR.ships.fade
  AUR.ships = {
    fade(on, visibility, apart) {
      assert.equal(on, scene);
      fades.push([visibility, apart]);
    },
  };
  runRenderer('scene/system/focus.js', { window, BABYLON });
  // The system camera, with no canvas to take input from.
  const camera = Object.assign(new BABYLON.ArcRotateCamera('scam', 0, 1, 40, BABYLON.Vector3.Zero(), scene), {
    attachControl() {}, detachControl() {},
  });
  const view = { scene, canvas: {}, camera, ships: new Map(), outer: 20, shipFocus: null };
  Object.assign(view, AUR.sceneParts.system.focus(view));
  return { view, fades };
}

function hiddenTemplate(scene, size = 1) {
  const template = BABYLON.MeshBuilder.CreateBox('ship_template', { size }, scene);
  template.isVisible = false;
  return template;
}

// A hull as AUR.ships builds it under an asset root: a correction node holding a geometry-less
// copy of the model root and an instance of the provider's template. `writes` collects every
// visibility set on the instance.
function buildHull(scene, root, template, id) {
  const correction = new BABYLON.TransformNode('ship_correction_' + id, scene);
  correction.parent = root;
  const copy = new BABYLON.Mesh('ship_' + id + '___root__', scene);
  copy.parent = correction;
  const instance = template.createInstance('ship_' + id + '_hull');
  instance.parent = copy;
  const writes = [];
  Object.defineProperty(instance, 'visibility', { get: () => template.visibility, set: (value) => writes.push(value) });
  return { correction, instance, writes };
}

// A ship as the ships part records it: its hull (under its dart when `dart`, after the plume
// anchors the dart flew with when `anchorsFirst`) and a plume.
function addShip(scene, view, template, id, { dart = false, anchorsFirst = false } = {}) {
  const root = new BABYLON.Mesh('ship_asset_' + id, scene);
  root.metadata = { assetHullId: 'petrel', isShip: true, shipId: id };
  const hull = buildHull(scene, root, template, id);
  let mesh = root;
  if (dart) {
    mesh = BABYLON.MeshBuilder.CreateBox('s_shp_' + id, { size: 4 }, scene); // drawn by its hull now
    mesh.isVisible = false;
    mesh.metadata = { isShip: false, upgradedHullId: 'petrel' };
    if (anchorsFirst) new BABYLON.TransformNode('nz_' + id + '_0', scene).parent = mesh;
    root.parent = mesh;
  }
  const rec = {
    id, mesh, root, ...hull, plumes: [{ trail: new BABYLON.Mesh('t_' + id, scene) }],
    label: { isVisible: true }, suffix: { isVisible: false, text: '' },
  };
  view.ships.set(id, rec);
  return rec;
}

// A promotion as ship-assets-hulls.js makes it: a new hull under the same root, and the new id on
// the root and on the dart.
function swapHull(scene, rec, template, hullId) {
  const old = rec.correction;
  Object.assign(rec, buildHull(scene, rec.root, template, rec.id));
  old.dispose();
  rec.root.metadata = { ...rec.root.metadata, assetHullId: hullId };
  if (rec.mesh !== rec.root) rec.mesh.metadata = { ...rec.mesh.metadata, upgradedHullId: hullId };
}

// The visibility of every node of a ship that is not an instance: the dart, the asset root, the
// model root's copy and the plume.
const shown = (rec) => [...new Set([...rec.mesh.getChildMeshes(false), rec.mesh].filter((node) => !node.isAnInstance)
  .concat(rec.plumes.map((plume) => plume.trail)).map((node) => node.visibility))];

// AUR.ships fades every hull, those built later too, so focus mode asks it once per change of focus
// and fades only the meshes of a ship's own.
test('focus mode fades the other ships and hides the followed one from inside, and clearing restores every ship', () =>
  onNullScene(BABYLON, (scene) => {
    const { view, fades } = loadFocus(scene);
    const template = hiddenTemplate(scene);
    const recs = [addShip(scene, view, template, 'a'), addShip(scene, view, template, 'b', { dart: true }), addShip(scene, view, template, 'c')];
    recs[2].suffix.text = '· needs you';

    assert.equal(view.focusShip('a', { exterior: true }), true);
    assert.deepEqual(fades.splice(0), [[0.16, { shipId: 'a', visibility: 1 }]], 'outside: the followed hull in full, the others faded');
    assert.deepEqual(recs.map(shown), [[1], [0.16], [0.16]], 'the meshes of their own fade with them');
    assert.ok(recs.every((rec) => !rec.label.isVisible && !rec.suffix.isVisible), 'labels hidden');

    view.setShipFocus({ exterior: false });
    assert.deepEqual(fades.splice(0), [[0.16, { shipId: 'a', visibility: 0 }]], 'inside: the followed hull hidden');
    assert.deepEqual(shown(recs[0]), [0]);

    const built = addShip(scene, view, template, 'd'); // a ship that spawns during focus
    view.applyShipFocusVisual(built);
    assert.deepEqual([fades.length, shown(built)], [0, [0.16]], 'its hull is built faded; its meshes fade here');

    // Following another ship: app/agent-focus.js leaves focus and enters it again.
    view.clearShipFocus();
    assert.equal(view.focusShip('b', { exterior: true }), true);
    assert.deepEqual(fades.splice(0), [[1, undefined], [0.16, { shipId: 'b', visibility: 1 }]]);
    assert.deepEqual(recs.map(shown), [[0.16], [1], [0.16]]);
    const late = addShip(scene, view, template, 'e');
    view.applyShipFocusVisual(late);

    view.clearShipFocus();
    view.clearShipFocus();
    assert.deepEqual(fades.splice(0), [[1, undefined]], 'every hull restored, once');
    assert.deepEqual([...view.ships.values()].map(shown), [[1], [1], [1], [1], [1]], 'every ship restored, those built during focus too');
    assert.ok([...view.ships.values()].every((rec) => rec.label.isVisible), 'labels back');
    assert.deepEqual([...view.ships.values()].map((rec) => rec.suffix.isVisible), [false, false, true, false, false],
      'an attention suffix shows again when it has text');
    assert.deepEqual([...view.ships.values()].flatMap((rec) => rec.writes), [], 'no visibility is set on an instance');
    assert.equal(view.shipFocus, null);
  }));

// The chase camera stands back in proportion to the hull's diagonal (CHASE.distance in focus.js).
test('the chase camera measures a hull again when a promotion swaps it in place, and under a dart measures the hull, not its plume anchors', () =>
  onNullScene(BABYLON, (scene) => {
    const { view } = loadFocus(scene);
    const small = hiddenTemplate(scene);
    const back = (rec) => BABYLON.Vector3.Distance(scene.activeCamera.position, rec.mesh.getAbsolutePosition());
    const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} vs ${expected}`);

    const built = addShip(scene, view, small, 'a');
    view.focusShip('a', { exterior: true });
    const unit = back(built);
    swapHull(scene, built, hiddenTemplate(scene, 3), 'workhorse');
    view.updateShipFocusCamera(true, 0);
    near(back(built), unit * 3, 'a hull built in place, promoted to one three times the size');

    const upgraded = addShip(scene, view, small, 'b', { dart: true });
    view.clearShipFocus();
    view.focusShip('b', { exterior: true });
    near(back(upgraded), unit, 'a hull under its dart, as the same hull built in place');
    swapHull(scene, upgraded, hiddenTemplate(scene, 2), 'workhorse');
    view.updateShipFocusCamera(true, 0);
    near(back(upgraded), unit * 2, 'and promoted');

    // The dart's plumes hang on it until the frame after its hull arrives.
    const arrived = addShip(scene, view, small, 'c', { dart: true, anchorsFirst: true });
    view.clearShipFocus();
    view.focusShip('c', { exterior: true });
    near(back(arrived), unit, 'the hull, not the anchor before it');
  }));

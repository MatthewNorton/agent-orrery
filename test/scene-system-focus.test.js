'use strict';

// The system view's focus part (src/renderer/scene/system/focus.js) on the real Babylon build: what
// focus mode shows of each ship. AUR.ships records the visibility each hull was moved to.
const test = require('node:test');
const assert = require('node:assert/strict');
const BABYLON = require('babylonjs');
const { onNullScene } = require('../scripts/lib/ship-fingerprint.js');
const { readRenderer, runRenderer } = require('./support/renderer-source');

function loadFocus(scene) {
  const window = { matchMedia: () => ({ matches: false }) };
  runRenderer('util.js', { window });
  runRenderer('util-scene.js', { window, BABYLON });
  const { AUR } = window;
  AUR.sceneParts = { system: {} };
  const hulls = new Map(); // ship id -> the visibility its hull shows (each is built at 1)
  const moves = []; // [id, visibility] per rebuilt hull: AUR.ships.fade rebuilds only for a new visibility
  AUR.ships = {
    fade(_scene, id, visibility) {
      if ((hulls.get(id) ?? 1) !== visibility) moves.push([id, visibility]);
      hulls.set(id, visibility);
      return true;
    },
  };
  runRenderer('scene/system/focus.js', { window, BABYLON });
  // The system camera, with no canvas to take input from.
  const camera = Object.assign(new BABYLON.ArcRotateCamera('scam', 0, 1, 40, BABYLON.Vector3.Zero(), scene), {
    attachControl() {}, detachControl() {},
  });
  const view = { scene, canvas: {}, camera, ships: new Map(), outer: 20, shipFocus: null };
  Object.assign(view, AUR.sceneParts.system.focus(view));
  // The view's frame moves the hulls focus mode asked for (scene/system/view.js).
  return { view, hulls, moves, frame: () => view.applyHullFades() };
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

test('focus mode fades the other ships\' hulls and hides the followed one from inside, and clearing restores every ship', () =>
  onNullScene(BABYLON, (scene) => {
    const { view, hulls, frame } = loadFocus(scene);
    const template = hiddenTemplate(scene);
    const recs = [addShip(scene, view, template, 'a'), addShip(scene, view, template, 'b', { dart: true }), addShip(scene, view, template, 'c')];
    recs[2].suffix.text = '· needs you';

    assert.equal(view.focusShip('a', { exterior: true }), true);
    frame();
    assert.deepEqual(Object.fromEntries(hulls), { a: 1, b: 0.16, c: 0.16 }, 'outside: the followed hull in full, the others faded');
    assert.deepEqual(recs.map(shown), [[1], [0.16], [0.16]], 'the meshes of their own fade with them');
    assert.ok(recs.every((rec) => !rec.label.isVisible && !rec.suffix.isVisible), 'labels hidden');

    view.setShipFocus({ exterior: false });
    frame();
    assert.deepEqual(Object.fromEntries(hulls), { a: 0, b: 0.16, c: 0.16 }, 'inside: the followed hull hidden');
    assert.deepEqual(shown(recs[0]), [0]);

    const built = addShip(scene, view, template, 'd'); // a ship that spawns during focus
    view.applyShipFocusVisual(built);
    frame();
    assert.equal(hulls.get('d'), 0.16);

    // Following another ship: app/agent-focus.js leaves focus and enters it again.
    view.clearShipFocus();
    assert.equal(view.focusShip('b', { exterior: true }), true);
    frame();
    assert.deepEqual(Object.fromEntries(hulls), { a: 0.16, b: 1, c: 0.16, d: 0.16 });
    const late = addShip(scene, view, template, 'e');
    view.applyShipFocusVisual(late);

    view.clearShipFocus();
    frame();
    assert.deepEqual(Object.fromEntries(hulls), { a: 1, b: 1, c: 1, d: 1, e: 1 }, 'every ship restored, those built during focus too');
    assert.deepEqual([...view.ships.values()].map(shown), [[1], [1], [1], [1], [1]]);
    assert.ok([...view.ships.values()].every((rec) => rec.label.isVisible), 'labels back');
    assert.deepEqual([...view.ships.values()].map((rec) => rec.suffix.isVisible), [false, false, true, false, false],
      'an attention suffix shows again when it has text');
    assert.deepEqual([...view.ships.values()].flatMap((rec) => rec.writes), [], 'no visibility is set on an instance');
    assert.equal(view.shipFocus, null);
  }));

// Each move rebuilds a hull's instances (AUR.ships.fade), so the frame moves only the hulls whose
// visibility focus mode changed.
test('following another ship rebuilds only the two hulls that change, and a view left before its next frame rebuilds none', () =>
  onNullScene(BABYLON, (scene) => {
    const { view, hulls, moves, frame } = loadFocus(scene);
    const template = hiddenTemplate(scene);
    for (const id of ['a', 'b', 'c', 'd']) addShip(scene, view, template, id);
    view.focusShip('a', { exterior: true });
    frame();
    assert.deepEqual(moves.splice(0), [['b', 0.16], ['c', 0.16], ['d', 0.16]]);

    // app/agent-focus.js follows another ship by leaving focus and entering it again.
    view.clearShipFocus();
    view.focusShip('b', { exterior: true });
    frame();
    assert.deepEqual(moves.splice(0), [['a', 0.16], ['b', 1]], 'the old ship fades, the new one shows; the rest stay');

    // Leaving the view: app/boot.js leaves focus, then disposes the view, which clears it again.
    view.clearShipFocus();
    view.clearShipFocus();
    assert.deepEqual(moves, [], 'no hull is rebuilt for a scene that is going away');
    assert.deepEqual(Object.fromEntries(hulls), { a: 0.16, b: 1, c: 0.16, d: 0.16 });
    frame(); // a view that stays on screen restores them on its next frame
    assert.deepEqual(moves.splice(0), [['a', 1], ['c', 1], ['d', 1]]);
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

test('the system view moves the hulls each frame after the ships, before the chase camera measures one', () => {
  assert.match(readRenderer('scene/system/view.js'),
    /view\.animateShips\(dt, now, t\);\s+view\.applyHullFades\(\);\s+if \(view\.shipFocus\) view\.updateShipFocusCamera\(false, dt\);/);
});

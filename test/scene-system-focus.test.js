'use strict';

// The system view's focus part (src/renderer/scene/system/focus.js) on the real Babylon build: what
// focus mode shows of each ship. AUR.ships is a recorder of the visibility each hull was moved to.
const test = require('node:test');
const assert = require('node:assert/strict');
const BABYLON = require('babylonjs');
const { onNullScene } = require('../scripts/lib/ship-fingerprint.js');
const { runRenderer } = require('./support/renderer-source');

function loadFocus(scene) {
  const window = { matchMedia: () => ({ matches: false }) };
  runRenderer('util.js', { window });
  runRenderer('util-scene.js', { window, BABYLON });
  const { AUR } = window;
  AUR.sceneParts = { system: {} };
  const hulls = new Map(); // ship id -> the visibility its hull was last moved to
  AUR.ships = { fade(_scene, id, visibility) { hulls.set(String(id), visibility); return true; } };
  runRenderer('scene/system/focus.js', { window, BABYLON });
  // The system camera, with no canvas to take input from.
  const camera = Object.assign(new BABYLON.ArcRotateCamera('scam', 0, 1, 40, BABYLON.Vector3.Zero(), scene), {
    attachControl() {}, detachControl() {},
  });
  const view = { scene, canvas: {}, camera, ships: new Map(), outer: 20, shipFocus: null };
  Object.assign(view, AUR.sceneParts.system.focus(view));
  return { view, hulls };
}

// A ship as the ships part records it: its hull is an asset root holding a correction node, a
// geometry-less copy of the model root and an instance of the provider's template (under its dart
// when `dart`), and a plume. `writes` collects every visibility set on the instance.
function addShip(scene, view, template, id, { dart = false } = {}) {
  const root = new BABYLON.Mesh('ship_asset_' + id, scene);
  root.metadata = { assetHullId: 'petrel', isShip: true, shipId: id };
  const correction = new BABYLON.TransformNode('ship_correction_' + id, scene);
  correction.parent = root;
  const copy = new BABYLON.Mesh('ship_' + id + '___root__', scene);
  copy.parent = correction;
  const instance = template.createInstance('ship_' + id + '_hull');
  instance.parent = copy;
  const writes = [];
  Object.defineProperty(instance, 'visibility', { get: () => template.visibility, set: (value) => writes.push(value) });
  let mesh = root;
  if (dart) {
    mesh = new BABYLON.Mesh('s_shp_' + id, scene);
    mesh.metadata = { isShip: false, upgradedHullId: 'petrel' };
    root.parent = mesh;
  }
  const rec = {
    id, mesh, instance, writes, plumes: [{ trail: new BABYLON.Mesh('t_' + id, scene) }],
    label: { isVisible: true }, suffix: { isVisible: false, text: '' },
  };
  view.ships.set(id, rec);
  return rec;
}

// The visibility of every node of a ship that is not an instance: the dart, the asset root, the
// model root's copy and the plume.
const shown = (rec) => [...new Set([...rec.mesh.getChildMeshes(false), rec.mesh].filter((node) => !node.isAnInstance)
  .concat(rec.plumes.map((plume) => plume.trail)).map((node) => node.visibility))];

test('focus mode fades the other ships\' hulls and hides the followed one from inside, and clearing restores every ship', () =>
  onNullScene(BABYLON, (scene) => {
    const { view, hulls } = loadFocus(scene);
    const template = BABYLON.MeshBuilder.CreateBox('ship_template', { size: 1 }, scene);
    template.isVisible = false;
    const recs = [addShip(scene, view, template, 'a'), addShip(scene, view, template, 'b', { dart: true }), addShip(scene, view, template, 'c')];
    recs[2].suffix.text = '· needs you';

    assert.equal(view.focusShip('a', { exterior: true }), true);
    assert.deepEqual(Object.fromEntries(hulls), { a: 1, b: 0.16, c: 0.16 }, 'outside: the followed hull in full, the others faded');
    assert.deepEqual(recs.map(shown), [[1], [0.16], [0.16]], 'the meshes of their own fade with them');
    assert.ok(recs.every((rec) => !rec.label.isVisible && !rec.suffix.isVisible), 'labels hidden');

    view.setShipFocus({ exterior: false });
    assert.deepEqual(Object.fromEntries(hulls), { a: 0, b: 0.16, c: 0.16 }, 'inside: the followed hull hidden');
    assert.deepEqual(shown(recs[0]), [0]);

    const built = addShip(scene, view, template, 'd'); // a ship that spawns during focus
    view.applyShipFocusVisual(built);
    assert.equal(hulls.get('d'), 0.16);

    // Following another ship: app/agent-focus.js leaves focus and enters it again.
    view.clearShipFocus();
    assert.equal(view.focusShip('b', { exterior: true }), true);
    assert.deepEqual(Object.fromEntries(hulls), { a: 0.16, b: 1, c: 0.16, d: 0.16 });
    const late = addShip(scene, view, template, 'e');
    view.applyShipFocusVisual(late);

    view.clearShipFocus();
    assert.deepEqual(Object.fromEntries(hulls), { a: 1, b: 1, c: 1, d: 1, e: 1 }, 'every ship restored, those built during focus too');
    assert.deepEqual([...view.ships.values()].map(shown), [[1], [1], [1], [1], [1]]);
    assert.ok([...view.ships.values()].every((rec) => rec.label.isVisible), 'labels back');
    assert.deepEqual([...view.ships.values()].map((rec) => rec.suffix.isVisible), [false, false, true, false, false],
      'an attention suffix shows again when it has text');
    assert.deepEqual([...view.ships.values()].flatMap((rec) => rec.writes), [], 'no visibility is set on an instance');
    assert.equal(view.shipFocus, null);
  }));

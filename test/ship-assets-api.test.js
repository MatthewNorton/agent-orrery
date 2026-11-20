'use strict';

// AUR.ships (src/renderer/ship-assets-api.js): a hull refreshed in place on promotion, focus mode's
// fade, and the triangle budget.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { RENDERER, SHIP_LAYER, onLayer, loadShipAssets, LADDER_MANIFEST, ship, hullId, partMaterial } = require('./support/ship-assets');

test('refresh swaps the hull inside the same root and keeps the fallback valid', async () => {
  const assets = loadShipAssets(LADDER_MANIFEST, {});
  const scene = assets.scene('system');
  const fallback = assets.fallback('a');
  const root = await assets.ships.upgrade(scene, ship('a', 0), fallback);
  const firstCorrection = root.children[0];
  assert.equal(firstCorrection.scaling.x, 0.2);

  assert.equal(await assets.ships.refresh(scene, ship('a', 2)), null, 'same rank: nothing to do');
  assert.equal(await assets.ships.refresh(scene, ship('a', 4)), root);
  assert.equal(root.parent, fallback);
  assert.equal(root.scaling.x, 1, 'the hull sits at unit scale; the dart root carries the display scale');
  assert.equal(hullId(root), 'mid');
  assert.equal(root.metadata.isShip, true);
  assert.equal(fallback.metadata.upgradedHullId, 'mid');
  assert.equal(firstCorrection.disposed, true);
  assert.equal(root.children.length, 1);
  assert.equal(root.children[0].scaling.x, 0.3, 'class display size lives on the correction node');
  assert.equal(root.material.emissiveColor.toHexString(), '#d97757');

  assert.equal(await assets.ships.refresh(scene, ship('unknown', 50)), null);
  root.dispose();
  assert.equal(await assets.ships.refresh(scene, ship('a', 50)), null, 'a disposed ship is forgotten');
});

test('refresh re-tints a ship that turns out to run a local model, keeping its hull', async () => {
  const assets = loadShipAssets(LADDER_MANIFEST, {});
  const scene = assets.scene('system');
  const root = await assets.ships.upgrade(scene, ship('a', 0), assets.fallback('a'));
  assert.equal(root.material.emissiveColor.toHexString(), '#d97757');
  assert.equal(await assets.ships.refresh(scene, ship('a', 0, { local: true })), root);
  assert.equal(hullId(root), 'small', 'same rank, new colors');
  assert.equal(root.material.emissiveColor.toHexString(), '#ff3344');
  assert.equal(root.metadata.providerTint, '#ff3344');
  assert.equal(await assets.ships.refresh(scene, ship('a', 0, { local: true })), null, 'same look: nothing to do');
});

const instancesOf = (root) => root.getChildMeshes(false).filter((mesh) => mesh.isAnInstance);
const templatesOf = (root) => instancesOf(root).map((mesh) => mesh.sourceMesh);
const sameItems = (a, b) => a.length === b.length && a.every((item, i) => item === b[i]);

test('focus mode moves a ship to its provider\'s faded template and back, keeping its hull, scale and correction', async () => {
  const assets = loadShipAssets(LADDER_MANIFEST, {});
  const scene = assets.scene('system');
  const darts = { a: assets.fallback('a'), b: assets.fallback('b'), d: assets.fallback('d') };
  darts.d.scaling.setAll(0.6); // the view's drone scale lives on the dart root
  const a = await assets.ships.upgrade(scene, ship('a', 0), darts.a);
  const b = await assets.ships.upgrade(scene, ship('b', 0), darts.b);
  const drone = await assets.ships.upgrade(scene, ship('d', 40, { kind: 'drone' }), darts.d);
  const full = templatesOf(a);
  const triangles = assets.triangles(scene);
  assert.ok(sameItems(templatesOf(drone), full) && full.every((mesh) => mesh.visibility === 1), 'one full template for the provider');

  assert.equal(assets.ships.fade(scene, 'a', 0.16), true);
  const faded = templatesOf(a);
  assert.ok(faded.every((mesh) => mesh.visibility === 0.16 && mesh.isVisible === false && !full.includes(mesh)), 'a hidden faded template');
  assert.ok(instancesOf(a).every((mesh) => mesh.visibility === 0.16 && mesh.isVisible && onLayer(mesh, SHIP_LAYER) && onLayer(mesh.sourceMesh, SHIP_LAYER)));
  assert.ok(sameItems(templatesOf(b), full), 'the other ships keep theirs');
  assert.equal(a.parent, darts.a, 'the same root under the same dart');
  assert.deepEqual([a.children.length, a.children[0].scaling.x, a.children[0].rotation.y], [1, 0.2, Math.PI], 'the hull correction');
  assert.deepEqual([hullId(a), assets.triangles(scene)], ['small', triangles], 'the same hull, and the budget unchanged');
  const instances = instancesOf(a);
  assert.equal(assets.ships.fade(scene, 'a', 0.16), true);
  assert.ok(sameItems(instancesOf(a), instances), 'already faded: nothing is rebuilt');

  assert.equal(assets.ships.fade(scene, 'd', 0.16), true);
  assert.ok(sameItems(templatesOf(drone), faded), 'one faded template for the provider');
  assert.deepEqual([drone.parent.scaling.x, drone.scaling.x, drone.children[0].scaling.x], [0.6, 1, 0.2], 'the drone keeps its scale');
  assert.equal(assets.ships.fade(scene, 'b', 0), true);
  assert.ok(templatesOf(b).every((mesh) => mesh.visibility === 0), 'the followed ship, hidden from inside');

  for (const id of ['a', 'b', 'd']) assert.equal(assets.ships.fade(scene, id, 1), true);
  for (const root of [a, b, drone]) assert.ok(sameItems(templatesOf(root), full), 'every ship restored to the full template');
  assert.ok(instances.every((mesh) => mesh.disposed), 'the faded instances are gone');
  assert.equal(assets.triangles(scene), triangles);
  assert.equal(assets.ships.fade(scene, 'unknown', 0.16), false, 'no hull to fade');
  a.dispose();
  assert.equal(assets.ships.fade(scene, 'a', 0.16), false, 'nor once it is gone');
});

test('refresh promotes a ship focus mode has faded and keeps it faded, and only applies the latest request', async () => {
  const assets = loadShipAssets(LADDER_MANIFEST, {});
  const scene = assets.scene('system');
  const root = await assets.ships.upgrade(scene, ship('a', 0), assets.fallback('a'));
  const on = (template) => templatesOf(root).every((mesh) => mesh.name.startsWith('ship_template_' + template + '_'));
  assets.ships.fade(scene, 'a', 0.16);
  assert.equal(await assets.ships.refresh(scene, ship('a', 10)), root, 'promoted while faded');
  assert.equal(hullId(root), 'big');
  assert.ok(on('big-near.glb|claude|0.16'), 'on the faded template of its new hull');
  assets.ships.fade(scene, 'a', 0);
  assert.equal(await assets.ships.refresh(scene, ship('a', 10, { local: true })), root, 're-tinted while hidden from inside');
  assert.ok(on('big-near.glb|local|0'), 'still hidden, in its new colors');
  assets.ships.fade(scene, 'a', 1);
  assert.ok(on('big-near.glb|local|1'), 'and back in full once focus ends');
  assert.equal(await assets.ships.refresh(scene, ship('a', 0)), root);
  const stale = assets.ships.refresh(scene, ship('a', 3));
  const latest = assets.ships.refresh(scene, ship('a', 10));
  assert.equal(await stale, null, 'superseded by a later rank');
  assert.equal(await latest, root);
  assert.equal(hullId(root), 'big');
  const rewound = assets.ships.refresh(scene, ship('a', 3));
  assert.equal(await assets.ships.refresh(scene, ship('a', 10)), null, 'back to the current rank');
  assert.equal(await rewound, null, 'the pending swap is cancelled');
  assert.equal(hullId(root), 'big');
});

test('the triangle budget steps near hulls down to far before falling back to the dart', async () => {
  const assets = loadShipAssets(LADDER_MANIFEST, {
    'small-near.glb': 360000, 'small-far.glb': 135000, 'mid-near.glb': 540000, 'mid-far.glb': 180000, // a 900k budget
  });
  const scene = assets.scene('system');
  const lods = [];
  const roots = [];
  for (const id of ['a', 'b', 'c', 'd']) {
    const root = await assets.ships.upgrade(scene, ship(id, 0), assets.fallback(id));
    roots.push(root);
    lods.push(root ? root.metadata.assetLod : 'dart');
  }
  assert.deepEqual(lods, ['near', 'near', 'far', 'dart']);
  assert.ok(partMaterial(roots[2], 'hull_primary').emissiveColor.r > 0, 'a far file stepped down to up close lights itself');
  roots[0].dispose();
  const freed = await assets.ships.upgrade(scene, ship('e', 0), assets.fallback('e'));
  assert.equal(freed.metadata.assetLod, 'near', 'a disposed hull returns its triangles');
  // 360k + 135k + 360k are in use: the 540k near hull of the next rank does not
  // fit, so the promoted ship takes that rank's far file.
  assert.equal(await assets.ships.refresh(scene, ship('b', 3)), roots[1]);
  assert.equal(hullId(roots[1]), 'mid');
  assert.equal(roots[1].metadata.assetLod, 'far');
});

test('ships that open together, waiting on one container, keep to the budget as ships that come one by one do', async () => {
  const assets = loadShipAssets(LADDER_MANIFEST, { 'small-near.glb': 300000, 'small-far.glb': 100000 }); // a 900k budget
  const scene = assets.scene('system');
  const roots = await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => assets.ships.upgrade(scene, ship(id, 0), assets.fallback(id))));
  assert.deepEqual(roots.map((root) => root ? root.metadata.assetLod : 'dart'), ['near', 'near', 'far', 'far', 'dart', 'dart'],
    '300k + 300k + 100k + 100k: the next file of either size reaches the 900k budget, which a hull must stay under');
  assert.equal(assets.triangles(scene), 800000);
});

test('a hull request whose dart is gone or that is superseded while it waits on the budget loads no further file', async () => {
  const assets = loadShipAssets(LADDER_MANIFEST, {
    'small-near.glb': 500000, 'small-far.glb': 100000, 'mid-near.glb': 500000, 'mid-far.glb': 100000, // a 900k budget
  });
  const scene = assets.scene('system');
  // Two ships wait on one container that only the first fits: the second would step down.
  let held = assets.hold();
  const dart = assets.fallback('b');
  const first = assets.ships.upgrade(scene, ship('a', 0), assets.fallback('a'));
  const second = assets.ships.upgrade(scene, ship('b', 0), dart);
  await held.waiting();
  dart.dispose(); // the ship leaves while its hull loads
  held.release();
  assert.ok(await first);
  assert.equal(await second, null);
  assert.deepEqual(assets.loads.splice(0), ['small-near.glb'], 'no far file for a ship that is gone');
  const stepped = await assets.ships.upgrade(scene, ship('c', 0), assets.fallback('c'));
  assert.equal(stepped.metadata.assetLod, 'far', 'the file a ship still waiting steps down to');
  assets.loads.length = 0;

  // 600k in use: the next rank's near file does not fit in place of c's 100k, so c would step down.
  const promoted = assets.ships.refresh(scene, ship('c', 3));
  assert.equal(await assets.ships.refresh(scene, ship('c', 0)), null, 'back to its rank before the file arrives');
  assert.equal(await promoted, null);
  assert.deepEqual(assets.loads.splice(0), ['mid-near.glb'], 'no far file for a promotion that was taken back');
  assert.equal(await assets.ships.refresh(scene, ship('c', 3)), stepped);
  assert.deepEqual(assets.loads.splice(0), ['mid-far.glb'], 'the file a promotion still wanted steps down to');

  // Nor is a file loaded for a ship that leaves before its hull's first file starts loading.
  const early = assets.fallback('f');
  const gone = assets.ships.upgrade(scene, ship('f', 10), early);
  early.dispose();
  assert.equal(await gone, null);
  assert.deepEqual(assets.loads, [], 'no file for a ship gone before its first load');

  // Nor is a hull built for a ship that leaves while a file it fits loads.
  held = assets.hold();
  const left = assets.fallback('e');
  const leaving = assets.ships.upgrade(scene, ship('e', 10), left);
  await held.waiting();
  left.dispose();
  held.release();
  assert.equal(await leaving, null, 'no hull under a dart that is gone');
  assert.deepEqual(assets.loads, ['big-near.glb']);
  assert.equal(assets.triangles(scene), 600000, 'its triangles never taken');
});

// The counts the budget comment and kit/SPEC.md state, at the size Petrel was imported at.
test('a near view holds fifty-one ships of the first rank and the universe map, with a budget of its own, seventy', async () => {
  const petrel = JSON.parse(fs.readFileSync(path.join(RENDERER, 'ships', 'petrel', 'source', 'source.json'), 'utf8'));
  const { triangles } = petrel.geometry;
  const assets = loadShipAssets(LADDER_MANIFEST, { 'small-near.glb': triangles, 'small-far.glb': triangles });
  const hulled = async (view) => {
    const scene = assets.scene(view);
    let count = 0;
    for (let n = 0; n < 80; n++) count += (await assets.ships.upgrade(scene, ship('s' + n, 0), assets.fallback(view + n))) ? 1 : 0;
    return count;
  };
  assert.equal(await hulled('system'), 51);
  assert.equal(await hulled('universe'), 70);
});

'use strict';

// AUR.ships (src/renderer/ship-assets-api.js): a hull refreshed in place on promotion, and the
// triangle budget. Focus mode's fade is test/ship-assets-api-fade.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readRenderer } = require('./support/renderer-source');
const {
  loadShipAssets, LADDER_MANIFEST, ship, hullId, partMaterial, templatesOf, shows, hidden,
} = require('./support/ship-assets');

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

test('refresh promotes a ship focus mode shows apart or fades and lands it in the same state, and only applies the latest request', async () => {
  const assets = loadShipAssets(LADDER_MANIFEST, {});
  const scene = assets.scene('system');
  const root = await assets.ships.upgrade(scene, ship('a', 0), assets.fallback('a'));
  const other = await assets.ships.upgrade(scene, ship('b', 0), assets.fallback('b'));
  const on = (node, template) => templatesOf(node).every((mesh) => mesh.name.startsWith('ship_template_' + template + '_'));
  assets.ships.fade(scene, 0.16, { shipId: 'a', visibility: 1 });
  const own = templatesOf(root);
  assert.equal(await assets.ships.refresh(scene, ship('a', 10)), root, 'promoted while followed');
  assert.equal(hullId(root), 'big');
  assert.ok(on(root, 'big-near.glb|claude|a') && shows(root, 1), 'on a template of its own of its new hull, in full');
  assert.ok(own.every((mesh) => mesh.disposed), 'the old one gone');
  assert.equal(await assets.ships.refresh(scene, ship('b', 3)), other, 'promoted while faded');
  assert.ok(on(other, 'mid-near.glb|claude') && shows(other, 0.16), 'on the fleet template of its new hull');
  assets.ships.fade(scene, 0.16, { shipId: 'a', visibility: 0 });
  assert.equal(await assets.ships.refresh(scene, ship('a', 10, { local: true })), root, 're-tinted while hidden from inside');
  assert.ok(on(root, 'big-near.glb|local') && hidden(root), 'still hidden, in its new colors');
  assets.ships.fade(scene, 1);
  assert.ok(on(root, 'big-near.glb|local') && shows(root, 1) && shows(other, 1), 'and back in full once focus ends');
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
  roots[1].dispose();
  assert.equal(assets.triangles(scene), 360000 + 135000, 'a promoted ship gives back the triangles of the hull it flies');
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
  const petrel = JSON.parse(readRenderer('ships/petrel/source/source.json'));
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

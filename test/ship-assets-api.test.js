'use strict';

// AUR.ships (src/renderer/ship-assets-api.js): a hull refreshed in place on promotion, the triangle
// budget, and a scene's hull state disposed. Focus mode's fade is test/ship-assets-api-fade.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readRenderer } = require('./support/renderer-source');
const {
  loadShipAssets, LADDER_MANIFEST, ship, hullId, partMaterial, templatesOf, shows, hidden, logsOf,
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

test('a refresh that a later one ends while its file loads stays ended, and the latest request alone builds', async () => {
  const assets = loadShipAssets(LADDER_MANIFEST, {});
  // A ship of the first rank, in a scene of its own, asks for these ranks in turn while the files load.
  const requests = async (ranks) => {
    const scene = assets.scene('system');
    const root = await assets.ships.upgrade(scene, ship('a', 0), assets.fallback('a'));
    assets.built();
    const held = assets.hold();
    const asked = ranks.map((builds) => assets.ships.refresh(scene, ship('a', builds)));
    await held.waiting();
    held.release();
    const results = (await Promise.all(asked)).map((result) => (result === root ? 'root' : result));
    return { results, built: assets.built(), hull: hullId(root) };
  };
  const once = { results: [null, null, 'root'], built: ['a'], hull: 'mid' };
  assert.deepEqual(await requests([3, 10, 3]), once, 'asked again after another rank');
  assert.deepEqual(await requests([3, 0, 3]), once, 'asked again after the rank it has');
  assert.deepEqual(await requests([3, 3, 3]), once, 'asked again for the look already loading');
});

test('a hull that cannot be installed leaves its dart as it was, a swap that cannot be labelled is still a swap, and a request that throws logs its cause', async () => {
  const assets = loadShipAssets(LADDER_MANIFEST, {});
  const logs = logsOf(assets);
  const scene = assets.scene('system');
  const books = () => { const { ships, triangles } = assets.AUR.shipAssets.sceneStates.get(scene); return [ships.size, triangles]; };
  // A dart whose metadata cannot be written: upgrade writes it once the hull is built, a swap last.
  const held = { isShip: true };
  const unwritable = (dart, cause = 'no metadata') => Object.defineProperty(dart, 'metadata', { get: () => held, set() { throw new Error(cause); } });
  for (const id of ['a', 'b']) {
    const dart = Object.assign(unwritable(assets.fallback(id)), { isVisible: true, isPickable: false });
    assert.equal(await assets.ships.upgrade(scene, ship(id, 0), dart), null, 'upgrade ' + id);
    assert.deepEqual([dart.children.length, dart.isVisible, dart.isPickable, ...books()], [0, true, false, 0, 0],
      'a hull that cannot be installed is gone, uncounted, and its dart flies as it did');
  }
  // The ship focus mode follows, whose own template cannot be disposed either: the dart still
  // flies, the books hold only the ship already on them, and the cause reported is the install's.
  await assets.ships.upgrade(scene, ship('g', 0), assets.fallback('g'));
  assets.ships.fade(scene, 0.16, { shipId: 'e', visibility: 1 });
  const { Mesh } = assets.BABYLON;
  const { dispose } = Mesh.prototype;
  Mesh.prototype.dispose = function () {
    if (/^ship_template_.*\|e_/.test(this.name)) throw new Error('no template dispose');
    dispose.call(this);
  };
  const followed = Object.assign(unwritable(assets.fallback('e'), 'no metadata on e'), { isVisible: true, isPickable: true });
  assert.equal(await assets.ships.upgrade(scene, ship('e', 0), followed), null);
  assert.deepEqual([followed.children.length, followed.isVisible, followed.isPickable, ...books()], [0, true, true, 1, 1000]);
  // And one whose root cannot be disposed: hidden under a dart that flies, and off the books.
  Mesh.prototype.dispose = function () {
    if (this.name === 'ship_asset_f') throw new Error('no dispose');
    dispose.call(this);
  };
  const stuck = Object.assign(unwritable(assets.fallback('f'), 'no metadata on f'), { isVisible: true, isPickable: true });
  assert.equal(await assets.ships.upgrade(scene, ship('f', 0), stuck), null);
  assert.deepEqual([stuck.isVisible, stuck.isPickable, stuck.children[0].isEnabled(), ...books()], [true, true, false, 1, 1000]);
  assert.equal(stuck.children[0].metadata.isShip, undefined, 'a hull that is not installed is not marked a ship');
  Mesh.prototype.dispose = dispose;
  assets.ships.fade(scene, 1);
  // A hull that cannot be marked, the install's last step: the dart's metadata is put back too.
  const { markShipMesh } = assets.AUR;
  assets.AUR.markShipMesh = () => { throw new Error('no mark'); };
  const unmarked = assets.fallback('h');
  const { metadata } = unmarked;
  assert.equal(await assets.ships.upgrade(scene, ship('h', 0), unmarked), null);
  assert.deepEqual([unmarked.metadata, unmarked.children.length, ...books()], [metadata, 0, 1, 1000]);
  assets.AUR.markShipMesh = markShipMesh;

  const darts = [assets.fallback('c'), assets.fallback('d')];
  const roots = [await assets.ships.upgrade(scene, ship('c', 0), darts[0]), await assets.ships.upgrade(scene, ship('d', 0), darts[1])];
  darts.forEach((dart) => unwritable(dart));
  for (const [i, id] of ['c', 'd'].entries()) assert.equal(await assets.ships.refresh(scene, ship(id, 3)), roots[i], 'refresh ' + id);
  assert.ok(roots.every((root) => root.children.length === 1 && hullId(root) === 'mid'), 'the ship flies the new hull, whole');
  // A throw from the request itself, once it has started: asked a second time whether it is live.
  const { isNodeDisposed } = assets.AUR;
  let asked = 0;
  assets.AUR.isNodeDisposed = (node) => {
    if (node === roots[0] && ++asked > 1) throw new Error('no node');
    return isNodeDisposed(node);
  };
  assert.equal(await assets.ships.refresh(scene, ship('c', 10)), null);
  assets.AUR.isNodeDisposed = isNodeDisposed;
  assert.equal(hullId(roots[0]), 'mid', 'and the ship keeps the hull it had');
  assert.deepEqual(logs, [
    'Hull small request failed (no metadata).',
    'Hull small request failed (no metadata on e).',
    "Hull small's own template could not be disposed (no template dispose).",
    'Hull small request failed (no metadata on f).',
    'Uninstalled hull small could not be disposed (no dispose).',
    'Hull small request failed (no mark).',
    'Hull mid could not be named on its dart (no metadata).',
    'Hull big request failed (no node).',
  ]);
});

test('a dart that cannot be read builds no hull, and one that cannot be shown again still lets its hull go', async () => {
  const assets = loadShipAssets(LADDER_MANIFEST, {});
  const logs = logsOf(assets);
  const scene = assets.scene('system');
  const books = () => { const { ships, triangles } = assets.AUR.shipAssets.sceneStates.get(scene); return [ships.size, triangles]; };
  const unread = Object.defineProperty(assets.fallback('a'), 'isVisible', { get() { throw new Error('no isVisible'); } });
  assert.equal(await assets.ships.upgrade(scene, ship('a', 0), unread), null);
  assert.deepEqual([unread.children.length, ...books()], [0, 0, 0], 'nothing is built for it');
  // Its metadata cannot be written either, so the install fails and the dart is to be shown again.
  let visible = true;
  const unshown = Object.defineProperty(assets.fallback('b'), 'isVisible', {
    get: () => visible,
    set(value) { if (value) throw new Error('no show'); visible = value; },
  });
  const held = { isShip: true };
  Object.defineProperty(unshown, 'metadata', { get: () => held, set() { throw new Error('no metadata'); } });
  assert.equal(await assets.ships.upgrade(scene, ship('b', 0), unshown), null);
  assert.deepEqual([unshown.children.length, ...books()], [0, 0, 0], 'its hull is let go and off the books');
  // A hull that cannot be marked, under a dart that cannot be shown again and on a root that
  // cannot be disposed: the dart's metadata is still put back.
  const { AUR, BABYLON: { Mesh } } = assets;
  const { markShipMesh } = AUR;
  const { dispose } = Mesh.prototype;
  AUR.markShipMesh = () => { throw new Error('no mark'); };
  Mesh.prototype.dispose = function () {
    if (this.name === 'ship_asset_c') throw new Error('no dispose');
    dispose.call(this);
  };
  let shown = true;
  const dim = Object.defineProperty(assets.fallback('c'), 'isVisible', {
    get: () => shown,
    set(value) { if (value) throw new Error('no show on c'); shown = value; },
  });
  const { metadata } = dim;
  assert.equal(await assets.ships.upgrade(scene, ship('c', 0), dim), null);
  assert.deepEqual([dim.metadata, ...books()], [metadata, 0, 0]);
  Object.assign(AUR, { markShipMesh });
  Mesh.prototype.dispose = dispose;
  assert.deepEqual(logs, [
    'Hull small request failed (no isVisible).',
    'Hull small request failed (no metadata).',
    'Uninstalled hull small could not restore its dart (no show).',
    'Hull small request failed (no mark).',
    'Uninstalled hull small could not restore its dart (no show on c).',
    'Uninstalled hull small could not be disposed (no dispose).',
  ]);
});

test('a replaced hull that cannot be disposed leaves its ship one hull, counted, whether a promotion or focus mode replaces it', async () => {
  const assets = loadShipAssets(LADDER_MANIFEST, { 'small-near.glb': 1000, 'mid-near.glb': 2000 });
  const logs = logsOf(assets);
  const scene = assets.scene('system');
  const root = await assets.ships.upgrade(scene, ship('a', 0), assets.fallback('a'));
  const old = root.children[0];
  old.dispose = () => { throw new Error('no dispose'); };
  assert.equal(await assets.ships.refresh(scene, ship('a', 3)), root, 'promoted');
  assert.deepEqual([root.children.length, hullId(root), assets.triangles(scene)], [1, 'mid', 2000]);
  assert.ok(old.parent === null && !old.isEnabled(), 'the old hull off the ship, and drawn by nothing');

  assets.ships.fade(scene, 0.16, { shipId: 'a', visibility: 1 });
  const own = templatesOf(root);
  own[0].parent.dispose = () => { throw new Error('no template dispose'); };
  assets.ships.fade(scene, 1); // back onto the fleet template
  assert.deepEqual([root.children.length, assets.triangles(scene)], [1, 2000]);
  assert.ok(shows(root, 1) && !templatesOf(root).some((mesh) => own.includes(mesh)), 'on the fleet template, in full');

  // A new hull the root cannot take is let go, and the ship keeps the one it has.
  root.children.push = () => { throw new Error('no room'); };
  assert.equal(await assets.ships.refresh(scene, ship('a', 10)), null, 'not promoted');
  assert.deepEqual([root.children.length, hullId(root), assets.triangles(scene)], [1, 'mid', 2000]);
  assert.ok(assets.templates().filter((part) => part.name.includes('big')).every((part) => part.instances.length === 0), 'no instance of it stays');
  // An old hull that cannot be taken off its ship is hidden first, so the ship draws one hull.
  const stuck = root.children[0];
  Object.defineProperty(stuck, 'parent', { get() { return this.parentNode; }, set() { throw new Error('no detach'); } });
  assert.equal(await assets.ships.refresh(scene, ship('a', 10)), root, 'promoted');
  assert.ok(hullId(root) === 'big' && !stuck.isEnabled(), 'the new hull in place, the old one drawn by nothing');
  assert.deepEqual(logs, [
    'Replaced hull small could not be disposed (no dispose).',
    "Replaced hull mid's own template could not be disposed (no template dispose).",
    'Hull big could not be built (no room); the ship keeps the hull or dart it has.',
    'Replaced hull mid could not be taken off its ship (no detach).',
    'Replaced hull mid could not be disposed (no detach).',
  ]);
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

test('disposing a scene\'s hull state empties it, though a load still waiting holds on to it', async () => {
  const assets = loadShipAssets(LADDER_MANIFEST, {});
  const scene = assets.scene('system');
  await assets.ships.upgrade(scene, ship('a', 0), assets.fallback('a'));
  assets.ships.fade(scene, 0.16, { shipId: 'a', visibility: 1 }); // a template of its own too
  const held = assets.hold();
  const waiting = assets.ships.upgrade(scene, ship('b', 10), assets.fallback('b'));
  await held.waiting();
  const state = assets.AUR.shipAssets.sceneStates.get(scene);
  assets.ships.dispose(scene);
  held.release();
  assert.equal(await waiting, null);
  assert.deepEqual([state.containers.size, state.materials.size, state.templates.size, state.ships.size], [0, 0, 0, 0]);
});

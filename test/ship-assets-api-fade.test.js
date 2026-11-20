'use strict';

// AUR.ships.fade (src/renderer/ship-assets-api.js): focus mode fades the fleet on its templates and
// shows the ship it follows apart. Refresh, the triangle budget and dispose are
// test/ship-assets-api.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SHIP_LAYER, onLayer, loadShipAssets, LADDER_MANIFEST, ship, hullId, instancesOf, templatesOf, shows, hidden, sameItems,
} = require('./support/ship-assets');

test('focus mode fades the fleet on its templates and rebuilds only the followed ship, keeping its hull, scale and correction', async () => {
  const assets = loadShipAssets(LADDER_MANIFEST, {});
  const scene = assets.scene('system');
  const darts = { a: assets.fallback('a'), b: assets.fallback('b'), d: assets.fallback('d') };
  darts.d.scaling.setAll(0.6); // the view's drone scale lives on the dart root
  const a = await assets.ships.upgrade(scene, ship('a', 0), darts.a);
  const b = await assets.ships.upgrade(scene, ship('b', 0), darts.b);
  const drone = await assets.ships.upgrade(scene, ship('d', 40, { kind: 'drone' }), darts.d);
  const fleet = templatesOf(a);
  const triangles = assets.triangles(scene);
  assert.ok(sameItems(templatesOf(drone), fleet) && shows(a, 1), 'one template for the provider');
  assets.built();

  // From outside: the fleet fades where it stands, and the followed ship moves to a template of its own.
  assets.ships.fade(scene, 0.16, { shipId: 'a', visibility: 1 });
  assert.deepEqual(assets.built(), ['a'], 'only the followed ship is rebuilt');
  assert.ok(fleet.every((mesh) => mesh.visibility === 0.16) && sameItems(templatesOf(b), fleet) && sameItems(templatesOf(drone), fleet));
  const own = templatesOf(a);
  assert.ok(shows(a, 1) && own.every((mesh) => !fleet.includes(mesh) && !mesh.isVisible && !mesh.isPickable && onLayer(mesh, SHIP_LAYER)),
    'a hidden template of its own, in full, lit by the fleet lights');
  assert.equal(a.parent, darts.a, 'the same root under the same dart');
  assert.deepEqual([a.children.length, a.children[0].scaling.x, a.children[0].rotation.y], [1, 0.2, Math.PI], 'the hull correction');
  assert.deepEqual([hullId(a), assets.triangles(scene)], ['small', triangles], 'the same hull, and the budget unchanged');
  assert.deepEqual([drone.parent.scaling.x, drone.scaling.x, drone.children[0].scaling.x], [0.6, 1, 0.2], 'the drone keeps its scale');
  const instances = instancesOf(a);
  assets.ships.fade(scene, 0.16, { shipId: 'a', visibility: 1 });
  assert.ok(assets.built().length === 0 && sameItems(instancesOf(a), instances), 'the same fade again rebuilds nothing');
  assets.ships.fade(scene, 0.16, { shipId: 'a', visibility: 0.5 });
  assert.ok(assets.built().length === 0 && shows(a, 0.5) && shows(b, 0.16), 'another visibility apart is written on its template');
  assets.ships.fade(scene, 0.16, { shipId: 'a', visibility: 1 });

  // Inside it and out again: hidden where it stands, then shown on the template it kept.
  assets.ships.fade(scene, 0.16, { shipId: 'a', visibility: 0 });
  assert.ok(assets.built().length === 0 && hidden(a) && shows(b, 0.16), 'hidden from inside, without a rebuild');
  assert.ok(assets.templates().every((mesh) => mesh.visibility !== 0), 'and no template at visibility 0');
  assets.ships.fade(scene, 0.16, { shipId: 'a', visibility: 1 });
  assert.ok(assets.built().length === 0 && sameItems(instancesOf(a), instances) && shows(a, 1), 'outside again, on its own template');

  // Following another: the first ship back on the fleet's template, the next one on its own.
  assets.ships.fade(scene, 1);
  assets.ships.fade(scene, 0.16, { shipId: 'b', visibility: 1 });
  assert.deepEqual(assets.built(), ['a', 'b']);
  assert.ok(own.every((mesh) => mesh.disposed) && instances.every((mesh) => mesh.disposed), 'its own template went with its old hull');
  assert.ok(sameItems(templatesOf(a), fleet) && shows(a, 0.16) && shows(b, 1) && shows(drone, 0.16));

  const bOwn = templatesOf(b);
  assets.ships.fade(scene, 1);
  assert.deepEqual(assets.built(), ['b'], 'leaving rebuilds the followed ship alone');
  for (const root of [a, b, drone]) assert.ok(sameItems(templatesOf(root), fleet) && shows(root, 1), 'every ship back on the fleet template');
  assert.ok(bOwn.every((mesh) => mesh.disposed) && assets.templates().length === fleet.length, 'no template is left but the fleet\'s');
  assert.equal(assets.triangles(scene), triangles);

  assets.ships.fade(scene, 0.16, { shipId: 'a', visibility: 0 });
  assets.ships.fade(scene, 1);
  assert.ok(assets.built().length === 0 && shows(a, 1), 'focus from inside, and leaving it, rebuild nothing');

  // A focus that begins inside builds no template of its own: the first time out builds it.
  assets.ships.fade(scene, 0.16, { shipId: 'a', visibility: 0 });
  assets.ships.fade(scene, 0.16, { shipId: 'a', visibility: 1 });
  assert.deepEqual(assets.built(), ['a'], 'out for the first time');
  assets.ships.fade(scene, 0.16, { shipId: 'a', visibility: 0 });
  assets.ships.fade(scene, 0.16, { shipId: 'a', visibility: 1 });
  assert.ok(assets.built().length === 0 && shows(a, 1), 'and in and out again rebuild nothing');
});

test('a hull built while focus mode fades the fleet is built faded, the followed ship apart, and a ship that leaves takes its template', async () => {
  const assets = loadShipAssets(LADDER_MANIFEST, {});
  const scene = assets.scene('system');
  // A system opened into focus: the fade comes before the hulls.
  assets.ships.fade(scene, 0.16, { shipId: 'f', visibility: 1 });
  const [f, g] = [await assets.ships.upgrade(scene, ship('f', 0), assets.fallback('f')), await assets.ships.upgrade(scene, ship('g', 0), assets.fallback('g'))];
  assert.deepEqual(assets.built(), ['f', 'g'], 'each built once');
  assert.ok(shows(f, 1) && shows(g, 0.16) && !templatesOf(f).some((mesh) => templatesOf(g).includes(mesh)));

  const fOwn = templatesOf(f);
  assets.ships.fade(scene, 0.16, { shipId: 'h', visibility: 0 });
  const h = await assets.ships.upgrade(scene, ship('h', 0), assets.fallback('h'));
  assert.ok(hidden(h) && sameItems(templatesOf(h), templatesOf(g)), 'the ship the viewer is inside of arrives hidden, on the fleet template');
  assert.ok(fOwn.every((mesh) => mesh.disposed) && sameItems(templatesOf(f), templatesOf(g)) && shows(f, 0.16),
    'and the ship followed before is back with the fleet');

  assets.ships.fade(scene, 0.16, { shipId: 'g', visibility: 1 });
  const own = templatesOf(g);
  const triangles = assets.triangles(scene);
  g.parent.dispose(); // the ship leaves, its dart and hull with it
  assert.ok(own.every((mesh) => mesh.disposed), 'its template of its own goes with it');
  assert.equal(assets.triangles(scene), triangles - 1000);
  assets.ships.fade(scene, 1);
  assert.deepEqual(assets.built(), ['f', 'h', 'g'], 'a ship that is gone is not rebuilt');
});

test('a followed ship whose hull cannot be instantiated keeps the hull it has, and leaves no template of its own behind', async () => {
  const assets = loadShipAssets(LADDER_MANIFEST, {});
  const scene = assets.scene('system');
  const a = await assets.ships.upgrade(scene, ship('a', 0), assets.fallback('a'));
  const { container } = assets.AUR.shipAssets.sceneStates.get(scene).containers.get('small-near.glb');
  const make = container.instantiateModelsToScene;
  container.instantiateModelsToScene = (...args) => {
    const made = make(...args);
    for (const root of made.rootNodes) root.instantiateHierarchy = () => { throw new Error('no instances'); };
    return made;
  };
  const templates = assets.templates();
  assets.ships.fade(scene, 0.16, { shipId: 'a', visibility: 1 });
  assert.ok(sameItems(assets.templates(), templates), 'the template made for it is gone');
  assert.ok(shows(a, 0.16) && a.children.length === 1, 'and it flies faded on the hull it had');
});

'use strict';

// The ship-assets core and hulls (src/renderer/ship-assets.js, ship-assets-hulls.js): the rank
// ladder, LODs, a template per provider, and what a failure logs. What a hull wears is
// test/ships-livery.test.js, AUR.ships' refresh and triangle budget test/ship-assets-api.test.js,
// its fade test/ship-assets-api-fade.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  SHIP_ASSET_FILES, SHIP_LAYER, instanceOnLayer, loadShipAssets, LADDER_MANIFEST, ship, hullId, partMaterial,
  instancesOf, templatesOf, sameItems, logsOf,
} = require('./support/ship-assets');

test('index.html loads every ship-assets file, the core first, and the livery before the hulls', () => {
  const onDisk = fs.readdirSync(path.join(__dirname, '..', 'src', 'renderer')).filter((file) => /^ship-assets.*\.js$/.test(file));
  assert.deepEqual(SHIP_ASSET_FILES, ['ship-assets.js', 'ships/livery.js', 'ship-assets-hulls.js', 'ship-assets-api.js']);
  assert.deepEqual([...onDisk, 'ships/livery.js'].sort(), [...SHIP_ASSET_FILES].sort());
});

test('shared hulls receive fixed provider palettes; a signal loads no model and a drone flies its family hull', async () => {
  const manifest = {
    schemaVersion: 1,
    providerFamilies: { claude: 'shared', codex: 'shared' },
    hulls: [{
      id: 'shared-small', file: 'shared-small.glb', family: 'shared', role: 'main-s',
      correction: { rotateY: 0, scale: 1, offset: [0, 0, 0] },
    }],
  };
  const assets = loadShipAssets(manifest, {}, ['accent_energy']);
  const scene = assets.scene(null);
  const claudeFallback = assets.fallback('claude-a');
  const codexFallback = assets.fallback('codex-a');
  const claude = await assets.ships.upgrade(scene, { id: 'claude-a', provider: 'claude', project: 'project-1' }, claudeFallback);
  const codex = await assets.ships.upgrade(scene, { id: 'codex-a', provider: 'codex', project: 'project-1' }, codexFallback);

  assert.deepEqual(assets.loads, ['shared-small.glb']);
  assert.equal(assets.materialClones(), 2, 'one livery per palette');
  assert.notEqual(claude.material, codex.material);
  assert.equal(claude.material.emissiveColor.toHexString(), '#d97757');
  assert.equal(codex.material.emissiveColor.toHexString(), '#f2f0ea');
  assert.equal(claude.metadata.providerTint, '#d97757');
  assert.equal(codex.metadata.providerTint, '#f2f0ea');
  assert.equal(claudeFallback.metadata.isShip, false);
  assert.equal(codexFallback.metadata.isShip, false);
  assert.ok([...templatesOf(claude), ...templatesOf(codex)].every((mesh) => mesh.isPickable === false));

  const signalFallback = assets.fallback('signal-a');
  const droneFallback = assets.fallback('drone-a');
  assert.equal(await assets.ships.upgrade(scene, { id: 'signal-a', provider: 'signal', project: 'project-1' }, signalFallback), null);
  const drone = await assets.ships.upgrade(scene, { id: 'drone-a', provider: 'codex', kind: 'drone', project: 'project-1' }, droneFallback);
  assert.deepEqual(assets.loads, ['shared-small.glb'], 'a signal requests no model; a drone shares its family container');
  assert.equal(signalFallback.metadata.isShip, true);
  assert.notEqual(drone, null, 'a drone flies its family hull');
  assert.equal(droneFallback.metadata.isShip, false);
});

// ---------- rank ladder, LODs and templates ----------

test('main ships take the highest rank their build count has reached', async () => {
  const assets = loadShipAssets(LADDER_MANIFEST, {});
  const scene = assets.scene('system');
  const ranks = [];
  for (const builds of [0, 2, 3, 9, 10, 500, undefined]) {
    ranks.push(hullId(await assets.ships.upgrade(scene, ship('s' + builds, builds), assets.fallback('s' + builds))));
  }
  assert.deepEqual(ranks, ['small', 'small', 'mid', 'mid', 'big', 'big', 'small']);
  assert.equal(hullId(await assets.ships.upgrade(scene, ship('d', 50, { kind: 'drone' }), assets.fallback('d'))), 'small', 'a drone flies the first rank at any build count');
  assert.ok(!assets.loads.some((file) => file.startsWith('escort')), 'the reserved escort is never a rank');
});

// The model here is a stand-in and so are its container and materials (the real ones need the
// real Babylon build: test/ships-models.test.js); this covers what ship-assets does with a model.
test('a rank a ship model has taken flies the model, built in code, until the ship is promoted past it', async () => {
  const assets = loadShipAssets(LADDER_MANIFEST, {});
  const built = [];
  Object.assign(assets.models, {
    container(_scene, model) { built.push(model.id); return assets.containerFor('model:' + model.id); },
    material: (_materials, model, palette, hex, base) => ({ worn: [model.id, palette, hex, base.name].join(' ') }),
  });
  assets.models.register({ id: 'coded', replaces: 'small', correction: { scale: 0.1, offset: [0, 0, -1] }, trim: {} });

  const system = assets.scene('system');
  const root = await assets.ships.upgrade(system, ship('a', 0), assets.fallback('a'));
  const drone = await assets.ships.upgrade(system, ship('d', 40, { kind: 'drone', provider: 'codex' }), assets.fallback('d'));
  assert.deepEqual([hullId(root), hullId(drone)], ['coded', 'coded']);
  assert.deepEqual([built, assets.loads], [['coded'], []], 'one built container for the scene, and no hull file');
  assert.deepEqual([root.children[0].rotation.y, root.children[0].scaling.x, root.children[0].children[0].position.z], [0, 0.1, -1]);
  // In a near view too a ship is instances of a template per palette, wearing what the model gives
  // that palette; the template carries the model lights' layer, since an instance is lit as its source.
  assert.deepEqual(instancesOf(root).map((mesh) => mesh.material.worn), ['coded claude #d97757 hull_primary', 'coded claude #d97757 accent_energy']);
  assert.deepEqual(instancesOf(drone).map((mesh) => mesh.material.worn), ['coded codex #f2f0ea hull_primary', 'coded codex #f2f0ea accent_energy']);
  for (const mesh of [...instancesOf(root), ...instancesOf(drone)]) {
    assert.ok(mesh.isVisible && !mesh.sourceMesh.isVisible, 'an instance of a hidden template');
    assert.ok(instanceOnLayer(mesh, assets.models.LAYER), 'seen by the camera, lit by the model lights only');
  }
  const twin = await assets.ships.upgrade(system, ship('twin', 0), assets.fallback('twin'));
  assert.ok(sameItems(templatesOf(twin), templatesOf(root)), 'one template per palette');

  assert.equal(await assets.ships.refresh(system, ship('a', 3)), root, 'promoted in place');
  assert.equal(hullId(root), 'mid');
  assert.deepEqual(assets.loads, ['mid-near.glb']);
  assert.ok(instancesOf(root).every((mesh) => instanceOnLayer(mesh, SHIP_LAYER) && !mesh.material.worn),
    'a manifest hull wears the fleet livery and is lit by the fleet lights, not the model ones');

  const universe = assets.scene('universe');
  const far = [];
  for (const id of ['x', 'y']) far.push(await assets.ships.upgrade(universe, ship(id, 0), assets.fallback(id)));
  assert.deepEqual(built, ['coded', 'coded'], 'one built container per scene');
  assert.ok(far.every((root) => instancesOf(root).every((mesh) => mesh.isVisible && instanceOnLayer(mesh, assets.models.LAYER))));
  assert.ok(sameItems(templatesOf(far[0]), templatesOf(far[1])), 'on the map the ships of a palette are instances of one template');
});

test('a model container queued for a scene that is gone before the build runs is never built', async () => {
  const assets = loadShipAssets(LADDER_MANIFEST, {});
  const built = [];
  assets.models.container = (_scene, model) => { built.push(model.id); return assets.containerFor('model:' + model.id); };
  assets.models.register({ id: 'coded', replaces: 'small', correction: { scale: 0.1, offset: [0, 0, 0] }, trim: {} });
  await assets.AUR.shipAssets.manifestPromise;
  const ends = { 'its hull state disposed': (scene) => assets.ships.dispose(scene), 'Babylon disposed': (scene) => { scene.isDisposed = () => true; } };
  for (const [how, end] of Object.entries(ends)) {
    const scene = assets.scene('system');
    assert.equal(assets.ships.instantiate(scene, ship('a', 0)), null, 'the first sight of a container queues its build');
    const { promise } = assets.AUR.shipAssets.sceneStates.get(scene).containers.get('model:coded');
    end(scene);
    assert.equal(await promise, null, how);
    assert.deepEqual(built, [], how);
  }
});

test('every view instances its hulls from one template per provider: far hulls on the map, near ones in a system', async () => {
  const assets = loadShipAssets(LADDER_MANIFEST, {});
  const universe = assets.scene('universe');
  const first = await assets.ships.upgrade(universe, ship('a', 0), assets.fallback('a'));
  const second = await assets.ships.upgrade(universe, ship('b', 0), assets.fallback('b'));
  const codex = await assets.ships.upgrade(universe, ship('c', 0, { provider: 'codex' }), assets.fallback('c'));
  assert.deepEqual(assets.loads, ['small-far.glb']);
  // Every part of a hull that has a material is an instance: nothing is drawn as a copy of its own.
  const parts = (root) => root.getChildMeshes(false).filter((mesh) => mesh.material);
  for (const root of [first, second, codex]) {
    assert.equal(parts(root).length, 2);
    assert.ok(sameItems(parts(root), instancesOf(root)) && parts(root).every((mesh) => mesh.isVisible && !mesh.isPickable));
    const tagged = root.getChildMeshes(false).filter((mesh) => mesh.metadata && mesh.metadata.assetHullId === 'small');
    assert.ok(sameItems(tagged, parts(root)), 'each part, and only a part, carries its hull id');
    assert.ok(templatesOf(root).every((mesh) => mesh.isVisible === false), 'templates stay hidden');
    assert.equal(root.metadata.assetLod, 'far');
  }
  assert.ok(sameItems(templatesOf(first), templatesOf(second)), 'one template per provider');
  assert.ok(!templatesOf(codex).some((mesh) => templatesOf(first).includes(mesh)));
  assert.equal(first.material.emissiveColor.toHexString(), '#d97757');
  assert.equal(codex.material.emissiveColor.toHexString(), '#f2f0ea');
  assert.ok(partMaterial(first, 'hull_primary').emissiveColor.r > 0, 'far hulls carry a faint self-light on the unlit map');

  const system = assets.scene('system');
  const near = await assets.ships.upgrade(system, ship('a', 0), assets.fallback('a'));
  const nearTwin = await assets.ships.upgrade(system, ship('b', 0), assets.fallback('b'));
  assert.equal(assets.loads.at(-1), 'small-near.glb');
  assert.ok(sameItems(parts(near), instancesOf(near)) && templatesOf(near).every((mesh) => mesh.isVisible === false));
  assert.ok(sameItems(templatesOf(nearTwin), templatesOf(near)), 'one template per provider');
  assert.ok(instancesOf(near).every((mesh) => instanceOnLayer(mesh, SHIP_LAYER)),
    'the template carries the fleet light layer, and both keep the camera\'s');
  assert.equal(partMaterial(near, 'hull_primary').emissiveColor.toHexString(), '#000000', 'a near hull is lit, not self-lit');
});

// The fleet's upper ranks have one file for every view, so the map's view alone lights them.
test('a hull without levels of detail lights itself on the lightless map, and not in a lit view', async () => {
  const manifest = {
    schemaVersion: 1,
    providerFamilies: { claude: 'one' },
    hulls: [{ id: 'one', file: 'one.glb', family: 'one', role: 'main', minBuilds: 0 }],
  };
  const assets = loadShipAssets(manifest, {});
  const map = await assets.ships.upgrade(assets.scene('universe'), ship('a', 0), assets.fallback('a'));
  const system = await assets.ships.upgrade(assets.scene('system'), ship('a', 0), assets.fallback('a'));
  assert.deepEqual([map.metadata.assetLod, system.metadata.assetLod, assets.loads], [null, null, ['one.glb', 'one.glb']]);
  assert.ok(partMaterial(map, 'hull_primary').emissiveColor.r > 0, 'self-lit on the map');
  assert.equal(partMaterial(system, 'hull_primary').emissiveColor.toHexString(), '#000000', 'lit by the system view');
});

test('a scene that has not declared its view loads nothing until upgrade, which defaults to far', async () => {
  const assets = loadShipAssets(LADDER_MANIFEST, {});
  const scene = assets.scene(null);
  await assets.ships.upgrade(scene, ship('warm', 0), assets.fallback('warm')); // settles the manifest
  assets.loads.length = 0;
  assert.equal(assets.ships.instantiate(scene, ship('a', 0)), null);
  assert.deepEqual(assets.loads, [], 'instantiate starts no load before the view is known');
  const root = await assets.ships.upgrade(scene, ship('a', 0), assets.fallback('a'));
  assert.equal(root.metadata.assetLod, 'far');
  scene.metadata = { view: 'planet' };
  assert.equal(assets.ships.instantiate(scene, ship('b', 0)), null, 'first sight of a file only starts its load');
  await new Promise((resolve) => setImmediate(resolve));
  const ready = assets.ships.instantiate(scene, ship('c', 0));
  assert.equal(ready.metadata.assetLod, 'near');
});

// ---------- what a failure logs: its cause, once per failure and cause, and what the ship keeps ----------

test('a hull that cannot be built logs its cause once per hull and cause, for a new ship or a fade', async () => {
  const assets = loadShipAssets(LADDER_MANIFEST, {});
  const logs = logsOf(assets);
  const scene = assets.scene('system');
  const a = await assets.ships.upgrade(scene, ship('a', 0), assets.fallback('a'));
  const { containers, templates } = assets.AUR.shipAssets.sceneStates.get(scene);
  let cause = 'no instances';
  const throwing = () => { throw new Error(cause); };
  for (const template of templates.values()) for (const root of template.roots) root.instantiateHierarchy = throwing;
  const { container } = containers.get('small-near.glb');
  const make = container.instantiateModelsToScene; // and every template made from now on
  container.instantiateModelsToScene = (...args) => {
    const made = make(...args);
    for (const root of made.rootNodes) root.instantiateHierarchy = throwing;
    return made;
  };
  for (const id of ['b', 'c']) assert.equal(await assets.ships.upgrade(scene, ship(id, 0), assets.fallback(id)), null, id + ' keeps its dart');
  assets.ships.fade(scene, 0.16, { shipId: 'a', visibility: 1 });
  assert.equal(a.children.length, 1, 'the followed ship keeps its hull');
  cause = 'out of memory';
  assert.equal(await assets.ships.upgrade(scene, ship('d', 0), assets.fallback('d')), null);
  assert.deepEqual(logs, [
    'Hull small could not be built (no instances); the ship keeps the hull or dart it has.',
    'Hull small could not be built (out of memory); the ship keeps the hull or dart it has.',
  ]);
});

test('a hull that can be neither built nor disposed still ends its build: both causes are logged, the build first, and nothing is thrown', async () => {
  const assets = loadShipAssets(LADDER_MANIFEST, {});
  const logs = logsOf(assets);
  const scene = assets.scene('system');
  const a = await assets.ships.upgrade(scene, ship('a', 0), assets.fallback('a'));
  const { Mesh, TransformNode } = assets.BABYLON;
  const { dispose } = TransformNode.prototype;
  Mesh.prototype.instantiateHierarchy = () => { throw new Error('no instances'); };
  TransformNode.prototype.dispose = function () {
    if (this.name.startsWith('ship_correction_')) throw new Error('no dispose');
    dispose.call(this);
  };
  const fleet = assets.templateNodes().length;
  assert.equal(await assets.ships.upgrade(scene, ship('b', 0), assets.fallback('b')), null, 'a new ship keeps its dart');
  assets.ships.fade(scene, 0.16, { shipId: 'a', visibility: 1 }); // a rebuild onto a template of its own
  assert.equal(a.children.length, 1, 'the followed ship keeps its hull');
  assert.equal(assets.templateNodes().length, fleet, 'the template made for it goes though the hull before it could not');
  assert.deepEqual(logs, [
    'Hull small could not be built (no instances); the ship keeps the hull or dart it has.',
    'Unbuilt hull small could not be disposed (no dispose).',
  ]);
});

test('a built hull its ship cannot take is let go: no instance of it stays, and the ship keeps its dart', async () => {
  const assets = loadShipAssets(LADDER_MANIFEST, {});
  const logs = logsOf(assets);
  const scene = assets.scene('system');
  await assets.ships.upgrade(scene, ship('a', 0), assets.fallback('a'));
  const { Mesh } = assets.BABYLON;
  assets.BABYLON.Mesh = function () { throw new Error('no mesh'); }; // the root a new ship's hull hangs from
  assert.equal(await assets.ships.upgrade(scene, ship('b', 0), assets.fallback('b')), null);
  assets.BABYLON.Mesh = Mesh;
  assert.ok(assets.templates().every((part) => part.instances.length === 1), 'only the first ship draws');
  assert.equal(assets.triangles(scene), 1000);
  assert.deepEqual(logs, ['Hull small could not be built (no mesh); the ship keeps the hull or dart it has.']);
});

test('a failure is logged once per message: the same failure and cause again under another outcome is logged too', () => {
  const assets = loadShipAssets(LADDER_MANIFEST, {});
  const logs = logsOf(assets);
  const { logFailure } = assets.AUR.shipAssets;
  for (let i = 0; i < 2; i += 1) {
    logFailure('Hull small could not be built', new Error('no mesh'), 'the ship keeps the hull or dart it has.');
    logFailure('Hull small could not be built', new Error('no mesh'));
  }
  assert.deepEqual(logs, ['Hull small could not be built (no mesh); the ship keeps the hull or dart it has.', 'Hull small could not be built (no mesh).']);
});

test('a hull whose provider evidence cannot be made is not built, and leaves no instance behind', async () => {
  const assets = loadShipAssets(LADDER_MANIFEST, {});
  const logs = logsOf(assets);
  const { unlitMaterial } = assets.AUR;
  assets.AUR.unlitMaterial = () => { throw new Error('no unlit material'); };
  assert.equal(await assets.ships.upgrade(assets.scene('system'), ship('a', 0), assets.fallback('a')), null);
  assert.ok(assets.templates().length > 0 && assets.templates().every((part) => part.instances.length === 0), 'its instances went with it');
  assert.deepEqual(logs, ['Hull small could not be built (no unlit material); the ship keeps the hull or dart it has.']);
  assets.AUR.unlitMaterial = unlitMaterial;
  assert.ok(await assets.ships.upgrade(assets.scene('system'), ship('a', 0), assets.fallback('a')), 'and the next build works');
});

test('a hull file that cannot be loaded logs its cause once per file and cause, and a full budget says what ships keep', async () => {
  const assets = loadShipAssets(LADDER_MANIFEST, { 'mid-near.glb': 950000, 'mid-far.glb': 950000 }); // over a 900k budget
  const logs = logsOf(assets);
  const load = assets.BABYLON.SceneLoader.LoadAssetContainerAsync;
  for (const cause of ['file missing', 'file missing', 'not a glTF']) {
    assets.BABYLON.SceneLoader.LoadAssetContainerAsync = async () => { throw new Error(cause); };
    assert.equal(await assets.ships.upgrade(assets.scene('system'), ship('a', 0), assets.fallback('a')), null);
  }
  assets.BABYLON.SceneLoader.LoadAssetContainerAsync = load;
  const scene = assets.scene('system');
  await assets.ships.upgrade(scene, ship('b', 0), assets.fallback('b'));
  assert.equal(await assets.ships.refresh(scene, ship('b', 3)), null, 'a promotion that does not fit');
  assert.deepEqual(logs, [
    'Hull small-near.glb unavailable (file missing); ships keep the hull or dart they have.',
    'Hull small-near.glb unavailable (not a glTF); ships keep the hull or dart they have.',
    'Ship hull triangle budget reached; ships that do not fit keep the hull or dart they have.',
  ]);
});

test('a manifest that cannot be used logs why', async () => {
  const assets = loadShipAssets({ ...LADDER_MANIFEST, schemaVersion: 2 }, {});
  const logs = logsOf(assets);
  assert.equal(await assets.AUR.shipAssets.manifestPromise, null);
  assert.deepEqual(logs, ['Ship assets unavailable (manifest schema unsupported); using procedural hulls.']);
});

test('a template whose parts cannot all be dressed leaves no node or half-dressed livery behind, and later builds work; a root that cannot be disposed is logged and the rest go', async () => {
  const assets = loadShipAssets(LADDER_MANIFEST, {}); // parts: hull_primary, then accent_energy
  const scene = assets.scene('system');
  const { trimLight } = assets.models;
  assets.models.trimLight = () => { throw new Error('no trim light'); }; // the second part, once its livery is copied
  assert.equal(await assets.ships.upgrade(scene, ship('a', 0), assets.fallback('a')), null, 'the fleet template');
  assets.ships.fade(scene, 0.16, { shipId: 'b', visibility: 1 });
  assert.equal(await assets.ships.upgrade(scene, ship('b', 0), assets.fallback('b')), null, 'a template of its own');
  const { templates, materials } = assets.AUR.shipAssets.sceneStates.get(scene);
  assert.deepEqual([assets.templateNodes().length, templates.size], [0, 0], 'no node of either is left, drawn or kept');
  assert.ok(assets.liveClones().every((material) => [...materials.values()].includes(material)), 'every livery copy left is kept, dressed');

  assets.models.trimLight = trimLight;
  const [c, b] = [await assets.ships.upgrade(scene, ship('c', 0), assets.fallback('c')), await assets.ships.upgrade(scene, ship('b', 0), assets.fallback('b'))];
  assert.ok([c, b].every((root) => root && instancesOf(root).length === 2), 'both build');
  assert.ok(templatesOf(c).every((mesh) => mesh.visibility === 0.16) && templatesOf(b).every((mesh) => mesh.visibility === 1));

  // A template of two roots, the first of which cannot be disposed, for a palette not dressed yet.
  const logs = logsOf(assets);
  const { container } = assets.AUR.shipAssets.sceneStates.get(scene).containers.get('small-near.glb');
  const make = container.instantiateModelsToScene;
  const made = [];
  container.instantiateModelsToScene = (...args) => {
    const rootNodes = [...make(...args).rootNodes, ...make(...args).rootNodes];
    made.push(...rootNodes.map((root) => [root, ...root.getChildMeshes(false)]));
    rootNodes[0].dispose = () => { throw new Error('no dispose'); };
    return { rootNodes };
  };
  assets.models.trimLight = () => { throw new Error('no trim light on codex'); };
  assert.equal(await assets.ships.upgrade(scene, ship('e', 0, { provider: 'codex' }), assets.fallback('e')), null);
  assert.deepEqual(made.map((nodes) => nodes.map((node) => node.disposed)), [[false, false, false], [true, true, true]]);
  assert.deepEqual(logs, [
    'Unmade template ship_template_small-near.glb|codex could not be disposed (no dispose).',
    'Hull small could not be built (no trim light on codex); the ship keeps the hull or dart it has.',
  ]);
});

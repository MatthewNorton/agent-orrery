'use strict';

// The ship-assets core and hulls (src/renderer/ship-assets.js, ship-assets-hulls.js): the rank
// ladder, LODs, a template per provider and the livery. AUR.ships' refresh, fade and triangle
// budget are test/ship-assets-api.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  RENDERER, SHIP_ASSET_FILES, loadShipAssetFiles, providerKey, Color, fakeAur, SHIP_LAYER, onLayer,
  loadShipAssets, LADDER_MANIFEST, ship, hullId, partMaterial,
} = require('./support/ship-assets');

test('index.html loads every ship-assets file, the core first', () => {
  const onDisk = fs.readdirSync(RENDERER).filter((file) => /^ship-assets.*\.js$/.test(file)).sort();
  assert.equal(SHIP_ASSET_FILES[0], 'ship-assets.js');
  assert.deepEqual([...SHIP_ASSET_FILES].sort(), onDisk);
});

test('shared hulls receive fixed provider palettes; a signal loads no model and a drone flies its family hull', async () => {
  let containerLoads = 0;
  let materialClones = 0;
  const instantiatedMeshes = [];

  class Vector {
    setAll(value) { this.x = value; this.y = value; this.z = value; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; }
  }

  class Material {
    constructor(name) {
      this.name = name;
      this.diffuseColor = new Color('#000000');
      this.emissiveColor = new Color('#000000');
    }
    clone(name) {
      materialClones += 1;
      return new Material(name);
    }
    dispose() {}
  }

  class Node {
    constructor(name) {
      this.name = name;
      this.metadata = null;
      this.position = new Vector();
      this.rotation = new Vector();
      this.scaling = new Vector();
      this.isPickable = true;
      this.disposed = false;
      this.onDisposeObservable = { addOnce: (callback) => { this.onDispose = callback; } };
    }
    isDisposed() { return this.disposed; }
    dispose() {
      this.disposed = true;
      if (this.onDispose) this.onDispose();
    }
  }

  class Mesh extends Node {}
  Mesh.BILLBOARDMODE_ALL = 7;
  class TransformNode extends Node {}

  const sourceMaterial = new Material('accent_energy');
  const container = {
    meshes: [{ getTotalIndices: () => 300 }],
    instantiateModelsToScene() {
      const mesh = new Node('accent');
      mesh.material = sourceMaterial;
      mesh.getChildMeshes = () => [];
      // A ship's hull is an instance of this template mesh.
      mesh.instantiateHierarchy = (parent, _options, created) => {
        const instance = Object.assign(new Node('instance of accent'), { material: mesh.material, parent, getChildMeshes: () => [] });
        created(mesh, instance);
        return instance;
      };
      instantiatedMeshes.push(mesh);
      return { rootNodes: [mesh] };
    },
    dispose() {},
  };

  const manifest = {
    schemaVersion: 1,
    providerFamilies: { claude: 'shared', codex: 'shared' },
    hulls: [{
      id: 'shared-small', file: 'shared-small.glb', family: 'shared', role: 'main-s',
      correction: { rotateY: 0, scale: 1, offset: [0, 0, 0] },
    }],
  };
  const AUR = fakeAur({
    Color,
    Material,
    markShipMesh(mesh, ship) {
      mesh.metadata = {
        ...(mesh.metadata || {}), isShip: true, shipId: ship.id,
        projectId: ship.project, providerKey: providerKey(ship.provider), kind: ship.kind,
      };
      const key = providerKey(ship.provider);
      return { key, label: key };
    },
  });
  const context = {
    window: { AUR },
    fetch: async () => ({ ok: true, status: 200, json: async () => manifest }),
    BABYLON: {
      SceneLoader: {
        LoadAssetContainerAsync: async () => {
          containerLoads += 1;
          return container;
        },
      },
      Color3: Color,
      Mesh,
      TransformNode,
      StandardMaterial: Material,
    },
  };
  loadShipAssetFiles(context);

  const scene = { uid: 'scene-1', isDisposed: () => false };
  const fallback = (id) => Object.assign(new Mesh('fallback-' + id), {
    material: { alpha: 1 }, metadata: { isShip: true, shipId: id },
  });
  const claudeFallback = fallback('claude-a');
  const codexFallback = fallback('codex-a');
  const claude = await AUR.ships.upgrade(scene, {
    id: 'claude-a', provider: 'claude', project: 'project-1',
  }, claudeFallback);
  const codex = await AUR.ships.upgrade(scene, {
    id: 'codex-a', provider: 'codex', project: 'project-1',
  }, codexFallback);

  assert.equal(containerLoads, 1);
  assert.equal(materialClones, 2);
  assert.notEqual(claude.material, codex.material);
  assert.equal(claude.material.emissiveColor.toHexString(), '#d97757');
  assert.equal(codex.material.emissiveColor.toHexString(), '#f2f0ea');
  assert.equal(claude.metadata.providerTint, '#d97757');
  assert.equal(codex.metadata.providerTint, '#f2f0ea');
  assert.equal(claudeFallback.metadata.isShip, false);
  assert.equal(codexFallback.metadata.isShip, false);
  assert.ok(instantiatedMeshes.every((mesh) => mesh.isPickable === false));

  const signalFallback = fallback('signal-a');
  const droneFallback = fallback('drone-a');
  assert.equal(await AUR.ships.upgrade(scene, {
    id: 'signal-a', provider: 'signal', project: 'project-1',
  }, signalFallback), null);
  const drone = await AUR.ships.upgrade(scene, {
    id: 'drone-a', provider: 'codex', kind: 'drone', project: 'project-1',
  }, droneFallback);
  assert.equal(containerLoads, 1, 'a signal requests no model; a drone shares its family container');
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
  const parts = (node) => node.getChildMeshes(false).filter((mesh) => mesh.material);
  assert.deepEqual(parts(root).map((mesh) => mesh.material.worn), ['coded claude #d97757 hull_primary', 'coded claude #d97757 accent_energy']);
  assert.deepEqual(parts(drone).map((mesh) => mesh.material.worn), ['coded codex #f2f0ea hull_primary', 'coded codex #f2f0ea accent_energy']);
  for (const mesh of [...parts(root), ...parts(drone)]) {
    assert.ok(mesh instanceof assets.InstancedMesh && mesh.isVisible && !mesh.sourceMesh.isVisible, 'an instance of a hidden template');
    assert.ok(onLayer(mesh, assets.models.LAYER) && onLayer(mesh.sourceMesh, assets.models.LAYER), 'seen by the camera, lit by the model lights only');
  }
  const twin = await assets.ships.upgrade(system, ship('twin', 0), assets.fallback('twin'));
  assert.ok(parts(twin).every((mesh, i) => mesh.sourceMesh === parts(root)[i].sourceMesh), 'one template per palette');

  assert.equal(await assets.ships.refresh(system, ship('a', 3)), root, 'promoted in place');
  assert.equal(hullId(root), 'mid');
  assert.deepEqual(assets.loads, ['mid-near.glb']);
  assert.ok(parts(root).every((mesh) => onLayer(mesh, SHIP_LAYER) && onLayer(mesh.sourceMesh, SHIP_LAYER) && !mesh.material.worn),
    'a manifest hull wears the fleet livery and is lit by the fleet lights, not the model ones');

  const universe = assets.scene('universe');
  const far = [];
  for (const id of ['x', 'y']) far.push(await assets.ships.upgrade(universe, ship(id, 0), assets.fallback(id)));
  assert.deepEqual(built, ['coded', 'coded'], 'one built container per scene');
  const sources = far.map((entry) => parts(entry).map((mesh) => {
    assert.ok(mesh instanceof assets.InstancedMesh && mesh.isVisible && onLayer(mesh, assets.models.LAYER));
    return mesh.sourceMesh;
  }));
  assert.deepEqual(sources[0], sources[1], 'on the map the ships of a palette are instances of one template');
});

test('every view instances its hulls from one template per provider: far hulls on the map, near ones in a system', async () => {
  const assets = loadShipAssets(LADDER_MANIFEST, {});
  const universe = assets.scene('universe');
  const first = await assets.ships.upgrade(universe, ship('a', 0), assets.fallback('a'));
  const second = await assets.ships.upgrade(universe, ship('b', 0), assets.fallback('b'));
  const codex = await assets.ships.upgrade(universe, ship('c', 0, { provider: 'codex' }), assets.fallback('c'));
  assert.deepEqual(assets.loads, ['small-far.glb']);
  for (const root of [first, second, codex]) {
    const parts = root.getChildMeshes(false).filter((mesh) => mesh.material);
    assert.equal(parts.length, 2);
    assert.ok(parts.every((mesh) => mesh instanceof assets.InstancedMesh && mesh.isVisible));
    assert.ok(parts.every((mesh) => mesh.sourceMesh.isVisible === false), 'templates stay hidden');
    assert.equal(root.metadata.assetLod, 'far');
  }
  const sources = (root) => root.getChildMeshes(false).filter((mesh) => mesh.sourceMesh).map((mesh) => mesh.sourceMesh);
  assert.deepEqual(sources(first), sources(second), 'one template per provider');
  assert.notDeepEqual(sources(first), sources(codex));
  assert.equal(first.material.emissiveColor.toHexString(), '#d97757');
  assert.equal(codex.material.emissiveColor.toHexString(), '#f2f0ea');
  assert.ok(partMaterial(first, 'hull_primary').emissiveColor.r > 0, 'far hulls carry a faint self-light on the unlit map');

  const system = assets.scene('system');
  const near = await assets.ships.upgrade(system, ship('a', 0), assets.fallback('a'));
  const nearTwin = await assets.ships.upgrade(system, ship('b', 0), assets.fallback('b'));
  assert.equal(assets.loads.at(-1), 'small-near.glb');
  const nearParts = (root) => root.getChildMeshes(false).filter((mesh) => mesh.material);
  assert.ok(nearParts(near).every((mesh) => mesh instanceof assets.InstancedMesh && mesh.sourceMesh.isVisible === false));
  assert.ok(nearParts(nearTwin).every((mesh, i) => mesh.sourceMesh === nearParts(near)[i].sourceMesh), 'one template per provider');
  assert.ok(nearParts(near).every((mesh) => onLayer(mesh, SHIP_LAYER) && onLayer(mesh.sourceMesh, SHIP_LAYER)),
    'the template carries the fleet light layer, and both keep the camera\'s');
  assert.equal(partMaterial(near, 'hull_primary').emissiveColor.toHexString(), '#000000', 'a near hull is lit, not self-lit');
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

test('a fleet hull keeps its baked tones and glass, and its trim lights and nozzles emit the ship color', async () => {
  const assets = loadShipAssets(LADDER_MANIFEST, {}, [
    { name: 'hull_white', textured: true, albedo: '#f2f2f2' }, { name: 'hull_grey', textured: true, albedo: '#f2f2f2' },
    { name: 'canopy_glass', albedo: '#06101c' }, 'accent_livery', 'engine_glow', 'window_light',
  ]);
  const scene = assets.scene('system');
  const claude = await assets.ships.upgrade(scene, ship('a', 0), assets.fallback('a'));
  const codex = await assets.ships.upgrade(scene, ship('b', 0, { provider: 'codex' }), assets.fallback('b'));

  for (const tone of ['hull_white', 'hull_grey']) {
    assert.equal(partMaterial(claude, tone).albedoColor.toHexString(), '#f2f2f2', tone + ' stays as baked');
  }
  assert.equal(partMaterial(claude, 'canopy_glass').albedoColor.toHexString(), '#06101c', 'the glass keeps its smoke');
  assert.equal(partMaterial(claude, 'canopy_glass').emissiveColor.toHexString(), '#000000');
  for (const light of ['accent_livery', 'engine_glow']) {
    assert.deepEqual(partMaterial(claude, light).emissiveColor, new Color('#d97757').toLinearSpace(), light + ' emits terracotta, linear, so the frame shows the hex');
    assert.deepEqual(partMaterial(codex, light).emissiveColor, new Color('#f2f0ea').toLinearSpace(), light + ' emits pearl on Codex');
    assert.ok(partMaterial(claude, light).albedoColor.r < 0.1, light + ' is a dark surface under its light');
    assert.ok(partMaterial(claude, light).emissiveIntensity > 1, light + ' outshines the lit hull');
  }
  assert.equal(partMaterial(claude, 'window_light').emissiveIntensity, undefined, 'only the trim runs hot');
  assert.ok(partMaterial(claude, 'window_light').emissiveColor.r < 0.3, 'a lit pane, not a white block');
  assert.equal(partMaterial(claude, 'engine_glow').metadata.role, 'glow', 'every fleet material carries its role');
  assert.equal(claude.material.emissiveColor.toHexString(), '#d97757', 'the root emits the exact hex as evidence');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('shared hulls receive fixed provider palettes while signals and drones load no models', async () => {
  let containerLoads = 0;
  let materialClones = 0;
  const instantiatedMeshes = [];

  class Vector {
    setAll(value) { this.x = value; this.y = value; this.z = value; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; }
  }

  class Color {
    constructor(r, g, b) {
      if (typeof r === 'string') {
        this.hex = r.toLowerCase();
        this.r = parseInt(this.hex.slice(1, 3), 16) / 255;
        this.g = parseInt(this.hex.slice(3, 5), 16) / 255;
        this.b = parseInt(this.hex.slice(5, 7), 16) / 255;
      } else {
        this.r = r;
        this.g = g;
        this.b = b;
      }
    }
    scale(value) { return new Color(this.r * value, this.g * value, this.b * value); }
    clone() { return new Color(this.r, this.g, this.b); }
    toHexString() {
      if (this.hex) return this.hex;
      const channel = (value) => Math.round(value * 255).toString(16).padStart(2, '0');
      return `#${channel(this.r)}${channel(this.g)}${channel(this.b)}`;
    }
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
  const providerKey = (value) => value === 'codex' ? 'codex' :
    value === 'signal' ? 'generic' : 'claude';
  const colors = { claude: '#a78bfa', codex: '#22d3ee', generic: '#94a3b8' };
  const AUR = {
    log() {},
    fnv1a() { return 0; },
    providerKey,
    providerMeta(value) {
      const key = providerKey(value);
      return { key, label: key, color: colors[key] };
    },
    shipTint(_id, provider) { return colors[providerKey(provider)]; },
    color3(hex) { return new Color(hex); },
    markShipMesh(mesh, ship) {
      mesh.metadata = {
        ...(mesh.metadata || {}), isShip: true, shipId: ship.id,
        projectId: ship.project, providerKey: providerKey(ship.provider), kind: ship.kind,
      };
      const key = providerKey(ship.provider);
      return { key, label: key };
    },
  };
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
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'ship-assets.js'), 'utf8');
  vm.runInNewContext(source, context, { filename: 'ship-assets.js' });

  const scene = { uid: 'scene-1', isDisposed: () => false };
  const fallback = (id) => Object.assign(new Mesh('fallback-' + id), {
    material: { alpha: 1 }, metadata: { isShip: true, shipId: id },
  });
  const claudeFallback = fallback('claude-a');
  const codexFallback = fallback('codex-a');
  const claude = await AUR.ships.upgrade(scene, {
    id: 'claude-a', provider: 'claude', project: 'project-1',
  }, claudeFallback, 1);
  const codex = await AUR.ships.upgrade(scene, {
    id: 'codex-a', provider: 'codex', project: 'project-1',
  }, codexFallback, 1);

  assert.equal(containerLoads, 1);
  assert.equal(materialClones, 2);
  assert.notEqual(claude.material, codex.material);
  assert.equal(claude.material.emissiveColor.toHexString(), '#a78bfa');
  assert.equal(codex.material.emissiveColor.toHexString(), '#22d3ee');
  assert.equal(claude.metadata.providerTint, '#a78bfa');
  assert.equal(codex.metadata.providerTint, '#22d3ee');
  assert.equal(claudeFallback.metadata.isShip, false);
  assert.equal(codexFallback.metadata.isShip, false);
  assert.ok(instantiatedMeshes.every((mesh) => mesh.isPickable === false));

  const signalFallback = fallback('signal-a');
  const droneFallback = fallback('drone-a');
  assert.equal(await AUR.ships.upgrade(scene, {
    id: 'signal-a', provider: 'signal', project: 'project-1',
  }, signalFallback, 1), null);
  assert.equal(await AUR.ships.upgrade(scene, {
    id: 'drone-a', provider: 'codex', kind: 'drone', project: 'project-1',
  }, droneFallback, 1), null);
  assert.equal(containerLoads, 1, 'signals and drones do not request model containers');
  assert.equal(signalFallback.metadata.isShip, true);
  assert.equal(droneFallback.metadata.isShip, true);
});

// ---------- rank ladder, LODs and in-place refresh ----------

// A small scene graph: enough of Babylon's node, mesh and instance behaviour
// for ship-assets.js to build, swap and dispose hulls.
function loadShipAssets(manifest, trianglesByFile) {
  const loads = [];
  class Vector {
    constructor() { this.x = 0; this.y = 0; this.z = 0; }
    setAll(value) { this.x = value; this.y = value; this.z = value; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; }
  }
  class Color {
    constructor(r, g, b) {
      if (typeof r === 'string') {
        this.r = parseInt(r.slice(1, 3), 16) / 255;
        this.g = parseInt(r.slice(3, 5), 16) / 255;
        this.b = parseInt(r.slice(5, 7), 16) / 255;
      } else {
        this.r = r; this.g = g; this.b = b;
      }
    }
    scale(value) { return new Color(this.r * value, this.g * value, this.b * value); }
    clone() { return new Color(this.r, this.g, this.b); }
    toHexString() {
      const channel = (value) => Math.round(value * 255).toString(16).padStart(2, '0');
      return `#${channel(this.r)}${channel(this.g)}${channel(this.b)}`;
    }
  }
  class Material {
    constructor(name) {
      this.name = name;
      this.albedoColor = new Color(0, 0, 0);
      this.emissiveColor = new Color(0, 0, 0);
    }
    clone(name) { return new Material(name); }
    dispose() {}
  }
  class Node {
    constructor(name) {
      this.name = name;
      this.metadata = null;
      this.position = new Vector();
      this.rotation = new Vector();
      this.scaling = new Vector();
      this.scaling.setAll(1);
      this.isPickable = true;
      this.isVisible = true;
      this.visibility = 1;
      this.disposed = false;
      this.children = [];
      this.parentNode = null;
      this.onDispose = [];
      this.onDisposeObservable = { addOnce: (callback) => this.onDispose.push(callback) };
    }
    get parent() { return this.parentNode; }
    set parent(node) {
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
      this.parentNode = node;
      if (node) node.children.push(this);
    }
    getChildMeshes(directOnly) {
      const out = [];
      for (const child of this.children) {
        if (child instanceof Mesh) out.push(child);
        if (!directOnly) out.push(...child.getChildMeshes(false));
      }
      return out;
    }
    isDisposed() { return this.disposed; }
    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      for (const child of [...this.children]) child.dispose();
      this.parent = null;
      for (const callback of this.onDispose) callback();
    }
  }
  class TransformNode extends Node {}
  class Mesh extends Node {
    instantiateHierarchy(newParent, options, onNewNodeCreated) {
      const copy = this.hasGeometry ? new InstancedMesh(this) : new Mesh(this.name);
      copy.parent = newParent;
      if (onNewNodeCreated) onNewNodeCreated(this, copy);
      for (const child of this.children) child.instantiateHierarchy(copy, options, onNewNodeCreated);
      return copy;
    }
  }
  class InstancedMesh extends Mesh {
    constructor(source) {
      super('instance of ' + source.name);
      this.sourceMesh = source;
    }
    get material() { return this.sourceMesh.material; }
    set material(value) { /* an instance draws with its source mesh's material */ }
  }
  const materialNames = ['hull_primary', 'accent_energy'];
  const containerFor = (file) => ({
    meshes: [{ getTotalIndices: () => (trianglesByFile[file] || 1000) * 3 }],
    instantiateModelsToScene(nameFor) {
      const root = new Mesh(nameFor('__root__'));
      for (const name of materialNames) {
        const part = new Mesh(nameFor(name));
        part.hasGeometry = true;
        part.material = new Material(name);
        part.parent = root;
      }
      return { rootNodes: [root] };
    },
    dispose() {},
  });
  const providerKey = (value) => value === 'codex' ? 'codex' : value === 'signal' ? 'generic' : 'claude';
  const colors = { claude: '#a78bfa', codex: '#22d3ee', generic: '#94a3b8' };
  const AUR = {
    log() {},
    fnv1a() { return 0; },
    providerKey,
    providerMeta(value) {
      const key = providerKey(value);
      return { key, label: key, color: colors[key] };
    },
    shipTint(_id, provider) { return colors[providerKey(provider)]; },
    color3(hex) { return new Color(hex); },
    markShipMesh(mesh, ship) {
      mesh.metadata = { ...(mesh.metadata || {}), isShip: true, shipId: ship.id };
      return { key: providerKey(ship.provider), label: '' };
    },
  };
  const context = {
    window: { AUR },
    fetch: async () => ({ ok: true, status: 200, json: async () => manifest }),
    BABYLON: {
      SceneLoader: {
        LoadAssetContainerAsync: async (_root, file) => {
          loads.push(file);
          return containerFor(file);
        },
      },
      Color3: Color, Mesh, TransformNode, StandardMaterial: Material,
    },
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'ship-assets.js'), 'utf8');
  vm.runInNewContext(source, context, { filename: 'ship-assets.js' });
  let sceneCount = 0;
  return {
    ships: AUR.ships,
    loads,
    InstancedMesh,
    scene: (view) => ({ uid: 'scene-' + (++sceneCount), metadata: view ? { view } : null, isDisposed: () => false }),
    fallback: (id) => Object.assign(new Mesh('fallback-' + id), {
      material: { alpha: 1 }, metadata: { isShip: true, shipId: id },
    }),
  };
}

const LADDER_MANIFEST = {
  schemaVersion: 1,
  providerFamilies: { claude: 'ladder', codex: 'ladder' },
  hulls: [
    { id: 'escort', file: 'escort-near.glb', lods: { far: 'escort-far.glb' }, family: 'ladder', role: 'escort' },
    { id: 'big', file: 'big-near.glb', lods: { far: 'big-far.glb' }, family: 'ladder', role: 'main', minBuilds: 10,
      correction: { rotateY: Math.PI, scale: 0.5, offset: [0, 0, 0] } },
    { id: 'small', file: 'small-near.glb', lods: { far: 'small-far.glb' }, family: 'ladder', role: 'main', minBuilds: 0,
      correction: { rotateY: Math.PI, scale: 0.2, offset: [0, 0, 0] } },
    { id: 'mid', file: 'mid-near.glb', lods: { far: 'mid-far.glb' }, family: 'ladder', role: 'main', minBuilds: 3,
      correction: { rotateY: Math.PI, scale: 0.3, offset: [0, 0, 0] } },
  ],
};
const ship = (id, builds, extra) => ({ id, provider: 'claude', kind: 'main', project: 'p', builds, ...extra });
const hullId = (root) => root && root.metadata.assetHullId;

test('main ships take the highest rank their build count has reached', async () => {
  const assets = loadShipAssets(LADDER_MANIFEST, {});
  const scene = assets.scene('system');
  const ranks = [];
  for (const builds of [0, 2, 3, 9, 10, 500, undefined]) {
    ranks.push(hullId(await assets.ships.upgrade(scene, ship('s' + builds, builds), assets.fallback('s' + builds), 1)));
  }
  assert.deepEqual(ranks, ['small', 'small', 'mid', 'mid', 'big', 'big', 'small']);
  assert.equal(await assets.ships.upgrade(scene, ship('d', 50, { kind: 'drone' }), assets.fallback('d'), 1), null);
  assert.ok(!assets.loads.some((file) => file.startsWith('escort')), 'the reserved escort is never a rank');
});

test('the universe instances far hulls from one template per provider; other views clone near hulls', async () => {
  const assets = loadShipAssets(LADDER_MANIFEST, {});
  const universe = assets.scene('universe');
  const first = await assets.ships.upgrade(universe, ship('a', 0), assets.fallback('a'), 1);
  const second = await assets.ships.upgrade(universe, ship('b', 0), assets.fallback('b'), 1);
  const codex = await assets.ships.upgrade(universe, ship('c', 0, { provider: 'codex' }), assets.fallback('c'), 1);
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
  assert.equal(first.material.emissiveColor.toHexString(), '#a78bfa');
  assert.equal(codex.material.emissiveColor.toHexString(), '#22d3ee');
  const hull = first.getChildMeshes(false).find((mesh) => mesh.material && mesh.material.name.includes('hull_primary'));
  assert.ok(hull.material.emissiveColor.r > 0, 'far hulls carry a faint self-light on the unlit map');

  const system = assets.scene('system');
  const near = await assets.ships.upgrade(system, ship('a', 0), assets.fallback('a'), 1);
  assert.equal(assets.loads.at(-1), 'small-near.glb');
  assert.ok(near.getChildMeshes(false).every((mesh) => !(mesh instanceof assets.InstancedMesh)));
  const nearHull = near.getChildMeshes(false).find((mesh) => mesh.material && mesh.material.name.includes('hull_primary'));
  assert.equal(nearHull.material.emissiveColor.toHexString(), '#000000');
});

test('a scene that has not declared its view loads nothing until upgrade, which defaults to far', async () => {
  const assets = loadShipAssets(LADDER_MANIFEST, {});
  const scene = assets.scene(null);
  await assets.ships.upgrade(scene, ship('warm', 0), assets.fallback('warm'), 1); // settles the manifest
  assets.loads.length = 0;
  assert.equal(assets.ships.instantiate(scene, ship('a', 0)), null);
  assert.deepEqual(assets.loads, [], 'instantiate starts no load before the view is known');
  const root = await assets.ships.upgrade(scene, ship('a', 0), assets.fallback('a'), 1);
  assert.equal(root.metadata.assetLod, 'far');
  scene.metadata = { view: 'planet' };
  assert.equal(assets.ships.instantiate(scene, ship('b', 0)), null, 'first sight of a file only starts its load');
  await new Promise((resolve) => setImmediate(resolve));
  const ready = assets.ships.instantiate(scene, ship('c', 0));
  assert.equal(ready.metadata.assetLod, 'near');
});

test('refresh swaps the hull inside the same root and keeps the fallback valid', async () => {
  const assets = loadShipAssets(LADDER_MANIFEST, {});
  const scene = assets.scene('system');
  const fallback = assets.fallback('a');
  const root = await assets.ships.upgrade(scene, ship('a', 0), fallback, 1.1);
  const firstCorrection = root.children[0];
  assert.equal(firstCorrection.scaling.x, 0.2);

  assert.equal(await assets.ships.refresh(scene, ship('a', 2)), null, 'same rank: nothing to do');
  assert.equal(await assets.ships.refresh(scene, ship('a', 4)), root);
  assert.equal(root.parent, fallback);
  assert.equal(root.scaling.x, 1.1, 'the scene-owned display scale is untouched');
  assert.equal(hullId(root), 'mid');
  assert.equal(root.metadata.isShip, true);
  assert.equal(fallback.metadata.upgradedHullId, 'mid');
  assert.equal(firstCorrection.disposed, true);
  assert.equal(root.children.length, 1);
  assert.equal(root.children[0].scaling.x, 0.3, 'class display size lives on the correction node');
  assert.equal(root.material.emissiveColor.toHexString(), '#a78bfa');

  assert.equal(await assets.ships.refresh(scene, ship('unknown', 50)), null);
  root.dispose();
  assert.equal(await assets.ships.refresh(scene, ship('a', 50)), null, 'a disposed ship is forgotten');
});

test('refresh waits while focus mode fades the ship and only applies the latest request', async () => {
  const assets = loadShipAssets(LADDER_MANIFEST, {});
  const scene = assets.scene('system');
  const root = await assets.ships.upgrade(scene, ship('a', 0), assets.fallback('a'), 1);
  for (const mesh of root.getChildMeshes(false)) mesh.visibility = 0.16;
  assert.equal(await assets.ships.refresh(scene, ship('a', 10)), null);
  assert.equal(hullId(root), 'small');
  for (const mesh of root.getChildMeshes(false)) mesh.visibility = 1;
  const stale = assets.ships.refresh(scene, ship('a', 3));
  const latest = assets.ships.refresh(scene, ship('a', 10));
  assert.equal(await stale, null, 'superseded by a later rank');
  assert.equal(await latest, root);
  assert.equal(hullId(root), 'big');
});

test('the triangle budget steps near hulls down to far before falling back to the dart', async () => {
  const assets = loadShipAssets(LADDER_MANIFEST, {
    'small-near.glb': 40000, 'small-far.glb': 15000, 'mid-near.glb': 60000, 'mid-far.glb': 20000,
  });
  const scene = assets.scene('system');
  const lods = [];
  const roots = [];
  for (const id of ['a', 'b', 'c', 'd']) {
    const root = await assets.ships.upgrade(scene, ship(id, 0), assets.fallback(id), 1);
    roots.push(root);
    lods.push(root ? root.metadata.assetLod : 'dart');
  }
  assert.deepEqual(lods, ['near', 'near', 'far', 'dart']);
  roots[0].dispose();
  const freed = await assets.ships.upgrade(scene, ship('e', 0), assets.fallback('e'), 1);
  assert.equal(freed.metadata.assetLod, 'near', 'a disposed hull returns its triangles');
  // 40k + 15k + 40k are in use: the 60k near hull of the next rank does not
  // fit, so the promoted ship takes that rank's far file.
  assert.equal(await assets.ships.refresh(scene, ship('b', 3)), roots[1]);
  assert.equal(hullId(roots[1]), 'mid');
  assert.equal(roots[1].metadata.assetLod, 'far');
});

'use strict';

// The ship-assets files (src/renderer/ship-assets*.js and ships/livery.js) on the renderer's own
// util layer and enough of Babylon to build, fade, swap and dispose hulls, for
// test/ship-assets.test.js, test/ship-assets-api*.test.js and test/ships-livery.test.js; and the
// hull pickers those and test/ships-models.test.js share.

const assert = require('node:assert/strict');
const { loadUtilLayer, logsOf, runRenderer, scriptTags } = require('./renderer-source');

// In page order, from the core to ship-assets-api.js: the files after the core extend
// AUR.shipAssets and publish AUR.ships.
const SHIP_ASSET_FILES = (() => {
  const tags = scriptTags();
  return tags.slice(tags.indexOf('ship-assets.js'), tags.indexOf('ship-assets-api.js') + 1);
})();
// AUR.SHIP_LAYER, the fleet lights' layer; every camera sees Babylon's default mask, which a
// hull's template keeps when it adds the layer of its lights.
const SHIP_LAYER = 0x10000000;
const CAMERA_LAYERS = 0x0FFFFFFF;
const onLayer = (mesh, layer) => mesh.layerMask === (CAMERA_LAYERS | layer);
// An instance keeps the default mask (Babylon lights it as its template, which carries the layer).
const instanceOnLayer = (mesh, layer) => mesh.layerMask === CAMERA_LAYERS && onLayer(mesh.sourceMesh, layer);

// Enough of BABYLON.Color3 for the livery: hex in, channels, scale, linearization, hex out.
class Color {
  static FromHexString(hex) { return new Color(hex); }
  constructor(r, g, b) {
    if (typeof r === 'string') {
      this.hex = r.toLowerCase();
      this.r = parseInt(this.hex.slice(1, 3), 16) / 255;
      this.g = parseInt(this.hex.slice(3, 5), 16) / 255;
      this.b = parseInt(this.hex.slice(5, 7), 16) / 255;
    } else {
      this.r = r; this.g = g; this.b = b;
    }
  }
  scale(value) { return new Color(this.r * value, this.g * value, this.b * value); }
  clone() { return new Color(this.r, this.g, this.b); }
  toLinearSpace() { return new Color(Math.pow(this.r, 2.2), Math.pow(this.g, 2.2), Math.pow(this.b, 2.2)); }
  toHexString() {
    if (this.hex) return this.hex;
    const channel = (value) => Math.round(value * 255).toString(16).padStart(2, '0');
    return `#${channel(this.r)}${channel(this.g)}${channel(this.b)}`;
  }
}

// A small scene graph: enough of Babylon's node, mesh and instance behaviour for ship-assets to
// build, swap and dispose hulls. Every hull file carries `materials`: a material name, or
// { name, textured, albedo } for an authored one. The ship-assets files run on the real util
// layer (util.js, util-scene.js) over this Babylon, with the model registry before them, which
// registers no model unless a test does, so every rank flies its manifest hull.
function loadShipAssets(manifest, trianglesByFile, materials = ['hull_primary', 'accent_energy']) {
  const loads = [];
  const built = []; // the ship id of every hull built, in order
  const parts = []; // every template part made from a hull file
  const roots = []; // and every template root
  const clones = []; // every material copied
  let held = null; // while a test holds the loads (hold()), each waits on this
  class Vector {
    constructor() { this.x = 0; this.y = 0; this.z = 0; }
    setAll(value) { this.x = value; this.y = value; this.z = value; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; }
  }
  class Material {
    constructor(name) {
      this.name = name;
      this.albedoColor = new Color(0, 0, 0);
      this.emissiveColor = new Color(0, 0, 0);
    }
    clone(name) {
      const copy = new Material(name);
      copy.albedoTexture = this.albedoTexture;
      copy.albedoColor = this.albedoColor.clone();
      clones.push(copy);
      return copy;
    }
    dispose() { this.disposed = true; }
  }
  Material.MATERIAL_OPAQUE = 0;
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
      this.enabled = true;
      this.layerMask = CAMERA_LAYERS; // Babylon's default, as an instance has too
      this.ownVisibility = 1;
      this.disposed = false;
      this.children = [];
      this.parentNode = null;
      this.onDispose = [];
      this.onDisposeObservable = { addOnce: (callback) => this.onDispose.push(callback) };
    }
    get visibility() { return this.ownVisibility; }
    set visibility(value) { this.ownVisibility = value; }
    get parent() { return this.parentNode; }
    set parent(node) {
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
      this.parentNode = node;
      if (node) node.children.push(this);
    }
    setEnabled(value) { this.enabled = value; }
    isEnabled() { return this.enabled && (!this.parentNode || this.parentNode.isEnabled()); }
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
  class TransformNode extends Node {
    constructor(name) {
      super(name);
      if (name.startsWith('ship_correction_')) built.push(name.slice('ship_correction_'.length));
    }
  }
  // A mesh disposes its instances with it, as Babylon's does.
  class Mesh extends Node {
    constructor(name) {
      super(name);
      this.instances = [];
    }
    instantiateHierarchy(newParent, options, onNewNodeCreated) {
      const copy = this.hasGeometry ? new InstancedMesh(this) : new Mesh(this.name);
      copy.parent = newParent;
      if (onNewNodeCreated) onNewNodeCreated(this, copy);
      for (const child of this.children) child.instantiateHierarchy(copy, options, onNewNodeCreated);
      return copy;
    }
    dispose() {
      for (const instance of [...this.instances]) instance.dispose();
      super.dispose();
    }
  }
  // An instance shows its source mesh's material and visibility; Babylon ignores (and logs) a
  // visibility set on one, so here it fails the test.
  class InstancedMesh extends Mesh {
    constructor(source) {
      super('instance of ' + source.name);
      this.sourceMesh = source;
      source.instances.push(this);
    }
    get isAnInstance() { return true; }
    get material() { return this.sourceMesh.material; }
    set material(value) { /* an instance draws with its source mesh's material */ }
    get visibility() { return this.sourceMesh.visibility; }
    set visibility(value) { throw new Error('a visibility set on an instance does nothing'); }
    dispose() {
      this.sourceMesh.instances = this.sourceMesh.instances.filter((instance) => instance !== this);
      super.dispose();
    }
  }
  const containerFor = (file) => ({
    meshes: [{ getTotalIndices: () => (trianglesByFile[file] || 1000) * 3 }],
    instantiateModelsToScene(nameFor) {
      const root = new Mesh(nameFor('__root__'));
      roots.push(root);
      for (const spec of materials) {
        const { name, textured, albedo } = typeof spec === 'string' ? { name: spec } : spec;
        const part = new Mesh(nameFor(name));
        part.hasGeometry = true;
        part.material = new Material(name);
        if (textured) part.material.albedoTexture = { name: name + '_map' };
        if (albedo) part.material.albedoColor = new Color(albedo);
        part.parent = root;
        parts.push(part);
      }
      return { rootNodes: [root] };
    },
    dispose() {},
  });
  const BABYLON = {
    SceneLoader: {
      LoadAssetContainerAsync: async (_root, file) => {
        loads.push(file);
        if (held) await held;
        return containerFor(file);
      },
    },
    Color3: Color, Material, Mesh, TransformNode, StandardMaterial: Material,
  };
  const AUR = loadUtilLayer({}, BABYLON);
  AUR.log = () => {};
  const fetch = async () => ({ ok: true, status: 200, json: async () => manifest });
  for (const file of ['ships/models.js', ...SHIP_ASSET_FILES]) runRenderer(file, { window: { AUR }, BABYLON, fetch });
  let sceneCount = 0;
  return {
    AUR,
    BABYLON, // what the ship-assets files see as Babylon, read when they call it
    ships: AUR.ships,
    models: AUR.shipModels,
    triangles: (scene) => AUR.shipAssets.sceneStates.get(scene).triangles,
    loads,
    // The ship ids of the hulls built since the last call.
    built: () => built.splice(0),
    // The parts of every template made from a hull file and not disposed.
    templates: () => parts.filter((part) => !part.disposed),
    // Every node of those templates not disposed, their roots too.
    templateNodes: () => [...roots, ...parts].filter((node) => !node.disposed),
    materialClones: () => clones.length,
    liveClones: () => clones.filter((material) => !material.disposed),
    InstancedMesh,
    containerFor,
    scene: (view) => ({ uid: 'scene-' + (++sceneCount), metadata: view ? { view } : null, isDisposed: () => false }),
    fallback: (id) => Object.assign(new Mesh('fallback-' + id), {
      material: { alpha: 1 }, metadata: { isShip: true, shipId: id },
    }),
    // Holds the hull files that start loading until `release()`; `waiting()` settles once every
    // request made so far is waiting on one.
    hold() {
      let release = () => {};
      held = new Promise((resolve) => { release = resolve; });
      return { waiting: () => new Promise((resolve) => setImmediate(resolve)), release: () => { held = null; release(); } };
    },
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
const partMaterial = (root, name) => root.getChildMeshes(false).find((mesh) => mesh.material && mesh.material.name.includes(name)).material;

// A ship's hull is instances of its template's meshes, under its asset root.
const instancesOf = (root) => root.getChildMeshes(false).filter((mesh) => mesh.isAnInstance);
const templatesOf = (root) => instancesOf(root).map((mesh) => mesh.sourceMesh);
// The parts of a ship's hull all show `visibility` and are drawn (enabled), or are all hidden.
const shows = (root, visibility) => instancesOf(root).every((mesh) => mesh.visibility === visibility && mesh.isEnabled());
const hidden = (root) => instancesOf(root).every((mesh) => !mesh.isEnabled());
// Babylon objects compare by identity: a deepEqual that fails tries to print them whole.
const sameItems = (a, b) => a.length === b.length && a.every((item, i) => item === b[i]);
// A ship model is one merged mesh (ships/models.js), so its hull is one instance.
function hullOf(root) {
  const instances = instancesOf(root);
  assert.equal(instances.length, 1, 'one merged mesh per ship');
  return instances[0];
}

module.exports = {
  SHIP_ASSET_FILES, SHIP_LAYER, onLayer, instanceOnLayer, Color, loadShipAssets, LADDER_MANIFEST, ship, hullId, partMaterial,
  instancesOf, templatesOf, shows, hidden, sameItems, logsOf, hullOf,
};

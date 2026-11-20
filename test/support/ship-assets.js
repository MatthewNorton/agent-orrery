'use strict';

// The ship-assets files (src/renderer/ship-assets*.js) on enough of Babylon to build, fade, swap
// and dispose hulls, for test/ship-assets.test.js and test/ship-assets-api.test.js.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { scriptTags } = require('./renderer-source');

const RENDERER = path.join(__dirname, '..', '..', 'src', 'renderer');
// The core loads first; the files after it extend AUR.shipAssets and publish AUR.ships.
const SHIP_ASSET_FILES = scriptTags().filter((file) => /^ship-assets[a-z-]*\.js$/.test(file));

// The model registry loads before them (ship-assets asks it which ranks a model has taken); these
// tests register no model unless they say so, so every rank flies its manifest hull.
function loadShipAssetFiles(context) {
  vm.createContext(context);
  for (const file of ['ships/models.js', ...SHIP_ASSET_FILES]) {
    vm.runInContext(fs.readFileSync(path.join(RENDERER, file), 'utf8'), context, { filename: file });
  }
}

const providerKey = (value) => value === 'codex' ? 'codex' :
  value === 'signal' ? 'generic' : 'claude';
const colors = { claude: '#d97757', codex: '#f2f0ea', generic: '#94a3b8' };

// Enough of BABYLON.Color3 for the livery: hex in, channels, scale, linearization, hex out.
class Color {
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

// The AUR helpers ship-assets reads. Each test brings its own Color and Material classes and ship marker.
function fakeAur({ Color, Material, markShipMesh }) {
  return {
    log() {},
    fnv1a() { return 0; },
    providerKey,
    providerMeta(value) {
      const key = providerKey(value);
      return { key, label: key, color: colors[key] };
    },
    shipTint(_id, provider) { return colors[providerKey(provider)]; },
    shipColor(ship) { return ship && ship.local === true ? '#ff3344' : colors[providerKey(ship && ship.provider)]; },
    color3(hex) { return new Color(hex); },
    unlitMaterial(_scene, name, emissive) {
      const material = new Material(name);
      material.emissiveColor = emissive;
      return material;
    },
    memo(map, key, build) {
      if (!map.has(key)) map.set(key, build());
      return map.get(key);
    },
    fadeWithMesh() {},
    isNodeDisposed(node) { return !node || node.isDisposed(); },
    SHIP_LAYER: 0x10000000,
    nodeFamily(node) { return !node ? [] : typeof node.getChildMeshes === 'function' ? [node, ...node.getChildMeshes(false)] : [node]; },
    markShipMesh,
  };
}

// Every camera sees Babylon's default layer mask: a hull keeps it and adds the layer of its lights.
const CAMERA_LAYERS = 0x0FFFFFFF;
const SHIP_LAYER = 0x10000000;
const onLayer = (mesh, layer) => mesh.layerMask === (CAMERA_LAYERS | layer);

// A small scene graph: enough of Babylon's node, mesh and instance behaviour
// for ship-assets.js to build, swap and dispose hulls. Every hull file carries
// `materials`: a material name, or { name, textured, albedo } for an authored one.
function loadShipAssets(manifest, trianglesByFile, materials = ['hull_primary', 'accent_energy']) {
  const loads = [];
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
      return copy;
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
      this.scaling.setAll(1);
      this.isPickable = true;
      this.isVisible = true;
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
    clone(name, parent) {
      return Object.assign(new Mesh(name), { hasGeometry: this.hasGeometry, material: this.material, isVisible: this.isVisible, parent });
    }
    instantiateHierarchy(newParent, options, onNewNodeCreated) {
      const copy = this.hasGeometry ? new InstancedMesh(this) : new Mesh(this.name);
      copy.parent = newParent;
      if (onNewNodeCreated) onNewNodeCreated(this, copy);
      for (const child of this.children) child.instantiateHierarchy(copy, options, onNewNodeCreated);
      return copy;
    }
  }
  // An instance shows its source mesh's material and visibility; Babylon ignores (and logs) a
  // visibility set on one, so here it fails the test.
  class InstancedMesh extends Mesh {
    constructor(source) {
      super('instance of ' + source.name);
      this.sourceMesh = source;
    }
    get isAnInstance() { return true; }
    get material() { return this.sourceMesh.material; }
    set material(value) { /* an instance draws with its source mesh's material */ }
    get visibility() { return this.sourceMesh.visibility; }
    set visibility(value) { throw new Error('a visibility set on an instance does nothing'); }
  }
  const containerFor = (file) => ({
    meshes: [{ getTotalIndices: () => (trianglesByFile[file] || 1000) * 3 }],
    instantiateModelsToScene(nameFor) {
      const root = new Mesh(nameFor('__root__'));
      for (const spec of materials) {
        const { name, textured, albedo } = typeof spec === 'string' ? { name: spec } : spec;
        const part = new Mesh(nameFor(name));
        part.hasGeometry = true;
        part.material = new Material(name);
        if (textured) part.material.albedoTexture = { name: name + '_map' };
        if (albedo) part.material.albedoColor = new Color(albedo);
        part.parent = root;
      }
      return { rootNodes: [root] };
    },
    dispose() {},
  });
  const AUR = fakeAur({
    Color,
    Material,
    markShipMesh(mesh, ship) {
      mesh.metadata = { ...(mesh.metadata || {}), isShip: true, shipId: ship.id };
      return { key: providerKey(ship.provider), label: '' };
    },
  });
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
  loadShipAssetFiles(context);
  let sceneCount = 0;
  return {
    ships: AUR.ships,
    models: AUR.shipModels,
    triangles: (scene) => AUR.shipAssets.sceneStates.get(scene).triangles,
    loads,
    Mesh,
    InstancedMesh,
    containerFor,
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
const partMaterial = (root, name) => root.getChildMeshes(false).find((mesh) => mesh.material && mesh.material.name.includes(name)).material;

module.exports = {
  RENDERER, SHIP_ASSET_FILES, loadShipAssetFiles, providerKey, Color, fakeAur, SHIP_LAYER, onLayer,
  loadShipAssets, LADDER_MANIFEST, ship, hullId, partMaterial,
};

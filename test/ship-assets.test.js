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

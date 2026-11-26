'use strict';

// The ship model registry and the models on the real Babylon build (a NullEngine and a stand-in
// canvas), for the tests of the models and of what flies them.

const fs = require('node:fs');
const path = require('node:path');
const BABYLON = require('babylonjs');
const { withCanvas, onNullScene, loadShipModules } = require('../../scripts/lib/ship-fingerprint.js');
const { loadUtilLayer, runRenderer, scriptTags } = require('./renderer-source');
const { SHIP_ASSET_FILES, ship } = require('./ship-assets');

const ROOT = path.join(__dirname, '..', '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
// The registry, every model's converted source and its adapter, in the order the page loads them.
const MODEL_SCRIPT = /^ships\/(?:models\.js|[^/]+\/(?:source\/[^/]+|model)\.js)$/;
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'ships', 'manifest.json'), 'utf8'));

// The registry and the models on the renderer's own helpers, as the page loads them.
function loadShipModels() {
  const AUR = loadUtilLayer({}, BABYLON);
  loadShipModules(BABYLON, path.join(RENDERER, 'ships', 'modules.js'),
    scriptTags().filter((src) => MODEL_SCRIPT.test(src)).map((src) => path.join(RENDERER, src)), AUR);
  // A NullEngine cannot make the raw cube texture the probe is, so the model reflects a stand-in here.
  AUR.shipModule('petrel/light-probe', () => ({ createInspectionProbe: (scene) => new BABYLON.Texture(null, scene) }));
  return AUR;
}

// The manifest hull of the Claude family's rank that opens at `minBuilds` builds.
const rank = (minBuilds) => manifest.hulls.find((hull) => hull.family === manifest.providerFamilies.claude && hull.minBuilds === minBuilds);

// Runs `work(scene, AUR.shipModels, AUR)` on a fresh scene, with the registry and the models loaded.
function onModelScene(work) {
  return withCanvas(() => onNullScene(BABYLON, (scene) => {
    const AUR = loadShipModels();
    return work(scene, AUR.shipModels, AUR);
  }));
}

// Runs `work(scene, AUR, fly)` on a system view's scene, with AUR.ships on the real Babylon build
// and the models in the ranks they take from the manifest on disk; `fly(id, builds)` resolves to
// the hull of a ship of that many builds, a Scout's when not given.
function onSystem(work) {
  return withCanvas(() => onNullScene(BABYLON, async (scene) => {
    const AUR = loadShipModels();
    const fetch = async () => ({ ok: true, status: 200, json: async () => manifest });
    for (const file of SHIP_ASSET_FILES) runRenderer(file, { window: { AUR }, BABYLON, fetch });
    scene.metadata = { view: 'system' };
    const fly = (id, builds = 0) => AUR.ships.upgrade(scene, ship(id, builds), new BABYLON.Mesh('dart ' + id, scene));
    return work(scene, AUR, fly);
  }));
}

const near = (a, b, epsilon = 1e-9) => Math.abs(a - b) < epsilon;
const trianglesOf = (mesh) => mesh.getTotalIndices() / 3;
// The palettes a hull is liveried in, each with its ship color.
const palettes = (AUR) => [['claude', AUR.PROVIDERS.claude.color], ['codex', AUR.PROVIDERS.codex.color], ['local', AUR.LOCAL_MODEL.color]];

// A model as its build leaves it in the scene: its root, and the box it fills.
function built(scene, model) {
  const root = model.build(scene);
  root.computeWorldMatrix(true);
  const { min, max } = root.getHierarchyBoundingVectors(true);
  return { root, min, max, size: max.subtract(min) };
}

module.exports = { manifest, rank, loadShipModels, onModelScene, onSystem, near, trianglesOf, palettes, built };

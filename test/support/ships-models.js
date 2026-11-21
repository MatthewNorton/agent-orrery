'use strict';

// The ship model registry and Petrel on the real Babylon build (a NullEngine and a stand-in
// canvas), for test/ships-models.test.js and test/ship-assets-hulls.test.js.

const fs = require('node:fs');
const path = require('node:path');
const BABYLON = require('babylonjs');
const { withCanvas, onNullScene, loadShipModules } = require('../../scripts/lib/ship-fingerprint.js');
const { loadUtilLayer, runRenderer } = require('./renderer-source');
const { SHIP_ASSET_FILES, ship } = require('./ship-assets');

const ROOT = path.join(__dirname, '..', '..');
const SHIPS = path.join(ROOT, 'src', 'renderer', 'ships');
const SOURCE = path.join(SHIPS, 'petrel', 'source');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'ships', 'manifest.json'), 'utf8'));

// The registry and Petrel on the renderer's own helpers, as the page loads them.
function loadShipModels() {
  const AUR = loadUtilLayer({}, BABYLON);
  const sources = fs.readdirSync(SOURCE).filter((name) => name.endsWith('.js')).map((name) => path.join(SOURCE, name));
  loadShipModules(BABYLON, path.join(SHIPS, 'modules.js'),
    [...sources, path.join(SHIPS, 'models.js'), path.join(SHIPS, 'petrel', 'model.js')], AUR);
  // A NullEngine cannot make the raw cube texture the probe is, so the model reflects a stand-in here.
  AUR.shipModule('petrel/light-probe', () => ({ createInspectionProbe: (scene) => new BABYLON.Texture(null, scene) }));
  return AUR;
}

// Runs `work(scene, AUR, fly)` on a system view's scene, with AUR.ships on the real Babylon build
// and Petrel flying the Scout rank of the manifest on disk; `fly(id)` resolves to a ship's hull.
function onSystem(work) {
  return withCanvas(() => onNullScene(BABYLON, async (scene) => {
    const AUR = loadShipModels();
    const fetch = async () => ({ ok: true, status: 200, json: async () => manifest });
    for (const file of SHIP_ASSET_FILES) runRenderer(file, { window: { AUR }, BABYLON, fetch });
    scene.metadata = { view: 'system' };
    const fly = (id) => AUR.ships.upgrade(scene, ship(id, 0), new BABYLON.Mesh('dart ' + id, scene));
    return work(scene, AUR, fly);
  }));
}

module.exports = { manifest, loadShipModels, onSystem };

'use strict';

// Ship models in Node: converted ship modules run against the real Babylon build on a NullEngine
// (with a stand-in 2D canvas, since a model paints its own textures), and a built ship reduces to
// a fingerprint of its geometry. scripts/import-ship.mjs and the tests share this.
const crypto = require('node:crypto');
const fs = require('node:fs');

const lf = (text) => text.replace(/\r\n/g, '\n');
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

// A 2D context that accepts every call and returns blank pixels.
function blankContext() {
  const nothing = () => {};
  const gradient = { addColorStop: nothing };
  const pixels = (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) });
  const known = {
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    getImageData: (x, y, width, height) => pixels(width, height),
    createImageData: pixels,
    measureText: () => ({ width: 0 }),
  };
  return new Proxy(known, { get: (target, key) => (key in target ? target[key] : nothing), set: () => true });
}

class BlankCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.context = blankContext();
  }
  getContext() { return this.context; }
}

/** Returns what `work()` returns and runs `cleanUp`: at once, or when the promise it returns settles. */
function cleanUpAfter(work, cleanUp) {
  let result;
  try {
    result = work();
  } finally {
    if (!(result instanceof Promise)) cleanUp();
  }
  return result instanceof Promise ? result.finally(cleanUp) : result;
}

/** Runs `work` with a stand-in for the canvas Babylon makes a DynamicTexture from. */
function withCanvas(work) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'OffscreenCanvas');
  const before = globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas = BlankCanvas;
  return cleanUpAfter(work, () => {
    if (had) globalThis.OffscreenCanvas = before;
    else delete globalThis.OffscreenCanvas;
  });
}

/** Runs `work(scene)` on a scene of its own (a NullEngine), which is gone once the work is done. */
function onNullScene(BABYLON, work) {
  const engine = new BABYLON.NullEngine();
  return cleanUpAfter(() => work(new BABYLON.Scene(engine)), () => engine.dispose());
}

// Positions, normals and UVs are rounded to 1e-5 so the last bit of a sine never changes the result.
function fingerprint(root) {
  const hash = crypto.createHash('sha256');
  const meshes = root.getChildMeshes(false).slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  let triangles = 0;
  for (const mesh of meshes) {
    hash.update(mesh.name + '|' + (mesh.parent ? mesh.parent.name : '') + '\n');
    for (const kind of ['position', 'normal', 'uv']) {
      const rounded = Int32Array.from(mesh.getVerticesData(kind) || [], (value) => Math.round(value * 1e5));
      hash.update(Buffer.from(rounded.buffer));
    }
    const indices = Uint32Array.from(mesh.getIndices() || []);
    hash.update(Buffer.from(indices.buffer));
    triangles += indices.length / 3;
  }
  return { meshes: meshes.length, triangles, sha256: hash.digest('hex') };
}

/**
 * Runs the renderer's ship module registry and the given renderer files as the page would, on
 * the AUR given (the helpers those files read), and returns the registry's `use`: `use(name)`
 * gives a module's exports.
 */
function loadShipModules(BABYLON, registryFile, moduleFiles, AUR = {}) {
  const window = { AUR };
  for (const file of [registryFile, ...moduleFiles]) {
    new Function('window', 'BABYLON', lf(fs.readFileSync(file, 'utf8')))(window, BABYLON);
  }
  return window.AUR.useShipModule;
}

/** The fingerprint of the ship `build(scene)` returns the root of. */
function fingerprintOf(BABYLON, build) {
  return withCanvas(() => onNullScene(BABYLON, (scene) => fingerprint(build(scene))));
}

/** The root of a ship a model's build returned, after a variant's call on it ([method, ...arguments]) when one is given. */
function rootOf(ship, call) {
  if (call) ship[call[0]](...call.slice(1));
  return ship.root;
}

module.exports = { lf, sha256, withCanvas, onNullScene, fingerprintOf, loadShipModules, rootOf };

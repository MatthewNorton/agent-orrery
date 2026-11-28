'use strict';

// Petrel's adapter (src/renderer/ships/petrel/model.js) on the real Babylon build (a NullEngine and
// a stand-in canvas): the bare ship flies the Scout rank, and the same build with its survey ring
// fitted flies the Workhorse and Capital ranks.
const test = require('node:test');
const assert = require('node:assert/strict');
const BABYLON = require('babylonjs');
const { fingerprintOf } = require('../scripts/lib/ship-fingerprint.js');
const { readRenderer } = require('./support/renderer-source');
const { shownLength } = require('./support/glb');
const { hullOf, ship } = require('./support/ship-assets');
const {
  rank, loadShipModels: load, onModelScene: onScene, onSystem, near, trianglesOf, palettes: palettesOf, built,
} = require('./support/ships-models');

const record = JSON.parse(readRenderer('ships/petrel/source/source.json'));
const [SCOUT, WORKHORSE, CAPITAL] = [0, 5, 20].map(rank);
const HALO = '#aa601a'; // the inner color of the halo the ring's map paints around each rail lamp

test('ringed, Petrel flies the Workhorse and Capital ranks: one container for both, a hull of its own in each', () => {
  const models = load().shipModels;
  const [workhorse, capital] = [WORKHORSE, CAPITAL].map((hull) => models.inPlaceOf(hull));
  const named = ({ id, file, role, minBuilds }) => ({ id, file, role, minBuilds });
  assert.deepEqual(named(workhorse), { id: 'petrel-ring', file: 'model:petrel-ring', role: WORKHORSE.role, minBuilds: 5 });
  assert.deepEqual(named(capital), { id: 'petrel-ring-2', file: 'model:petrel-ring', role: CAPITAL.role, minBuilds: 20 },
    'the file keys one container and template; the id names the rank, so a promotion between them refreshes');
  assert.equal(workhorse.model, capital.model, 'one model');
  assert.notEqual(workhorse.model, models.inPlaceOf(SCOUT).model, 'the Scout flies the bare ship');
  assert.equal(models.inPlaceOf(CAPITAL), capital, 'one hull entry per rank');
});

// The fleet is drawn to the yard's scale: a model unit is as long on a Scout as on a Workhorse, and
// the Capital is the Workhorse drawn larger by the step the fleet's hull files take there.
test('the Scout and the Workhorse fly at one scale, and the Capital as much larger as the fleet\'s hull for it', () => {
  const models = load().shipModels;
  const [scout, workhorse, capital] = [SCOUT, WORKHORSE, CAPITAL].map((hull) => models.inPlaceOf(hull));
  assert.ok(near(scout.correction.scale, workhorse.correction.scale, 1e-9), 'the Petrel inside the ring is as long as a Scout');
  assert.ok(near(capital.correction.scale / workhorse.correction.scale, shownLength(CAPITAL) / shownLength(WORKHORSE), 0.01));
  assert.ok(scout.correction.scale < scout.model.correction.scale, 'a Scout is shorter than a fleet unit');
  for (const hull of [workhorse, capital]) assert.deepEqual(hull.correction.offset, hull.model.correction.offset);
});

test('the ringed model is the build the Scout flies with its ring fitted: the variant source.json records', () => {
  const models = load().shipModels;
  assert.deepEqual(fingerprintOf(BABYLON, (scene) => models.inPlaceOf(SCOUT).model.build(scene)), record.geometry);
  assert.deepEqual(fingerprintOf(BABYLON, (scene) => models.inPlaceOf(WORKHORSE).model.build(scene)), record.variants.ring.geometry);
});

test('the ringed ship sits in the fleet frame its correction claims: its ring, its longest side, one unit across, centred', () => {
  onScene((scene, models) => {
    const ringed = models.inPlaceOf(WORKHORSE).model;
    const { scale, offset } = ringed.correction;
    const { min, max, size } = built(scene, ringed);
    assert.ok(size.x > size.z && near(size.x, size.y, 0.01), 'the ring is wider than the hull is long');
    assert.ok(near(size.x * scale, 1, 0.005), `the ring is ${size.x * scale} across`);
    assert.ok(near(((max.z + min.z) / 2 + offset[2]) * scale, 0, 0.005), 'centred along its length');
    assert.ok(near((max.x + min.x) * scale, 0, 0.005) && offset[0] === 0, 'centred across its span');
  });
});

// The scene's triangle budget counts a container's indices, not the fingerprint's meshes.
test('a ringed container holds the triangles the variant records, as one mesh', () => {
  onScene((scene, models) => {
    const held = models.container(scene, models.inPlaceOf(CAPITAL).model);
    assert.equal(held.meshes.length, 1);
    assert.equal(trianglesOf(held.meshes[0]), record.variants.ring.geometry.triangles);
  });
});

// The rail's map paints its lamps in one amber and a darker amber halo around each, and the art
// lights it in an amber tint. Worn, it is read in grey: the frame (which linearizes the map) and
// the glow pass (which reads it as stored) both show the ship color wherever it paints, the lamps
// at the level of the tint's brightest channel and the halos as much dimmer as the art paints them.
test('the ring\'s inspection rail shows the ship color on every palette: its lamps, their halos and their glow', () => {
  onScene((scene, models, AUR) => {
    const ringed = models.inPlaceOf(WORKHORSE).model;
    const rail = models.container(scene, ringed).meshes[0].material.subMaterials.find((finish) => finish.name === 'amber inspection rail');
    const { lamps, halos } = ringed.trim['amber inspection rail'];
    const art = readRenderer('ships/petrel/source/surfaces.js');
    assert.ok(art.includes(`'${lamps}'`) && art.includes(`'${HALO}'`), 'the colors the ring paints its lamps and their halos in');
    assert.equal(halos, true);
    const { r, g, b } = rail.emissiveColor;
    assert.ok(r > g && g > b, 'the art lights them in a tint');

    // The art's map, a lamp texel, a halo texel and another lamp texel, read as the grey map is made from it.
    const color = ([red, green, blue]) => BABYLON.Color3.FromInts(red, green, blue);
    const bytes = (hex) => BABYLON.Color3.FromHexString(hex).asArray().map((v) => v * 255).concat(255);
    const image = { data: new Uint8ClampedArray([...bytes(lamps), ...bytes(HALO), ...bytes(lamps)]) };
    Object.assign(rail.emissiveTexture, { getSize: () => ({ width: 3, height: 1 }), getContext: () => ({ getImageData: () => image }) });
    const textures = scene.textures.length;
    const materials = new Map();
    const palettes = palettesOf(AUR);
    // While the copies are made, a new canvas keeps the pixels put on it, and each texture update is noted.
    const events = [];
    class KeptCanvas {
      constructor(width, height) {
        const known = { putImageData: (pixels) => { known.kept = pixels; events.push('put'); } };
        Object.assign(this, { width, height, context: new Proxy(known, { get: (target, key) => (key in target ? target[key] : () => {}), set: () => true }) });
      }
      getContext() { return this.context; }
    }
    const [canvas, { update }] = [globalThis.OffscreenCanvas, BABYLON.DynamicTexture.prototype];
    let worn;
    try {
      globalThis.OffscreenCanvas = KeptCanvas;
      BABYLON.DynamicTexture.prototype.update = function (...args) { events.push('update ' + this.name); return update.apply(this, args); };
      worn = palettes.map(([palette, hex]) => models.material(materials, ringed, palette, hex, rail));
    } finally {
      globalThis.OffscreenCanvas = canvas;
      BABYLON.DynamicTexture.prototype.update = update;
    }
    assert.equal(scene.textures.length, textures + 1, 'one grey map, for every palette');
    assert.deepEqual(events, ['put', 'update amber inspection rail in grey'], 'its pixels put on its canvas, then sent to the GPU');
    assert.ok(worn[0].emissiveTexture.getContext().kept === image, 'the grey map holds the art\'s pixels, read in grey');
    const [lamp, halo] = [image.data.slice(0, 4), image.data.slice(4, 8)];
    for (const texel of [lamp, halo]) assert.ok(texel[0] === texel[1] && texel[1] === texel[2], `${texel} is grey`);
    assert.deepEqual(image.data.slice(8), lamp, 'a color painted twice is the same grey both times');

    const sameHue = (a, b) => a.scale(1 / Math.max(a.r, a.g, a.b)).equalsWithEpsilon(b.scale(1 / Math.max(b.r, b.g, b.b)), 1e-6);
    for (const [i, [palette, hex]] of palettes.entries()) {
      const copy = worn[i];
      assert.ok(copy.emissiveTexture !== rail.emissiveTexture, `${palette}: not on the amber map the art painted`);
      assert.ok(copy.emissiveTexture === worn[0].emissiveTexture, `${palette}: on the one grey map`);
      for (const key of ['level', 'gammaSpace', 'coordinatesIndex', 'wrapU', 'wrapV']) assert.equal(copy.emissiveTexture[key], rail.emissiveTexture[key], key);
      const tint = BABYLON.Color3.FromHexString(hex).toLinearSpace();
      // The frame: the map linearized, times the emissive color.
      const frame = (texel) => color(texel).toLinearSpace().multiply(copy.emissiveColor);
      // The glow pass (scene/system/view.js): the map as stored, times what the glow selector passes,
      // the emissive color at the map's level and the material's intensity.
      const selected = copy.emissiveColor.scale(copy.emissiveTexture.level * copy.emissiveIntensity);
      const glow = (texel) => color(texel).multiply(selected);
      assert.ok(frame(lamp).equalsWithEpsilon(tint.scale(r), 0.01 * r), `${palette}: lamps in the ship color, at the art's level`);
      assert.ok(sameHue(frame(halo), tint), `${palette}: halos in the ship color`);
      const dimmer = BABYLON.Color3.FromHexString(HALO).toLinearSpace().toLuminance() / BABYLON.Color3.FromHexString(lamps).toLinearSpace().toLuminance();
      assert.ok(near(frame(halo).toLuminance() / frame(lamp).toLuminance() / dimmer, 1, 0.03), `${palette}: halos as much dimmer than the lamps as the art paints them`);
      assert.ok(sameHue(glow(lamp), tint) && sameHue(glow(halo), tint), `${palette}: the lamps and halos glow in the ship color as the trim lights do`);
    }
  });
});

test('the nozzles follow the rank\'s size', () => {
  const models = load().shipModels;
  const [scout, workhorse, capital] = [SCOUT, WORKHORSE, CAPITAL].map((hull) => models.inPlaceOf(hull));
  const [bare, small, large] = [scout, workhorse, capital].map((hull) => models.nozzles(hull.id));
  const grows = (from, to, ratio) => from.every((nozzle, i) =>
    nozzle.position.scale(ratio).equalsWithEpsilon(to[i].position, 1e-9) && near(nozzle.radius * ratio, to[i].radius));
  assert.ok(grows(bare, small, workhorse.correction.scale / scout.correction.scale), 'the same stern, at the Workhorse size');
  assert.ok(grows(small, large, capital.correction.scale / workhorse.correction.scale), 'and at the Capital size');
});

test('in a system both ringed ranks of a provider draw from one template, and a promotion between them grows the hull', () =>
  onSystem(async (scene, AUR, fly) => {
    AUR.shipModels.lights(scene);
    const [w, c, s] = [await fly('w', 5), await fly('c', 20), await fly('s', 0)];
    assert.deepEqual([w, c, s].map((root) => root.metadata.assetHullId), ['petrel-ring', 'petrel-ring-2', 'petrel']);
    assert.equal(hullOf(w).sourceMesh, hullOf(c).sourceMesh, 'one template for both ranks');
    assert.notEqual(hullOf(w).sourceMesh, hullOf(s).sourceMesh, 'and another for the Scout');
    const { ships } = AUR.shipAssets.sceneStates.get(scene);
    const sizeOf = (id) => ships.get(id).correction.scaling.x;
    assert.ok(near(sizeOf('c') / sizeOf('w'), shownLength(CAPITAL) / shownLength(WORKHORSE), 0.01));

    const workhorse = sizeOf('w');
    assert.equal(await AUR.ships.refresh(scene, ship('w', 20)), w);
    assert.equal(w.metadata.assetHullId, 'petrel-ring-2');
    assert.ok(near(sizeOf('w'), sizeOf('c')) && sizeOf('w') > workhorse, 'promoted to the Capital size');
    assert.equal(hullOf(w).sourceMesh, hullOf(c).sourceMesh, 'on the same template');
  }));

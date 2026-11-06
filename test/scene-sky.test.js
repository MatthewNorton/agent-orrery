'use strict';

// The sky behind the system and planet views (src/renderer/scene/sky.js): the faces scripts/bake-sky.js
// wrote to assets/skies, checked against their manifest and against the looks and tier sizes the app asks for.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { readRenderer, runRenderer } = require('./support/renderer-source');

const SKIES = path.join(__dirname, '..', 'assets', 'skies');
const manifest = JSON.parse(fs.readFileSync(path.join(SKIES, 'manifest.json'), 'utf8'));
const BUDGET_BYTES = 20 * 1024 * 1024; // every look at every size

/** app/state.js on stubs of the two modules it calls at load. */
function appLayer() {
  const window = { AUR: { ProjectVcsStatus: { FILTERS: { ALL: 'all' } }, worlds: { textures: { create: () => ({}) } } } };
  runRenderer('app/state.js', { window });
  return window.AUR.app;
}

/** Width and height from the extended (VP8X) WebP header that Chromium's encoder writes. */
function webpSize(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 16), 'WEBPVP8X');
  return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
}

test('the manifest has a face for every look Settings offers at every graphics tier size', () => {
  const { const: C, state: S } = appLayer();
  const looks = C.SKY_LOOKS.map((look) => look.key);
  assert.deepEqual(Object.keys(manifest.looks).sort(), [...looks].sort());
  assert.ok(looks.includes(S.skyLook), 'the default look is baked');
  assert.deepEqual(manifest.sizes, C.RENDER_QUALITIES.map((tier) => tier.sky));
  const expected = looks.flatMap((look) => manifest.sizes.flatMap((size) =>
    manifest.faces.map((face) => `${look}/${size}/${face}.webp`)));
  assert.deepEqual(Object.keys(manifest.files).sort(), expected.sort());
});

test('every face is a square WebP of its size, with the bytes and hash the manifest lists', () => {
  for (const [file, entry] of Object.entries(manifest.files)) {
    const bytes = fs.readFileSync(path.join(SKIES, file));
    const size = Number(file.split('/')[1]);
    assert.deepEqual(webpSize(bytes), { width: size, height: size }, file);
    assert.equal(bytes.length, entry.bytes, file);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), entry.sha256, file);
  }
});

test('assets/skies holds only the manifest and its faces, within the size budget', () => {
  const found = fs.readdirSync(SKIES, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
    .map((entry) => path.relative(SKIES, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'));
  assert.deepEqual(found.sort(), ['manifest.json', ...Object.keys(manifest.files)].sort());
  const total = Object.values(manifest.files).reduce((sum, entry) => sum + entry.bytes, 0);
  assert.ok(total <= BUDGET_BYTES, `${total} bytes of faces`);
});

test('the system and planet views draw the baked sky; the universe map keeps its skybox', () => {
  for (const view of ['scene/system/view.js', 'scene/planet/view.js']) {
    const source = readRenderer(view);
    assert.match(source, /AUR\.addSky\(scene, glow, ctx\.skyLook, ctx\.quality\.sky\)/, view);
    assert.doesNotMatch(source, /addSkybox|addStarfield/, view);
  }
  assert.match(readRenderer('scene/universe/view.js'), /AUR\.addSkybox\(/);
});

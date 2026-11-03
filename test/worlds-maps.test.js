'use strict';

// The world-map generator (src/renderer/worlds/noise.js, classes.js, maps.js) and its worker,
// loaded the way the page and worlds/worker.js load them: classic scripts extending self.AUR.worlds.

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { readRenderer } = require('./support/renderer-source');

const PURE = ['noise.js', 'classes.js', 'maps.js'];

// In this realm, so typed arrays compare with assert; window and document are absent, as in a worker.
function load(scope, file, edit = (code) => code) {
  vm.runInThisContext(`(function (self, window, document) {\n${edit(readRenderer(`worlds/${file}`))}\n})`, { filename: file })(scope, undefined, undefined);
}
function loadWorlds(edits = {}) {
  const scope = {};
  for (const file of PURE) load(scope, file, edits[file]);
  return scope.AUR.worlds;
}

// Seeds and palettes of five synthetic-profile planets (AUR.worldProfile).
const PLANETS = {
  rocky: { seed: 1019766990, hue: 0.02, palette: ['#171a20', '#55504a', '#a89072'] },
  gas: { seed: 2209617148, hue: 0.04, palette: ['#30253f', '#b66d51', '#e8c99f'] },
  ice: { seed: 878832591, hue: 0.02, palette: ['#15283a', '#6595ac', '#d9eef1'] },
  volcanic: { seed: 3084078934, hue: -0.04, palette: ['#100e0d', '#4b2920', '#f06b32'] },
  oceanic: { seed: 2238529249, hue: -0.08, palette: ['#071b35', '#17617a', '#b7cab8'] },
};
const CLASSES = Object.keys(PLANETS);
const job = (cls, width, height, extra) => ({ cls, ...PLANETS[cls], width, height, rings: false, ...extra });

const worlds = loadWorlds();
const maps256 = new Map(CLASSES.map((cls) => [cls, worlds.generate(job(cls, 256, 128, { rings: cls === 'gas' }))]));

// Mean RGB step across the seam and along the pole rows, relative to typical neighbour steps.
function neighbourRatios({ width: w, height: h, surface: s }) {
  const diff = (a, b) => (Math.abs(s[a] - s[b]) + Math.abs(s[a + 1] - s[b + 1]) + Math.abs(s[a + 2] - s[b + 2])) / 3;
  const px = (x, y) => (y * w + x) * 4;
  let interior = 0, seam = 0, pole = 0, equator = 0;
  for (let y = 0; y < h; y++) {
    seam += diff(px(0, y), px(w - 1, y));
    for (let x = 0; x < w - 1; x++) interior += diff(px(x, y), px(x + 1, y));
  }
  for (let x = 0; x < w - 1; x++) {
    pole += (diff(px(x, 0), px(x + 1, 0)) + diff(px(x, h - 1), px(x + 1, h - 1))) / 2;
    equator += diff(px(x, h >> 1), px(x + 1, h >> 1));
  }
  return { seam: seam / h / (interior / (h * (w - 1)) || 1), pole: pole / (equator || 1) };
}

function coverage(out) {
  const pixels = out.width * out.height, e = out.emission;
  let lit = 0, water = 0;
  for (let i = 0; i < pixels; i++) {
    if (e[i * 4] || e[i * 4 + 1] || e[i * 4 + 2]) lit++;
    if (e[i * 4 + 3] > 128) water++;
  }
  return { lit: lit / pixels, water: water / pixels };
}

test('the same job gives byte-identical maps, and the seed decides the world', () => {
  for (const cls of CLASSES) {
    const first = worlds.generate(job(cls, 64, 32));
    const again = loadWorlds().generate(job(cls, 64, 32));
    for (const key of ['surface', 'emission', 'clouds']) assert.deepEqual(first[key], again[key], `${cls} ${key}`);
    const other = worlds.generate(job(cls, 64, 32, { seed: PLANETS[cls].seed ^ 0x51 }));
    assert.notDeepEqual(first.surface, other.surface, `${cls} ignores its seed`);
  }
});

test('sizes outside 2 × 2 to 2048 × 1024 and unknown classes throw a RangeError', () => {
  for (const [width, height] of [[0, 0], [1, 1], [4096, 2048], [2049, 1024], [2048, 1025], [100.5, 50], [64, NaN]]) {
    assert.throws(() => worlds.generate(job('rocky', width, height)), RangeError, `${width} × ${height}`);
  }
  assert.throws(() => worlds.generate(job('rocky', 8, 4, { cls: 'lava-lamp' })), RangeError);
  assert.equal(worlds.generate(job('rocky', 2, 2)).surface.length, 16);
});

test('maps wrap at the seam and do not pinch at the poles', () => {
  for (const cls of CLASSES) {
    const { seam, pole } = neighbourRatios(maps256.get(cls));
    assert.ok(seam <= 1.6, `${cls} seam ratio ${seam.toFixed(2)}`);
    assert.ok(pole <= 0.08, `${cls} pole ratio ${pole.toFixed(3)}`);
  }
});

test('each class carries only its own layers', () => {
  for (const cls of CLASSES) {
    const out = maps256.get(cls);
    const { lit, water } = coverage(out);
    assert.equal(out.surface.length, 256 * 128 * 4);
    assert.equal(Boolean(out.clouds), cls === 'oceanic', `${cls} clouds`);
    assert.equal(Boolean(out.rings), cls === 'gas', `${cls} rings`);
    if (cls === 'rocky' || cls === 'gas' || cls === 'ice') assert.equal(lit, 0, `${cls} emits light`);
    if (cls === 'volcanic') assert.ok(lit > 0.02 && lit < 0.35, `volcanic lava covers ${lit}`);
    if (cls === 'oceanic') {
      assert.ok(water > 0.35 && water < 0.85, `oceanic water covers ${water}`);
      assert.ok(lit > 0.002 && lit < 0.1, `oceanic lights cover ${lit}`);
    }
  }
  const rings = maps256.get('gas').rings;
  assert.equal(rings.length, 1024 * 4);
  let gap = 255;
  for (let i = 307; i < 717; i++) gap = Math.min(gap, rings[i * 4 + 3]);
  assert.ok(gap < 10, 'the rings have a gap between 30 % and 70 % of their width');
  assert.equal(worlds.generate(job('rocky', 16, 8, { rings: true })).rings.length, 1024 * 4);
});

test('the ice lineae prefilter skips no pixel a linea paints', () => {
  const PREFILTER = 'if (dot < l.lo || dot > l.hi) continue;';
  const unfiltered = loadWorlds({
    'classes.js': (code) => {
      assert.ok(code.includes(PREFILTER), 'the prefilter line changed; update this test');
      return code.replace(PREFILTER, '');
    },
  });
  for (const seed of [PLANETS.ice.seed, 1, 3]) {
    const ice = job('ice', 512, 256, { seed });
    const a = worlds.generate(ice).surface, b = unfiltered.generate(ice).surface;
    let differing = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differing++;
    assert.equal(differing, 0, `seed ${seed}: the warp carries lineae past the prefilter window`);
  }
});

test('run() leaves out an emission layer that is all zero', () => {
  const reply = (cls) => worlds.run({ ...job(cls, 64, 32), key: cls });
  for (const cls of ['rocky', 'gas']) assert.equal(reply(cls).emission, null, `${cls} has no emission layer`);
  for (const cls of ['ice', 'volcanic', 'oceanic']) assert.ok(reply(cls).emission, `${cls} keeps its emission layer`);
});

test('the worker builds a job and transfers its buffers back', () => {
  const posted = [];
  const scope = {
    importScripts: (...files) => files.forEach((file) => load(scope, file)),
    postMessage: (message, transfer) => posted.push({ message, transfer }),
  };
  load(scope, 'worker.js');
  scope.onmessage({ data: { ...job('oceanic', 32, 16), key: 'oceanic:1:32' } });
  scope.onmessage({ data: { ...job('rocky', 4096, 16), key: 'too-wide' } });
  const [done, failed] = posted;
  assert.equal(done.message.key, 'oceanic:1:32');
  assert.equal(done.message.ok, true);
  assert.deepEqual(done.message.surface, worlds.generate(job('oceanic', 32, 16)).surface);
  const buffers = [done.message.surface, done.message.emission, done.message.clouds].map((layer) => layer.buffer);
  assert.equal(done.transfer.length, buffers.length);
  for (const buffer of buffers) assert.ok(done.transfer.includes(buffer), 'every layer is transferred');
  assert.deepEqual({ key: failed.message.key, ok: failed.message.ok, transfer: failed.transfer }, { key: 'too-wide', ok: false, transfer: [] });
  assert.match(failed.message.error, /2048/);
});

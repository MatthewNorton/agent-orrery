'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { fnv1a, hex8, mulberry32 } = require('../src/main/shared/hash');

// util.js is hash-pinned, so it keeps its own copy; the renderer seeds from it.
function loadRendererUtil() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'util.js'), 'utf8');
  const sandbox = { window: {} };
  vm.runInNewContext(source, sandbox, { filename: 'util.js' });
  return sandbox.window.AUR;
}

const SAMPLES = [
  '', 'a', 'C--workspace-demo', 'project:0badc0de', 'src', 'Sector-1',
  'C--workspace-demoSector-2', 'unicode ünïcödé ☄ 𝔘', 'x'.repeat(1000),
];

test('fnv1a matches known FNV-1a 32-bit values', () => {
  assert.equal(fnv1a(''), 0x811c9dc5);
  assert.equal(fnv1a('a'), 0xe40c292c);
  assert.equal(fnv1a('foobar'), 0xbf9cf968);
  assert.equal(hex8('a'), 'e40c292c');
  assert.equal(hex8(''), '811c9dc5');
});

test('the renderer copy of fnv1a agrees with the main process', () => {
  const AUR = loadRendererUtil();
  for (const sample of SAMPLES) assert.equal(AUR.fnv1a(sample), fnv1a(sample), JSON.stringify(sample));
});

test('the renderer copy of mulberry32 draws the same sequence', () => {
  const AUR = loadRendererUtil();
  for (const seed of [0, 1, 0x811c9dc5, fnv1a('C--workspace-demo'), 2 ** 32 - 1, -1, 12.75]) {
    const main = mulberry32(seed);
    const renderer = AUR.mulberry32(seed);
    for (let draw = 0; draw < 32; draw++) assert.equal(renderer(), main(), `seed ${seed}, draw ${draw}`);
  }
});

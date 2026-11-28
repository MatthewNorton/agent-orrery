'use strict';

// scripts/import-ship.mjs run on source folders made here: what it refuses of a ship built on
// another's modules. Every run only checks, and each refusal comes before anything is written.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'import-ship.mjs');

/** What the script says when it refuses a Breakwater source of `files`, each named by its path from the yard's folder. */
function refusal(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-ship-test-'));
  try {
    for (const [file, text] of Object.entries(files)) {
      const to = path.join(dir, 'yard', file);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, text);
    }
    const run = spawnSync(process.execPath, [SCRIPT, 'breakwater', path.join(dir, 'yard'), '--check'], { encoding: 'utf8' });
    assert.equal(run.status, 1, run.stdout + run.stderr);
    return run.stderr;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a module that is not there is named, with the module that imports it', () => {
  assert.match(refusal({ 'yard.js': "import { hull } from '../one/hull.js';\n" }), /There is no \S+one[\\/]hull\.js, which yard\.js imports\./);
  assert.match(refusal({ 'berth.js': 'export const berths = 4;\n' }), /There is no \S+yard\.js, which the ship starts from\./);
});

test('a ship that borrows one ship\'s modules may import from one folder beside its own', () => {
  const said = refusal({
    'yard.js': "import { hull } from '../one/hull.js';\nimport { ring } from '../two/ring.js';\n",
    '../one/hull.js': 'export const hull = 1;\n',
    '../two/ring.js': 'export const ring = 2;\n',
  });
  assert.match(said, /borrows one ship's modules, and its imports reach into \.\.\/one and \.\.\/two\./);
});

test('a borrowed module that is not the one its ship was converted from is refused, by its folder', () => {
  const said = refusal({
    'yard.js': "import { createPetrel } from '../one/spacecraft.js';\n",
    '../one/spacecraft.js': 'export const createPetrel = () => null;\n',
  });
  assert.match(said, /\.\.\/one\/spacecraft\.js is not the spacecraft module Petrel was converted from\. Breakwater borrows only Petrel's modules: if \.\.\/one is that ship's folder, import petrel from this source first\./);
});

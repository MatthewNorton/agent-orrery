'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

function loadAUR() {
  const sandbox = { window: {} };
  for (const file of ['util.js', 'procedural-worlds.js']) {
    const source = fs.readFileSync(path.join(root, 'src/renderer', file), 'utf8');
    vm.runInNewContext(source, sandbox);
  }
  return sandbox.window.AUR;
}

test('planet 31 exposes its albedo and bump assets', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'assets/manifest.json'), 'utf8'));
  const asset = manifest.assets.find((entry) => entry.id === 'planet-031');

  assert.equal(asset.file, 'planet-031.png');
  assert.equal(asset.bumpFile, 'planet-031-bump.png');
  assert.equal(asset.normalFile, 'planet-031-normal.png');
  assert.ok(fs.existsSync(path.join(root, 'assets/planets', asset.file)));
  assert.ok(fs.existsSync(path.join(root, 'assets/planets', asset.bumpFile)));
  assert.ok(fs.existsSync(path.join(root, 'assets/planets', asset.normalFile)));
});

test('planet texture selection activates bump mapping only for planet 31', () => {
  const AUR = loadAUR();
  let selectedName = null;

  for (let i = 0; i < 500; i += 1) {
    const name = `test-planet-${i}`;
    if (AUR.planetTextureIndex('test-project', name) === 31) {
      selectedName = name;
      break;
    }
  }

  assert.ok(selectedName, 'expected a deterministic name that selects planet 31');
  assert.match(AUR.planetTexPath('test-project', selectedName), /planet-031\.png$/);
  assert.match(AUR.planetBumpPath('test-project', selectedName), /planet-031-bump\.png$/);
  assert.equal(AUR.planetBumpPath('test-project', 'ordinary-planet'), null);
});

test('runtime planet generation is deterministic and spans distinct world classes', () => {
  const AUR = loadAUR();
  const first = AUR.proceduralPlanetData('runtime-project', 'alpha', 96);
  const repeat = AUR.proceduralPlanetData('runtime-project', 'alpha', 96);
  const types = new Set();

  assert.equal(first.width, 96);
  assert.equal(first.height, 96);
  assert.deepEqual(Array.from(first.pixels), Array.from(repeat.pixels));
  assert.deepEqual(Array.from(first.heights), Array.from(repeat.heights));
  for (let i = 0; i < 80; i += 1) {
    types.add(AUR.worldProfile('runtime-project', `world-${i}`).key);
  }
  assert.deepEqual([...types].sort(), ['gas', 'ice', 'oceanic', 'rocky', 'volcanic']);
});

test('solar systems build three deformed asteroid forms with nonuniform instances', () => {
  const source = fs.readFileSync(path.join(root, 'src/renderer/scene-system.js'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'assets/manifest.json'), 'utf8'));
  const asteroids = manifest.assets.filter((entry) => entry.type === 'asteroid');

  assert.match(source, /AUR\.createAsteroidMesh/);
  assert.match(source, /AUR\.applyAsteroidSurface/);
  assert.match(source, /const variants = \[/);
  assert.match(source, /new BABYLON\.Vector3\(s \* stretch, s \* \(0\.78 \+ rand\(\) \* 0\.42\), s \/ Math\.sqrt\(stretch\)\)/);
  assert.equal(asteroids.length, 3);
  for (const asset of asteroids) {
    assert.ok(fs.existsSync(path.join(root, 'assets/asteroids', asset.file)));
    assert.ok(fs.existsSync(path.join(root, 'assets/asteroids', asset.bumpFile)));
    assert.ok(fs.existsSync(path.join(root, 'assets/asteroids', asset.normalFile)));
  }
});

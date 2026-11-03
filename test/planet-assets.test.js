'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { rendererSource } = require('./support/renderer-source');

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

test('world profiles are deterministic and span every world class', () => {
  const AUR = loadAUR();
  const types = new Set();

  const profile = (aur) => JSON.stringify(aur.worldProfile('runtime-project', 'alpha')); // two vm realms
  assert.equal(profile(AUR), profile(loadAUR()));
  for (let i = 0; i < 80; i += 1) {
    types.add(AUR.worldProfile('runtime-project', `world-${i}`).key);
  }
  assert.deepEqual([...types].sort(), ['gas', 'ice', 'oceanic', 'rocky', 'volcanic']);
});

test('planets no longer load the PNG surfaces (kit 15 D1)', () => {
  const AUR = loadAUR();
  for (const name of ['applyPlanetSurface', 'proceduralPlanetData', 'planetTexPath', 'planetBumpPath']) {
    assert.equal(AUR[name], undefined, `AUR.${name}`);
  }
  assert.doesNotMatch(rendererSource('.', (file) => /\.(js|html)$/.test(file)), /assets\/planets/);
});

test('solar systems build three deformed asteroid forms with nonuniform instances', () => {
  const source = rendererSource('scene/system');
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

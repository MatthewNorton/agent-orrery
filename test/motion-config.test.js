'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadMotionConfig() {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'util.js'),
    'utf8'
  );
  const sandbox = { window: {} };
  vm.runInNewContext(source, sandbox, { filename: 'util.js' });
  return sandbox.window.AUR.MOTION;
}

test('planet motion remains independent from comfort-tuned ship motion', () => {
  const motion = loadMotionConfig();

  assert.ok(motion.universePlanetOrbitMin > motion.universeShipOrbitMin * 5);
  assert.ok(motion.systemPlanetOrbitMin > motion.systemShipOrbitMin * 3);
  assert.ok(motion.systemPlanetAxialMin > motion.systemPlanetOrbitMin);
  assert.equal(motion.planetDetailAxialRotation, 0.04);
});

test('planet scenes consume the dedicated planet motion settings', () => {
  const readRenderer = (name) => fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', name),
    'utf8'
  );

  const universe = readRenderer('scene/universe/view.js');
  const system = readRenderer('scene/system/view.js');
  const planet = readRenderer('scene/planet.js');

  assert.match(universe, /AUR\.MOTION\.universePlanetOrbitMin/);
  assert.match(system, /AUR\.MOTION\.systemPlanetOrbitMin/);
  assert.match(system, /p\.mesh\.rotation\.y \+= dt \* p\.axialSpeed/);
  assert.match(planet, /AUR\.MOTION\.planetDetailAxialRotation/);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readRenderer } = require('./support/renderer-source');

function loadMotionConfig() {
  const sandbox = { window: {} };
  vm.runInNewContext(readRenderer('util.js'), sandbox, { filename: 'util.js' });
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
  const universe = readRenderer('scene/universe/view.js');
  const system = readRenderer('scene/system/view.js');
  const planet = readRenderer('scene/planet/view.js');

  assert.match(universe, /AUR\.MOTION\.universePlanetOrbitMin/);
  assert.match(system, /AUR\.MOTION\.systemPlanetOrbitMin/);
  assert.match(system, /p\.mesh\.rotation\.y \+= dt \* p\.axialSpeed/);
  assert.match(planet, /AUR\.MOTION\.planetDetailAxialRotation/);
});

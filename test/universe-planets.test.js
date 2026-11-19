'use strict';

// src/main/universe/planets.js: the system shape live and history share, and the stand-in planets.

const test = require('node:test');
const assert = require('node:assert/strict');
const { isStandInName, proceduralSystem, systemData } = require('../src/main/universe/planets');

const project = { id: 'p', name: 'demo' };
const planets = (count) => Array.from({ length: count }, (_, index) => ({ name: 'dir' + index, files: count - index, builds: 0 }));

test('systemData: the first eight planets, and of how many once there are more', () => {
  assert.deepEqual(systemData(project, planets(3), 4), { project, planets: planets(3), beltDensity: 4 });
  const eight = systemData(project, planets(8), 0);
  assert.deepEqual([eight.planets.length, 'planetTotal' in eight], [8, false]);
  const many = systemData(project, planets(12), 0);
  assert.deepEqual(many, { project, planets: planets(12).slice(0, 8), beltDensity: 0, planetTotal: 12 });

  const given = planets(12);
  systemData(project, given, 0);
  assert.equal(given.length, 12, 'the list it was given is left whole');
});

test('proceduralSystem: three to six stand-in planets, the same for the same project', () => {
  for (const id of ['a', 'b', 'project-with-a-longer-id']) {
    const system = proceduralSystem(id);
    assert.ok(system.planets.length >= 3 && system.planets.length <= 6, id);
    assert.deepEqual(proceduralSystem(id), system);
    system.planets.forEach((planet, index) => {
      assert.deepEqual([planet.name, planet.builds, planet.procedural], [`Sector-${index + 1}`, 0, true]);
      assert.equal(isStandInName(planet.name), true);
    });
  }
  for (const name of ['src', 'sector-1', '(root)', 'my-Sector-1']) assert.equal(isStandInName(name), false, name);
});

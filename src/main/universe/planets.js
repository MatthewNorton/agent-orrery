// @ts-check
'use strict';

const { fnv1a, mulberry32 } = require('../shared/hash');
const { planetKey } = require('../build-buckets');

/** @import { Planet, Project, SystemData } from '../../types/contract' */

// The system view draws a project's biggest planets, at most this many.
const SYSTEM_PLANETS = 8;
// What proceduralSystem names its stand-in planets.
const STAND_IN = 'Sector-';
/** @param {string} name */
const isStandInName = (name) => name.startsWith(STAND_IN);

/**
 * A system's public shape, live and history alike: its planets cut to the ones the view draws, each
 * with the key it is compared by, and `planetTotal` when it has more.
 * @param {Project} project @param {Omit<Planet, 'key'>[]} planets biggest first @param {number} beltDensity
 * @returns {SystemData}
 */
function systemData(project, planets, beltDensity) {
  const drawn = planets.slice(0, SYSTEM_PLANETS).map((planet) => ({ ...planet, key: planetKey(project, planet.name) }));
  const data = { project, planets: drawn, beltDensity };
  return planets.length > SYSTEM_PLANETS ? { ...data, planetTotal: planets.length } : data;
}

/**
 * Stand-in planets and asteroid belt for a project with no folders to show. The same
 * project id always gets the same system, in live and history alike.
 * @param {string} projectId
 * @returns {{ planets: { name: string, files: number, builds: number, procedural: true }[], beltDensity: number }}
 */
function proceduralSystem(projectId) {
  const rand = mulberry32(fnv1a(projectId));
  const count = 3 + Math.floor(rand() * 4);
  const planets = [];
  for (let index = 0; index < count; index++) {
    planets.push({
      name: STAND_IN + (index + 1),
      files: 5 + Math.floor(rand() * 120),
      builds: 0,
      procedural: /** @type {true} */ (true),
    });
  }
  return { planets, beltDensity: Math.floor(rand() * 40) };
}

module.exports = { isStandInName, proceduralSystem, systemData };

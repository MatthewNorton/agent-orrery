// @ts-check
'use strict';

const { fnv1a, mulberry32 } = require('../shared/hash');

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
      name: `Sector-${index + 1}`,
      files: 5 + Math.floor(rand() * 120),
      builds: 0,
      procedural: /** @type {true} */ (true),
    });
  }
  return { planets, beltDensity: Math.floor(rand() * 40) };
}

module.exports = { proceduralSystem };

'use strict';

// galaxy-layout.js scatters a galaxy's systems through its disc: a seeded spot each, clear of the
// others, loosely core to rim by recency, never lined up along the arms.
const test = require('node:test');
const assert = require('node:assert/strict');
const GALAXY = require('../src/renderer/galaxy-layout.js');

// n projects in one galaxy, proj-0 the most recently active.
const galaxyOf = (n) => Array.from({ length: n }, (_, i) => ({
  id: 'proj-' + i, seed: Math.imul(i + 7, 2654435761) >>> 0, lastActivity: n - i,
  galaxy: { key: 'workspace:g' + n, label: 'G' + n },
}));
const radiusOf = (p) => Math.hypot(p.localX, p.localZ);
const byRecency = (projects) => projects.slice().sort((a, b) => Number(a.id.slice(5)) - Number(b.id.slice(5)));

test('a lone system sits at the centre', () => {
  const [project] = GALAXY.layoutGalaxyProjects(galaxyOf(1)).projects;
  assert.equal(radiusOf(project), 0);
});

test('systems scatter through the disc, a spacing apart and inside the rim', () => {
  for (const n of [2, 8, 24, 60]) {
    const projects = galaxyOf(n);
    const layout = GALAXY.layoutGalaxyProjects(projects);
    assert.deepEqual(GALAXY.layoutGalaxyProjects(projects.slice().reverse()), layout);
    const [galaxy] = layout.galaxies;
    for (const [i, a] of layout.projects.entries()) {
      assert.ok(radiusOf(a) <= galaxy.radius - 10 + 1e-9, `${n}: ${a.id} reaches the rim`);
      for (const b of layout.projects.slice(i + 1)) {
        const gap = Math.hypot(a.localX - b.localX, a.localZ - b.localZ);
        assert.ok(gap >= 14, `${n}: ${a.id} and ${b.id} are ${gap.toFixed(1)} apart`);
      }
    }
  }
});

test('recent systems lean toward the core without lining the arms', () => {
  const layout = GALAXY.layoutGalaxyProjects(galaxyOf(60));
  const ranked = byRecency(layout.projects);
  const mean = (list) => list.reduce((sum, p) => sum + radiusOf(p), 0) / list.length;
  assert.ok(mean(ranked.slice(0, 30)) < mean(ranked.slice(30)) * 0.75);
  // The galaxy's arms twist out from its phase (3 radians across its radius); a third of the
  // systems sit more than a quarter of the way to the next arm.
  const { arms, phase, radius } = layout.galaxies[0].spiral;
  const between = 2 * Math.PI / arms;
  const offArm = ranked.filter((p) => {
    const offset = Math.atan2(p.localZ, p.localX) - phase - (radiusOf(p) / radius) * 3;
    const fromArm = ((offset % between) + between) % between;
    return Math.min(fromArm, between - fromArm) > between / 4;
  });
  assert.ok(offArm.length >= 20, `${offArm.length} of 60 systems off the arms`);
});

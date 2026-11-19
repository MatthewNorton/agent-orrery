'use strict';

// src/renderer/app/store.js: what a build event changes for the open planet.

const test = require('node:test');
const assert = require('node:assert/strict');
const { runRenderer } = require('./support/renderer-source');
const { bucketKey } = require('../src/main/build-buckets');

function setup(projectPath, planetName) {
  const window = {};
  runRenderer('util.js', { window, document: {} });
  const planet = { name: planetName, builds: 0 };
  const refreshed = [];
  const state = {
    store: { projects: new Map([['p', { id: 'p', path: projectPath, totalBuilds: 0 }]]), ships: new Map(), feed: [], buildHistogram: null },
    current: { view: 'planet', projectId: 'p', planetName },
  };
  window.AUR.app = {
    state, const: {},
    activePlanetData: () => planet,
    refreshPlanetSystem: () => refreshed.push(state.store.projects.get('p').totalBuilds),
  };
  runRenderer('app/store.js', { window });
  const build = (bucket, more = {}) => window.AUR.app.applyEvent({ type: 'build', project: 'p', bucket, shipId: 's', isNew: false, ts: 1, ...more });
  return { AUR: window.AUR, state, planet, refreshed, build };
}

test('store: under a Windows path a build counts on the open planet in any casing of its folder', () => {
  const { state, planet, build } = setup('C:\\work\\demo', 'Docs');
  for (const bucket of ['Docs', 'docs', 'DOCS']) build(bucket);
  build('src');
  build('Docs', { project: 'other' });
  assert.deepEqual([planet.builds, state.store.projects.get('p').totalBuilds], [3, 4]);
});

test('store: under a POSIX path a folder in another casing is another planet', () => {
  const { planet, build } = setup('/work/demo', 'Docs');
  for (const bucket of ['Docs', 'docs', 'DOCS']) build(bucket);
  assert.equal(planet.builds, 1);
});

test('store: a build that starts a planet asks for the open planet\'s system again', () => {
  const { refreshed, build } = setup('/work/demo', 'src');
  build('src');
  build('docs', { isNew: true });
  build('lib', { isNew: true, project: 'other' });
  assert.deepEqual(refreshed, [2]);
});

test('the renderer\'s folderKey (util.js) matches the buckets main keeps (build-buckets.js)', () => {
  const { AUR } = setup(null, 'src');
  for (const root of ['C:\\Work\\Demo', 'c:/work/demo', 'relative\\dir', '/work/demo', null]) {
    for (const [saved, asked] of [['Docs', 'docs'], ['docs', 'DOCS'], ['Docs', 'Docs'], ['src', 'Src2'], ['(root)', '(root)']]) {
      const same = bucketKey({ path: root, buckets: { [saved]: 1 } }, asked) !== null;
      assert.equal(AUR.folderKey(root, saved) === AUR.folderKey(root, asked), same, `${root}: ${saved} / ${asked}`);
    }
  }
});

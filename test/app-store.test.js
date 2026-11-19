'use strict';

// src/renderer/app/store.js: what a build event changes for the open planet.

const test = require('node:test');
const assert = require('node:assert/strict');
const { runApp } = require('./support/renderer-source');

// The open planet is `key`; build(key) sends a build that main gave that key.
function setup(key) {
  const planet = { name: 'Docs', key, builds: 0 };
  const refreshed = [];
  const state = {
    store: { projects: new Map([['p', { id: 'p', path: null, totalBuilds: 0 }]]), ships: new Map(), feed: [], buildHistogram: null },
    current: { view: 'planet', projectId: 'p', planetName: planet.name },
  };
  const app = runApp(['app/store.js'], {
    state, const: {},
    activePlanetData: () => (state.current.view === 'planet' ? planet : null),
    refreshPlanetSystem: (projectId) => refreshed.push(projectId),
  }).app;
  const build = (eventKey, more = {}) => app.applyEvent({ type: 'build', project: 'p', bucket: 'as-written', key: eventKey, shipId: 's', isNew: false, ts: 1, ...more });
  return { state, planet, refreshed, build };
}

test('store: a build counts on the open planet when it carries the planet\'s key, and only then', () => {
  const { state, planet, build } = setup('docs');
  // Main gives one key to every casing it counts as the folder; the renderer reads nothing into it.
  build('docs', { bucket: 'Docs' });
  build('docs', { bucket: 'DOCS' });
  build('Docs', { bucket: 'Docs' });
  build('src');
  build('docs', { project: 'other' });
  assert.deepEqual([planet.builds, state.store.projects.get('p').totalBuilds], [2, 4]);
});

test('store: every build that starts a planet is passed on with its project, for a planet card to follow', () => {
  const { state, refreshed, build } = setup('src');
  build('src');
  build('docs', { isNew: true });
  build('lib', { isNew: true, project: 'other' });
  // No planet is open yet (one may be opening): the card's own code decides what the build means.
  state.current.view = 'system';
  build('web', { isNew: true });
  assert.deepEqual(refreshed, ['p', 'other', 'p']);
});

'use strict';

// src/renderer/app/boot.js A.setView, under the routes of app/route.js: a view takes the place of
// the one shown, and its route becomes the app's, once it is built. A system or planet view that
// cannot be built falls back to the universe; a universe that cannot be built leaves the view
// shown, its route and the page as they were.

const assert = require('node:assert/strict');
const test = require('node:test');
const { runRenderer } = require('./support/renderer-source');

// boot.js without its last statement, which boots the page.
function withoutBoot(code) {
  const kept = code.replace(/\n {2}boot\(\)\.catch\([^]*?\n {2}\}\);\n/, '\n');
  assert.notEqual(kept, code, 'the boot call was found');
  return kept;
}

// The app with the system view of project p shown. The helpers setView calls once a view is built
// are noted in `calls`; `logged` holds what AUR.log was given.
function loadApp() {
  const window = { AU: {} }, document = { body: { dataset: { view: 'system' } } };
  const logged = [], calls = [];
  runRenderer('util.js', { window, document });
  Object.assign(window.AUR, { log: (...args) => logged.push(args.join(' ')), ships: { dispose() {} } });
  runRenderer('scene/common.js', { window, document });
  const old = { scene: { name: 'old' }, disposed: 0, dispose() { this.disposed++; } };
  const state = {
    engine: { scenes: [] }, activeView: old, activeScene: old.scene, current: { view: 'system', projectId: 'p', planetName: null },
    store: {}, agentFocus: { shipId: null }, planetSystem: {}, routeRequestGeneration: 0, streamEpoch: 1, retiredEpochs: new Set(),
  };
  const note = (name) => (...args) => { calls.push([name, ...args]); };
  window.AUR.app = {
    state, const: { CHROME: {} },
    clearProjectSearch: note('clearProjectSearch'), exitAgentFocus: note('exitAgentFocus'), stopTasksView: note('stopTasksView'),
    renderChrome: note('renderChrome'), startTasksView: note('startTasksView'), refreshProjectSearchFromStore: note('refreshProjectSearch'),
    requestPlanetSystem: async () => null, planetSystemOpened() {},
  };
  for (const file of ['app/replay.js', 'app/route.js']) runRenderer(file, { window, document });
  runRenderer('app/boot.js', { window, document }, withoutBoot);
  window.AU.getSystem = async (id) => ({ project: { id }, planets: [] });
  window.AU.getPlanet = async (id) => ({ name: 'Src', project: { id } });
  return { AUR: window.AUR, app: window.AUR.app, state, old, calls, logged, document };
}

test('setView: when no view can be built, the one shown and its route stay, whichever route asked', async () => {
  const { AUR, app, state, old, calls, logged, document } = loadApp();
  const failing = (engine) => {
    const half = { dispose: () => engine.scenes.splice(engine.scenes.indexOf(half), 1) };
    engine.scenes.push(half);
    throw new Error('no glyphs');
  };
  Object.assign(AUR.views, { universe: failing, system: failing, planet: failing });
  app.showUniverse();
  await app.openSystem('q');
  await app.openPlanet('q', 'src');
  assert.deepEqual([state.current, state.activeView, old.disposed, document.body.dataset.view, state.engine.scenes, calls],
    [{ view: 'system', projectId: 'p', planetName: null }, old, 0, 'system', [], []]);
  // A route whose view fails falls back to the universe, which fails here too.
  assert.deepEqual(logged.map((line) => line.split(':')[1]), [' universe no glyphs', ' system no glyphs', ' universe no glyphs', ' planet no glyphs', ' universe no glyphs']);
});

test('setView: a system or planet view that cannot be built falls back to the universe', async () => {
  for (const failing of ['system', 'planet']) {
    const { AUR, app, state, old, logged, document } = loadApp();
    const built = (name) => () => ({ scene: { name }, update() {}, dispose() {} });
    Object.assign(AUR.views, { universe: built('universe'), system: built('system'), planet: built('planet') });
    AUR.views[failing] = () => { throw new Error('no glyphs'); };
    await (failing === 'system' ? app.openSystem('q') : app.openPlanet('q', 'src'));
    assert.deepEqual([state.current, state.activeScene.name, old.disposed, document.body.dataset.view, logged],
      [{ view: 'universe', projectId: null, planetName: null }, 'universe', 1, 'universe', [`view build failed: ${failing} no glyphs`]], failing);
  }
});

test('setView: a view that is built takes the place of the one shown, and only then its route', async () => {
  const { AUR, app, state, old, calls, document } = loadApp();
  const routes = [];
  const built = (name) => (engine, data) => {
    routes.push({ ...state.current }); // what the app says is shown while the view is built
    return { scene: { name, data }, update() {}, dispose() {} };
  };
  Object.assign(AUR.views, { universe: built('universe'), system: built('system'), planet: built('planet') });
  await app.openSystem('q');
  assert.deepEqual([state.current, state.activeScene.name, old.disposed, document.body.dataset.view],
    [{ view: 'system', projectId: 'q', planetName: null }, 'system', 1, 'system']);
  assert.deepEqual(calls.filter(([name]) => name === 'startTasksView'), [['startTasksView', 'q']], 'the task panel opens for the system now shown');
  // Main answers with the planet's name as the system view draws it.
  await app.openPlanet('q', 'src');
  assert.deepEqual(state.current, { view: 'planet', projectId: 'q', planetName: 'Src' });
  app.showUniverse();
  assert.deepEqual([state.current, document.body.dataset.view], [{ view: 'universe', projectId: null, planetName: null }, 'universe']);
  assert.deepEqual(routes, [
    { view: 'system', projectId: 'p', planetName: null },
    { view: 'system', projectId: 'q', planetName: null },
    { view: 'planet', projectId: 'q', planetName: 'Src' },
  ]);
});

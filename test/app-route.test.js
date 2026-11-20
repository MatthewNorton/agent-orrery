'use strict';

// The routes (src/renderer/app/route.js): the system a route opens comes through AUR.fetchSystem,
// whatever main answers, and the views main asks for in shots mode (kit/SPEC.md §8).

const test = require('node:test');
const assert = require('node:assert/strict');
const { runApp } = require('./support/renderer-source');

// The routes in stream 1 over a stand-in for boot.js's A.setView, which records the view it is
// asked for and the system or planet it is given, and takes its route as setView does once a view
// is built; `logged` holds what AUR.log was given.
function setup(projects = []) {
  const shown = [], logged = [];
  let ready = 0;
  const state = {
    current: { view: 'universe', projectId: null, planetName: null },
    store: { projects: new Map(projects.map((project) => [project.id, project])) },
    routeRequestGeneration: 0, streamEpoch: 1, activeScene: null,
  };
  const window = { AU: { debugReady: () => { ready++; } } };
  const AUR = runApp(['app/replay.js', 'app/route.js'], {
    state, const: { CHROME: {} },
    setView(name, data) {
      shown.push([name, data.system || data.planet || null]);
      Object.assign(state.current, this.viewRoute(name, data));
    },
  }, { window, aur: { log: (...args) => logged.push(args.join(' ')) } });
  return { app: AUR.app, state, window, shown, logged, ready: () => ready };
}

test('route: a system answer without a list of planets is no system, so the universe is shown', async () => {
  const { app, state, window, shown, logged } = setup();
  window.AU.getSystem = async () => ({ project: { id: 'p' }, beltDensity: 0 });
  await app.openSystem('p');
  assert.deepEqual([shown, logged, state.current.view, state.current.projectId],
    [[['universe', null]], ['no system data for p'], 'universe', null]);
});

test('route: a system call that throws is logged with what it threw, then the universe is shown', async () => {
  const { app, window, shown, logged } = setup();
  window.AU.getSystem = async () => { throw new Error('main is away'); };
  await app.openSystem('p');
  assert.deepEqual([shown, logged], [[['universe', null]], ['getSystem err main is away', 'no system data for p']]);
});

test('route: a system opens as main answers it, unless a route or a stream came before the answer', async () => {
  const { app, state, window, shown } = setup();
  const system = { project: { id: 'p' }, planets: [], beltDensity: 0 };
  window.AU.getSystem = async () => system;
  await app.openSystem('p');
  assert.deepEqual([shown, state.current.view, state.current.projectId], [[['system', system]], 'system', 'p']);

  const routed = app.openSystem('q');
  app.showUniverse();
  await routed;
  const streamed = app.openSystem('q');
  state.streamEpoch = 2;
  await streamed;
  assert.deepEqual([shown.slice(1), state.current.projectId], [[['universe', null]], null], 'both answers are dropped');
});

test('route: the debug planet view opens the largest planet of the demo project, and only a planet', async () => {
  const { app, window, ready } = setup([
    { id: 'old', exists: true, lastActivity: 1 },
    { id: 'p', exists: true, lastActivity: 9 },
    { id: 'gone', exists: false, lastActivity: 99 },
  ]);
  const asked = [], opened = [];
  const planets = [{ name: 'src', files: 9, builds: 0 }, { name: 'docs', files: 2, builds: 2 }, { name: 'lib', files: 1, builds: 0 }];
  window.AU.getSystem = async (id) => { asked.push(id); return { project: { id }, planets, beltDensity: 0 }; };
  app.openPlanet = async (id, name) => { opened.push([id, name]); };
  await app.handleDebugView('planet');
  assert.deepEqual([asked, opened, ready()], [['p'], [['p', 'docs']], 1], 'the latest project with a folder; files + builds * 5');

  // An answer whose planets are not a list opens nothing, and main still hears the view is ready.
  window.AU.getSystem = async (id) => ({ project: { id }, planets: 'not a list', beltDensity: 0 });
  await app.handleDebugView('planet');
  window.AU.getSystem = async () => { throw new Error('main is away'); };
  await app.handleDebugView('planet');
  assert.deepEqual([opened.length, ready()], [1, 3]);
});

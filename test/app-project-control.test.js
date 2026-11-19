'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readRenderer, runApp } = require('./support/renderer-source');
const { fakeDocument, textOf, withClass } = require('./support/fake-dom');
const { deferred } = require('./support/main-wiring');

function setup() {
  const calls = [];
  const pending = deferred();
  const state = { projectControl: { projectId: null }, terminalRequestSerial: 0,
    playback: { mode: 'live' }, replayTransitionPending: false, replayBusy: false };
  const app = { state, const: { CHROME: { PROJECT: 1, FOCUS: 2 } }, renderChromeNow() {} };
  const window = { AUR: { app, settle: (call) => call() },
    AU: { openTerminal(id) { calls.push(id); return pending.promise; } } };
  vm.runInNewContext(readRenderer('app/project/control.js'), { window });
  return { app, state, calls, pending };
}

test('cockpit terminal actions preserve the exact ship ID through the bridge', async () => {
  const { app, calls, pending } = setup();
  const request = app.requestProjectTerminal('project', 'ship:codex:second');
  assert.deepEqual(calls, ['ship:codex:second']);
  assert.equal(app.projectControlPresentation('project', 'ship:codex:second').disabled, true);
  await app.requestProjectTerminal('project', 'ship:codex:first');
  assert.equal(calls.length, 1, 'other ships cannot bypass an in-flight request');
  pending.resolve({ ok: false, code: 'TERMINAL_NOT_FOUND' });
  await request;
  assert.match(app.projectControlPresentation('project', 'ship:codex:second').note, /existing terminal/);
  assert.equal(app.projectControlPresentation('project', 'ship:codex:first').phase, 'idle',
    'the previous agent’s result must not be attributed to a newly selected agent');
  assert.equal(app.projectControlPresentation('project').phase, 'idle');
});

test('project actions retain their project ID and replay blocks both target types', async () => {
  const { app, state, calls, pending } = setup();
  state.playback.mode = 'replay';
  await app.requestProjectTerminal('project', 'ship:codex:second');
  await app.requestProjectTerminal('project');
  assert.deepEqual(calls, []);
  state.playback.mode = 'live';
  const request = app.requestProjectTerminal('project');
  assert.deepEqual(calls, ['project']);
  pending.resolve({ ok: false, code: 'AMBIGUOUS' });
  await request;
  assert.match(app.projectControlPresentation('project').note, /Select an agent/);
});

test('a terminal kept in the background is reported as found, not missing', async () => {
  const { app, pending } = setup();
  const request = app.requestProjectTerminal('project', 'ship:alpha:first');
  pending.resolve({ ok: false, code: 'TERMINAL_BLOCKED' });
  await request;
  const { phase, note } = app.projectControlPresentation('project', 'ship:alpha:first');
  assert.equal(phase, 'failure');
  assert.match(note, /was found but stayed in the background/);
});

// ---------- planet card ----------

function planetSetup(planet, { project = {}, system = null } = {}) {
  const document = fakeDocument();
  const window = { AUR_PANEL_LAYOUT: { panelsOn: () => [] }, AU: {} };
  const whole = { id: 'p', name: 'demo', path: '/work/demo', exists: true, totalBuilds: 0, ...project };
  const state = {
    current: { view: 'planet', projectId: 'p', planetName: planet.name },
    store: { projects: new Map([['p', whole]]), ships: new Map() },
    activeView: { planetData: { project: whole, builds: 0, resources: [], ...planet } },
    planetSystem: { data: system, loading: false, stale: false, awaited: null, missed: false },
    commandRail: {},
    projectControl: { projectId: null }, terminalRequestSerial: 0, playback: { mode: 'live' },
  };
  const scheduled = [];
  const AUR = runApp(['app/chrome.js', 'app/project/control.js'], {
    state, const: { CHROME: { PROJECT: 1, FOCUS: 2, PLANET: 4 } },
    moduleHead: (card, title) => card.appendChild(window.AUR.el('h2', 'mod-title', title)),
    scheduleChrome: (mask) => scheduled.push(mask),
  }, { document, window, aur: { worldProfile: () => ({ key: 'rocky' }) } });
  const card = () => {
    AUR.app.renderPlanetCard();
    const node = document.getElementById('planet-card');
    const rows = Object.fromEntries(withClass(node, 'pc-row').map((row) => row.children.map(textOf)));
    return { rows, line: textOf(withClass(node, 'plc-sub')[0]), share: textOf(withClass(node, 'plc-share-note')[0]),
      bar: withClass(node, 'bar-fill')[0].style.width };
  };
  return { app: AUR.app, state, window, card, scheduled };
}

test('planet card: the share of builds is never 0% of a planet with builds, nor 100% of one without them all', () => {
  const share = (planetBuilds, systemBuilds) => {
    const { card } = planetSetup({ name: 'src', builds: planetBuilds }, { project: { totalBuilds: systemBuilds } });
    const { share: text, bar } = card();
    return [text, bar];
  };
  assert.deepEqual(share(1, 1000), ['< 1% of the system’s builds', '1%']);
  assert.deepEqual(share(999, 1000), ['> 99% of the system’s builds', '99%']);
  assert.deepEqual(share(995, 1000), ['> 99% of the system’s builds', '99%'], 'a share that would round to 100%');
  assert.deepEqual(share(1, 200), ['1% of the system’s builds', '1%']);
  assert.deepEqual(share(1, 3), ['33% of the system’s builds', '33%']);
  assert.deepEqual(share(5, 5), ['100% of the system’s builds', '100%']);
  assert.deepEqual(share(0, 5), ['0% of the system’s builds', '0%']);
  assert.deepEqual(share(0, 0), ['No builds in this system yet', '0%']);
});

test('planet card: the line under the name says what the planet is and why its folder rows are dashes', () => {
  const line = (planet, project) => planetSetup({ name: 'src', ...planet }, { project }).card().line;
  assert.equal(line({ folderRead: 'full' }), 'Rocky world · a folder in demo');
  assert.equal(line({ name: '(root)', folderRead: 'full' }), 'Rocky world · the top-level files of demo');
  assert.equal(line({ folderRead: 'gone' }), 'Rocky world · a folder in demo · no longer on disk');
  assert.equal(line({ folderRead: 'none' }), 'Rocky world · a folder in demo · could not be read');
  assert.equal(line({}), 'Rocky world · a folder in demo · history keeps no file counts');
  assert.equal(line({ procedural: true }), 'Rocky world · no builds here yet',
    'a stand-in of a project whose folder is there: in history, a planet without builds at the cursor');
  assert.equal(line({ procedural: true }, { exists: false }), 'Rocky world · no folder on disk');
  assert.equal(line({ procedural: true }, { path: null }), 'Rocky world · no folder on disk');
});

test('planet card: folder rows are dashes for a folder that is gone or unread; PLANETS says of how many', () => {
  const planets = Array.from({ length: 8 }, (_, index) => ({ name: 'd' + index, files: 1, builds: 0 }));
  const rows = (planet, system) => planetSetup({ name: 'src', files: 3, sizeKb: 2, subdirs: 1, ...planet }, { system }).card().rows;
  assert.equal(rows({ folderRead: 'full' }, { planets, planetTotal: 12 }).PLANETS, '8 of 12');
  assert.equal(rows({ folderRead: 'full' }, { planets: planets.slice(0, 3) }).PLANETS, '3');
  assert.equal(rows({ folderRead: 'full' }, null).PLANETS, '—');
  for (const folderRead of ['gone', 'none', undefined]) {
    const shown = rows({ folderRead }, null);
    assert.deepEqual([shown.FILES, shown.SIZE, shown.SUBFOLDERS], ['—', '—', '—'], String(folderRead));
  }
  const partial = rows({ folderRead: 'partial', sizeKb: 0 }, null);
  assert.deepEqual([partial.FILES, partial.SIZE], ['3+', '0 KB+'], 'a floor is a number, not "less than"');
  assert.equal(rows({ folderRead: 'full', sizeKb: 0 }, null).SIZE, '< 1 KB');
  assert.equal(rows({ folderRead: 'full', sizeKb: 1587 }, null).SIZE, '1.5 MB');
  assert.equal(rows({ folderRead: 'full', sizeKb: 1590 }, null).SIZE, '1.6 MB');
  assert.equal(rows({ folderRead: 'partial', sizeKb: 1590 }, null).SIZE, '1.5 MB+', 'a floor rounds down');
});

test('planet card: a project\'s system is fetched whole or not at all', async () => {
  const { app, window } = planetSetup({ name: 'src' });
  const system = { project: { id: 'p' }, planets: [], beltDensity: 0 };
  window.AU.getSystem = async (id) => {
    if (id === 'throws') throw new Error('main is away');
    return id === 'p' ? system : id === 'odd' ? { planets: 'not a list' } : null;
  };
  assert.equal(await app.fetchSystem('p'), system);
  for (const id of ['gone', 'throws', 'odd']) assert.equal(await app.fetchSystem(id), null, id);
});

test('planet card: a build that starts a planet fetches the system again, one request at a time', async () => {
  const systemOf = (count) => ({
    project: { id: 'p' }, beltDensity: 0,
    planets: Array.from({ length: count }, (_, index) => ({ name: 'd' + index, key: 'd' + index, files: 1, builds: 0 })),
  });
  const { app, state, window, card, scheduled } = planetSetup({ name: 'src', folderRead: 'full' }, { system: systemOf(1) });
  const asked = [];
  window.AU.getSystem = () => { asked.push(deferred()); return asked.at(-1).promise; };
  const settled = () => new Promise((done) => setImmediate(done));
  assert.equal(card().rows.PLANETS, '1');

  // Three planets start in a row: the first asks, the others wait for its answer and share one more.
  app.refreshPlanetSystem('other');
  assert.equal(asked.length, 0, 'a planet of another project changes nothing here');
  const first = app.refreshPlanetSystem('p');
  app.refreshPlanetSystem('p');
  app.refreshPlanetSystem('p');
  assert.equal(asked.length, 1);
  asked[0].resolve(systemOf(2));
  await settled();
  assert.deepEqual([card().rows.PLANETS, asked.length], ['2', 2], 'an answer from before the later builds is asked for again');
  asked[1].resolve(systemOf(4));
  await first;
  assert.deepEqual([card().rows.PLANETS, asked.length, scheduled, state.planetSystem.loading], ['4', 2, [4, 4], false]);

  // An answer for a route that has moved on to another project is dropped.
  const late = app.refreshPlanetSystem('p');
  state.current.projectId = 'other';
  asked[2].resolve(systemOf(9));
  await late;
  assert.deepEqual([state.planetSystem.data.planets.length, scheduled.length, state.planetSystem.loading], [4, 2, false]);
  state.current.view = 'system';
  window.AU.getSystem = async () => assert.fail('only an open planet has a system to refresh');
  await app.refreshPlanetSystem('other');
});

test('planet card: a planet that starts while a planet is opening reaches its card once it has opened', async () => {
  const systemOf = (count) => ({ project: { id: 'p' }, beltDensity: 0, planets: Array.from({ length: count }, (_, index) => ({ name: 'd' + index })) });
  const { app, state, window, card } = planetSetup({ name: 'src', folderRead: 'full' });
  const settled = () => new Promise((done) => setImmediate(done));
  let asked = 0;
  window.AU.getSystem = async () => systemOf(++asked + 1);
  // What boot.js openPlanet does around its own awaits: ask, wait for the planet, show it.
  const open = async (projectId, handed, meanwhile = () => {}) => {
    state.current.view = 'system';
    const request = app.requestPlanetSystem(projectId, handed);
    meanwhile();
    state.planetSystem.data = await request;
    Object.assign(state.current, { view: 'planet', projectId });
    app.planetSystemOpened();
    await settled();
    return card().rows.PLANETS;
  };

  assert.deepEqual([await open('p', systemOf(1)), asked], ['1', 0], 'the system view\'s own system is shown as handed over');
  assert.deepEqual([await open('p', systemOf(1), () => app.refreshPlanetSystem('p')), asked], ['2', 1],
    'a planet started meanwhile: the system handed over is behind, and is fetched again');
  assert.deepEqual([await open('p', systemOf(1), () => app.refreshPlanetSystem('other')), asked], ['1', 1], 'another project\'s planet is not this card\'s');
  assert.deepEqual([await open('p', null, () => app.refreshPlanetSystem('p')), asked], ['4', 3], 'a fetched system can be behind too');
  assert.deepEqual([await open('p', systemOf(1)), asked], ['1', 3], 'a planet from an earlier opening is not counted against this one');
  assert.deepEqual([state.planetSystem.awaited, state.planetSystem.missed], [null, false]);

  // The planet could not be shown and the app fell back to the universe, which has no project:
  // the planet that started meanwhile is nobody's to fetch, and is not held against the next opening.
  state.current.view = 'system';
  await app.requestPlanetSystem('p', systemOf(1));
  app.refreshPlanetSystem('p');
  Object.assign(state.current, { view: 'universe', projectId: null });
  app.planetSystemOpened();
  await settled();
  assert.deepEqual([state.planetSystem.awaited, state.planetSystem.missed, asked], [null, false, 3]);
  await app.refreshPlanetSystem(null);
  assert.deepEqual([state.planetSystem.awaited, state.planetSystem.missed, asked], [null, false, 3]);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readRenderer, runRenderer } = require('./support/renderer-source');
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
  runRenderer('util.js', { window, document });
  const { AUR } = window;
  const whole = { id: 'p', name: 'demo', path: '/work/demo', exists: true, totalBuilds: 0, ...project };
  const state = {
    current: { view: 'planet', projectId: 'p', planetName: planet.name },
    store: { projects: new Map([['p', whole]]), ships: new Map() },
    activeView: { planetData: { project: whole, builds: 0, resources: [], ...planet }, systemData: system },
    streamEpoch: 4, viewEpoch: 4, commandRail: {},
    projectControl: { projectId: null }, terminalRequestSerial: 0, playback: { mode: 'live' },
  };
  const scheduled = [];
  AUR.worldProfile = () => ({ key: 'rocky' });
  AUR.app = {
    state, const: { CHROME: { PROJECT: 1, FOCUS: 2, PLANET: 4 } },
    moduleHead: (card, title) => card.appendChild(AUR.el('h2', 'mod-title', title)),
    sameEpoch: (a, b) => a != null && b != null && String(a) === String(b),
    scheduleChrome: (mask) => scheduled.push(mask),
  };
  runRenderer('app/chrome.js', { window, document });
  runRenderer('app/project/control.js', { window, document });
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

test('planet card: the system comes from the open view when it holds this project\'s, else from main', async () => {
  const held = { project: { id: 'p' }, planets: [{ name: 'src', files: 1, builds: 0 }], beltDensity: 0 };
  const fetched = { project: { id: 'p' }, planets: [], beltDensity: 0 };
  const { app, state, window } = planetSetup({ name: 'src' }, { system: held });
  const asked = [];
  window.AU.getSystem = async (id) => { asked.push(id); return id === 'gone' ? null : fetched; };

  assert.equal(await app.systemForPlanet('p'), held);
  assert.deepEqual(asked, []);
  assert.equal(await app.systemForPlanet('other'), fetched, 'another project\'s system is asked for');
  state.viewEpoch = null;
  assert.equal(await app.systemForPlanet('p'), fetched, 'after a reset the view\'s copy is from before it');
  state.viewEpoch = 3;
  assert.equal(await app.systemForPlanet('p'), fetched, 'as is one from another stream');
  assert.equal(await app.systemForPlanet('gone'), null);
  assert.deepEqual(asked, ['other', 'p', 'p', 'gone']);
});

test('planet card: a build that starts a planet fetches the system again for the open planet', async () => {
  const planets = [{ name: 'src', files: 1, builds: 0 }];
  const { app, state, window, card, scheduled } = planetSetup({ name: 'src', folderRead: 'full' },
    { system: { project: { id: 'p' }, planets, beltDensity: 0 } });
  window.AU.getSystem = async () => ({ project: { id: 'p' }, planets: [...planets, { name: 'docs', files: 0, builds: 1 }], beltDensity: 0 });
  assert.equal(card().rows.PLANETS, '1');
  await app.refreshPlanetSystem();
  assert.deepEqual([card().rows.PLANETS, scheduled], ['2', [4]]);

  // A view that was replaced while the answer was on its way keeps what it has.
  const stale = state.activeView;
  window.AU.getSystem = async () => { state.activeView = { planetData: stale.planetData, systemData: null }; return { planets: [] }; };
  await app.refreshPlanetSystem();
  assert.deepEqual([stale.systemData.planets.length, scheduled.length], [2, 1]);
  state.current.view = 'system';
  window.AU.getSystem = async () => assert.fail('only a planet view keeps a copy to refresh');
  await app.refreshPlanetSystem();
});

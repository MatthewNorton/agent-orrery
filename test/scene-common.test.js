'use strict';

// The helpers the views share (src/renderer/scene/common.js): AUR.buildView, which app/boot.js
// builds every view through, and the views built through it. The engine keeps its scenes as Babylon's does.

const assert = require('node:assert/strict');
const test = require('node:test');
const { fakeDocument, fakeElement } = require('./support/fake-dom');
const { readRenderer, runRenderer } = require('./support/renderer-source');
const { anything, assertNoDisposeErrors, fakeScene, fakeTimers } = require('./support/scene-fakes');

function loadCommon() {
  const window = {}, logged = [], hullsReleased = [];
  runRenderer('util.js', { window, document: {} });
  Object.assign(window.AUR, {
    log: (...args) => logged.push(args.join(' ')),
    ships: { dispose: (scene) => hullsReleased.push(scene.name) },
  });
  runRenderer('scene/common.js', { window, document: {} });
  const engine = { scenes: [] };
  // A scene as `new BABYLON.Scene(engine)` leaves it: listed by its engine until it is disposed.
  const makeScene = (name, stuck = false) => {
    const scene = {
      name,
      dispose() {
        if (stuck) throw new Error('stuck');
        engine.scenes.splice(engine.scenes.indexOf(scene), 1);
      },
    };
    engine.scenes.push(scene);
    return scene;
  };
  const shown = () => engine.scenes.map((scene) => scene.name);
  return { AUR: window.AUR, engine, makeScene, shown, logged, hullsReleased };
}

test('buildView: a view is what its factory returns, and the scenes already there stay', () => {
  const { AUR, engine, makeScene, shown } = loadCommon();
  makeScene('universe'); // the view being replaced, disposed later by its owner
  const view = AUR.buildView((...args) => ({ scene: makeScene('system'), args }), engine, 'data', 'ctx');
  assert.deepEqual([view.args, shown()], [[engine, 'data', 'ctx'], ['universe', 'system']]);
});

test('buildView: a factory that throws leaves no scene behind', () => {
  const { AUR, engine, makeScene, shown, logged, hullsReleased } = loadCommon();
  makeScene('universe');
  const failing = () => {
    makeScene('system'); // its sky, sun and half its planets are in it by now
    throw new Error('no planet');
  };
  assert.throws(() => AUR.buildView(failing, engine, {}, {}), /no planet/);
  assert.deepEqual([shown(), hullsReleased, logged], [['universe'], ['system'], []], 'the half-built scene went, hull materials included');
});

test('buildView: a half-built scene that will not go is logged, and the build\'s own error is the one thrown', () => {
  const { AUR, engine, makeScene, shown, logged } = loadCommon();
  const failing = () => {
    makeScene('stuck', true);
    makeScene('system');
    throw new Error('no planet');
  };
  assert.throws(() => AUR.buildView(failing, engine, {}, {}), /no planet/);
  assert.deepEqual([shown(), logged], [['stuck'], ['half-built scene not removed: stuck']]);
});

test('buildView: app/boot.js builds every view through it', () => {
  const boot = readRenderer('app/boot.js');
  assert.ok(boot.includes('AUR.buildView(factory, S.engine, data, makeCtx())'));
  assert.ok(!/\bfactory\(/.test(boot), 'no view factory is called bare');
});

// A view of `file` over stand-ins for Babylon, the page and its timers, with the parts of its
// folder that `parts(real)` sets (given the parts the files loaded). Built through AUR.buildView.
function loadView(file, { partFiles = [], parts = () => {}, aur = {} } = {}) {
  const dialog = { listeners: 0, addEventListener() { this.listeners++; }, removeEventListener() { this.listeners--; } };
  const document = Object.assign(fakeDocument(), { body: fakeElement('body'), querySelectorAll: () => [dialog] });
  const timers = fakeTimers();
  const window = { AUR_POLISH: anything(), AUR_GALAXY: anything() };
  runRenderer('util.js', { window, document });
  const real = Object.assign(window.AUR, { log: () => {}, ships: { dispose() {} } }, aur);
  // What util.js and common.js do not define (the Babylon-facing helpers) accepts anything.
  window.AUR = new Proxy(real, { get: (target, key) => (key in target ? target[key] : (target[key] = anything())) });
  const engine = { scenes: [], getRenderingCanvas: () => ({ style: {} }) };
  const made = [];
  const BABYLON = new Proxy({ Scene: function Scene(owner) { return made[made.push(fakeScene(owner)) - 1]; } },
    { get: (target, key) => (key in target ? target[key] : (target[key] = anything())) });
  const globals = { window, document, BABYLON, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout };
  runRenderer('scene/common.js', globals);
  for (const part of partFiles) runRenderer(part, globals);
  parts(real.sceneParts);
  runRenderer(file, globals);
  return { AUR: real, engine, document, dialog, timers, made };
}

// The universe view with its label part, and stand-ins for its other parts; `failAt` names the part
// that throws once a label layout is due.
function loadUniverse(failAt = null) {
  let labels = null;
  const loaded = loadView('scene/universe/view.js', {
    partFiles: ['scene/universe/labels.js'],
    parts: (sceneParts) => {
      const real = sceneParts.universe.labels;
      const stand = { glyphs: { refreshRecencyRanks() {} }, galaxies: { rebuildGalaxyLayout() {} }, stars: {}, ships: {}, stats: {} };
      sceneParts.universe.labels = (view) => (labels = real(view));
      for (const [name, part] of Object.entries(stand)) {
        sceneParts.universe[name] = () => {
          labels.markLabelLayoutDirty(); // a label layout is due
          if (name === failAt) throw new Error('no ' + name);
          return part;
        };
      }
    },
  });
  const ctx = { store: { projects: new Map(), ships: new Map() }, quality: {} };
  return { ...loaded, build: () => loaded.AUR.buildView(loaded.AUR.views.universe, loaded.engine, {}, ctx) };
}

// The planet view of a world whose maps are never made, or whose first map throws with `failing`.
function loadPlanet(failing = false) {
  const world = {
    globe: {}, spec: { cls: 'rocky' }, outerRadius: 7, setSun() {}, setClouds() {}, update() {},
    show() { if (failing) throw new Error('no map'); return new Promise(() => {}); },
  };
  const loaded = loadView('scene/planet/view.js', {
    aur: { worlds: { textures: { SIZES: { high: { detail: 2048 } }, PLACEHOLDER: { planet: 64 } }, createWorld: () => world, worldSpec: () => ({}), moonSpec: () => ({}) } },
  });
  const data = { planet: { name: 'src', project: { id: 'p', seed: 1 } }, projectId: 'p', name: 'src' };
  const ctx = { store: { ships: new Map() }, worldMaps: { open: () => 1 }, quality: { key: 'high', sky: 1024 }, skyLook: 'soft' };
  return { ...loaded, build: () => loaded.AUR.buildView(loaded.AUR.views.planet, loaded.engine, data, ctx) };
}

test('buildView: a universe view that fails leaves nothing of its own on the page or on the clock', () => {
  for (const failAt of ['glyphs', 'stats']) {
    const { engine, document, dialog, timers, build } = loadUniverse(failAt);
    assert.throws(build, new RegExp('no ' + failAt));
    assert.deepEqual([engine.scenes, document.body.children, timers.delays(), dialog.listeners], [[], [], [], 0],
      `no scene, no repository status layer, no label layout timer, no dialog listener (${failAt})`);
    assertNoDisposeErrors(engine);
  }
});

test('a built universe view takes what it put on the page and on the clock along when it is disposed', () => {
  const { engine, document, dialog, timers, build } = loadUniverse();
  const view = build();
  assert.deepEqual([document.body.children.map((el) => el.className), timers.delays(), dialog.listeners], [['universe-vcs-layer'], [16], 1]);
  view.dispose();
  assert.deepEqual([engine.scenes, document.body.children, timers.delays(), dialog.listeners], [[], [], [], 0]);
  assertNoDisposeErrors(engine);
});

test('buildView: a planet view that fails after it holds its scene unready leaves no timer to release it', () => {
  const { engine, timers, made, build } = loadPlanet(true);
  assert.throws(build, /no map/);
  assert.deepEqual([engine.scenes, timers.delays(), made[0].pendingData.size], [[], [], 0]);
  assertNoDisposeErrors(engine);
});

test('a built planet view releases the scene it holds unready when it is disposed', () => {
  const { engine, timers, made, build } = loadPlanet();
  const view = build();
  assert.deepEqual([timers.delays(), made[0].pendingData.size], [[6000], 1], 'held until the detail map is bound');
  view.dispose();
  assert.deepEqual([engine.scenes, timers.delays(), made[0].pendingData.size], [[], [], 0]);
  assertNoDisposeErrors(engine);
});

test('the stand-in scene disposes as Babylon 9.36 does: once, and past an observer that throws, whose error it keeps', () => {
  const engine = { scenes: [] };
  const [first, other] = [fakeScene(engine), fakeScene(engine)];
  const ran = [];
  first.onDisposeObservable.add(() => { ran.push('throws'); throw new Error('observer failed'); });
  first.onDisposeObservable.add(() => ran.push('after'));
  first.dispose();
  first.dispose();
  // The error is not thrown and the observers after it are skipped; the scene leaves the list once.
  assert.deepEqual([ran, engine.scenes], [['throws'], [other]]);
  assert.deepEqual(engine.disposeErrors.map((error) => error.message), ['observer failed']);
  assert.throws(() => assertNoDisposeErrors(engine), /a dispose observer threw/);
});

test('disposeView: the scene goes, and what was tied to it, also when a step before it throws', () => {
  const { AUR } = loadCommon();
  const engine = { scenes: [], getRenderingCanvas: () => ({ style: {} }) };
  for (const stuck of ['gui', 'hulls']) {
    const scene = fakeScene(engine);
    let tied = 0;
    scene.onDisposeObservable.addOnce(() => tied++);
    const gui = { dispose() { if (stuck === 'gui') throw new Error('stuck gui'); } };
    AUR.ships.dispose = () => { if (stuck === 'hulls') throw new Error('stuck hulls'); };
    assert.throws(() => AUR.disposeView(scene, gui), new RegExp('stuck ' + stuck), 'the error is still thrown');
    assert.deepEqual([engine.scenes, tied], [[], 1], stuck);
  }
});

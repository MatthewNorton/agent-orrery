'use strict';

// The helpers the views share (src/renderer/scene/common.js): AUR.buildView, which app/boot.js
// builds every view through. The engine keeps its scenes as Babylon's does.

const assert = require('node:assert/strict');
const test = require('node:test');
const { readRenderer, runRenderer } = require('./support/renderer-source');

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

'use strict';

// Stand-ins for running a view's code without Babylon or a page clock: a value that accepts
// anything, a scene disposed in Babylon's order, and timers that can be read back.

const assert = require('node:assert/strict');

// Callable, constructible, and every property is another one: it stands in for Babylon and for
// whatever a drawing helper returns.
function anything() {
  return new Proxy(function () {}, {
    get: (target, key) => (key in target ? target[key] : (target[key] = anything())),
    apply: () => anything(),
    construct: () => anything(),
  });
}

// A scene as `new BABYLON.Scene(engine)` makes one: listed by `engine` until disposed, holding the
// pending data it is given. It disposes as Babylon 9.36 does: once; its onDisposeObservable first,
// where an observer that throws skips the ones after it and its error is not thrown (it is kept in
// `engine.disposeErrors`, which assertNoDisposeErrors reads); then it leaves the engine's list and
// is disposed. What else a view asks of it (its other observables, its metadata) accepts anything.
function fakeScene(engine) {
  const observers = [];
  if (!engine.disposeErrors) engine.disposeErrors = [];
  const scene = new Proxy({
    isDisposed: false, pendingData: new Set(),
    getEngine: () => engine,
    onDisposeObservable: { add: (fn) => observers.push(fn), addOnce: (fn) => observers.push(fn) },
    addPendingData: (data) => scene.pendingData.add(data),
    removePendingData: (data) => scene.pendingData.delete(data),
    dispose() {
      if (scene.isDisposed) return;
      try {
        for (const fn of observers.splice(0)) fn(scene);
      } catch (error) {
        engine.disposeErrors.push(error); // Babylon logs it and goes on disposing
      }
      const index = engine.scenes.indexOf(scene);
      if (index > -1) engine.scenes.splice(index, 1);
      scene.isDisposed = true;
    },
  }, { get: (target, key) => (key in target ? target[key] : (target[key] = anything())) });
  engine.scenes.push(scene);
  return scene;
}

// setTimeout and clearTimeout to give a script; delays() lists the timers set and not yet cleared.
function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    setTimeout: (fn, ms) => { pending.set(next, ms); return next++; },
    clearTimeout: (id) => { pending.delete(id); },
    delays: () => [...pending.values()],
  };
}

/** Asserts that no dispose observer of a stand-in scene of `engine` threw. */
function assertNoDisposeErrors(engine) {
  const thrown = (engine.disposeErrors || []).map((error) => error && error.message);
  assert.deepEqual(thrown, [], 'a dispose observer threw');
}

module.exports = { anything, assertNoDisposeErrors, fakeScene, fakeTimers };

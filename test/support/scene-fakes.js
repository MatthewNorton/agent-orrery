'use strict';

// Stand-ins for running a view's code without Babylon or a page clock: a value that accepts
// anything, a scene disposed in Babylon's order, and timers that can be read back.

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
// pending data it is given. Disposing it runs its onDisposeObservable first, as Babylon does. What
// else a view asks of it (its other observables, its metadata) accepts anything.
function fakeScene(engine) {
  const observers = [];
  const scene = new Proxy({
    isDisposed: false, pendingData: new Set(),
    getEngine: () => engine,
    onDisposeObservable: { add: (fn) => observers.push(fn), addOnce: (fn) => observers.push(fn) },
    addPendingData: (data) => scene.pendingData.add(data),
    removePendingData: (data) => scene.pendingData.delete(data),
    dispose() {
      for (const fn of observers.splice(0)) fn(scene);
      scene.isDisposed = true;
      engine.scenes.splice(engine.scenes.indexOf(scene), 1);
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

module.exports = { anything, fakeScene, fakeTimers };

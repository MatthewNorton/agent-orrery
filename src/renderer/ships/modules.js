// @ts-check
// The registry the converted ship models load into (scripts/import-ship.mjs writes them). A module
// registers a factory and runs the first time something uses it, so loading the page builds nothing
// and the order of the script tags does not matter.
'use strict';

(function () {
  const AUR = window.AUR;
  /** @type {Map<string, (use: (name: string) => any) => any>} */
  const factories = new Map();
  /** @type {Map<string, any>} */
  const loaded = new Map();
  const running = new Set();

  /** @param {string} name such as 'petrel/hull' @returns {any} the module's exports */
  function use(name) {
    if (loaded.has(name)) return loaded.get(name);
    const factory = factories.get(name);
    if (!factory) throw new Error('Ship module ' + name + ' is not loaded.');
    if (running.has(name)) throw new Error('Ship module ' + name + ' depends on itself.');
    running.add(name);
    try {
      loaded.set(name, factory(use));
    } finally {
      running.delete(name);
    }
    return loaded.get(name);
  }

  AUR.shipModule = (name, factory) => { factories.set(name, factory); };
  AUR.useShipModule = use;
})();

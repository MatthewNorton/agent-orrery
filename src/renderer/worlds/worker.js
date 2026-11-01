// @ts-check
// The world-map worker: builds one job's maps off the main thread and transfers the buffers back.
// worlds/textures.js starts it as new Worker('worlds/worker.js'); it is never a page script.
// Message in: a generate job plus its cache `key`. Message out: { key, ok: true, ms, ...maps }
// with the buffers transferred, or { key, ok: false, error }.
'use strict';

(function () {
  const scope = /** @type {any} */ (self);
  scope.importScripts('noise.js', 'classes.js', 'maps.js');
  const worlds = scope.AUR.worlds;

  scope.onmessage = (/** @type {MessageEvent} */ event) => {
    const job = event.data;
    try {
      const started = performance.now();
      const out = worlds.generate(job);
      const transfer = [out.surface.buffer, out.emission.buffer];
      if (out.clouds) transfer.push(out.clouds.buffer);
      if (out.rings) transfer.push(out.rings.buffer);
      scope.postMessage({ key: job.key, ok: true, ms: performance.now() - started, ...out }, transfer);
    } catch (error) {
      scope.postMessage({ key: job.key, ok: false, error: String((error && error.message) || error) });
    }
  };
})();

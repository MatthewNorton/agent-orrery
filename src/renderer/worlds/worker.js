// @ts-check
// The world-map worker, started by worlds/textures.js as new Worker('worlds/worker.js') (never a
// page script): runs one job per message and transfers the buffers back.
'use strict';

(function () {
  const scope = /** @type {any} */ (self);
  scope.importScripts('noise.js', 'classes.js', 'maps.js');
  const worlds = scope.AUR.worlds;

  scope.onmessage = (/** @type {MessageEvent} */ event) => {
    const reply = worlds.run(event.data);
    const transfer = reply.ok
      ? [reply.surface, reply.emission, reply.clouds, reply.rings].filter(Boolean).map((buffer) => buffer.buffer)
      : [];
    scope.postMessage(reply, transfer);
  };
})();

// @ts-check
// The world-map service (kit 15 W3): classic workers fill an LRU of generated buffers that
// outlives every scene, and each scene uploads what it shows as its own RawTextures. One service
// lives on AUR.app.state.worldMaps; views get it as ctx.worldMaps and request maps in an epoch
// opened on their scene, which closes when the scene is disposed. Workers start with the first request.
'use strict';

(function () {
  const AUR = window.AUR;
  const worlds = AUR.worlds;
  const TIMEOUT_MS = 15000;
  const MAIN_MAX_WIDTH = 1024; // the main thread never builds more than 1024 × 512
  const BUDGET_BYTES = 160 * 1024 * 1024;
  const WIDTHS = [2048, 1024, 512, 256, 128, 64];
  const LAYERS = ['surface', 'emission', 'clouds', 'rings'];
  // Map widths per graphics tier (contract, architecture 6), and the placeholders made at once.
  const SIZES = Object.freeze({
    low: Object.freeze({ system: 256, detail: 1024 }),
    balanced: Object.freeze({ system: 512, detail: 2048 }),
    high: Object.freeze({ system: 512, detail: 2048 }),
  });
  const PLACEHOLDER = Object.freeze({ system: 64, planet: 128 });

  const mapKey = (spec, width) => `${spec.cls}:${spec.seed}:${width}:${spec.rings ? 1 : 0}`;
  const jobFor = (spec, width) => ({
    key: mapKey(spec, width), cls: spec.cls, seed: spec.seed, hue: spec.hue, palette: spec.palette,
    width, height: width / 2, rings: Boolean(spec.rings),
  });
  const mapsOf = (key, out) => ({
    key, width: out.width, height: out.height, surface: out.surface, emission: out.emission, clouds: out.clouds, rings: out.rings,
  });
  const sizeOf = (maps) => LAYERS.reduce((sum, layer) => sum + (maps[layer] ? maps[layer].byteLength : 0), 0);
  function takeHighest(list) {
    let best = 0;
    for (let i = 1; i < list.length; i++) if (list[i].priority > list[best].priority) best = i;
    return list.splice(best, 1)[0];
  }

  function create() {
    const cache = new Map();  // key → { maps, bytes, placeholder }, least recently used first
    const jobs = new Map();   // key → job; a job serves every request for its key until it settles
    const queue = [];         // jobs waiting for a worker
    const mainQueue = [];     // jobs for the main-thread fallback
    const epochs = new Map(); // open epoch → { pending } requests not yet settled
    const users = new Map();  // live scene → keys of the maps it uploaded (never evicted)
    const pool = { idle: [], busy: new Map(), alive: 0, started: false };
    let bytes = 0, nextEpoch = 1, mainTimer = 0;

    function startPool() {
      if (pool.started) return;
      pool.started = true;
      const size = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 2));
      for (let i = 0; i < size; i++) {
        let worker;
        try { worker = new Worker('worlds/worker.js'); } catch (error) { break; }
        worker.onmessage = (event) => finish(worker, event.data);
        worker.onerror = (event) => { event.preventDefault(); retire(worker); };
        pool.idle.push(worker);
        pool.alive += 1;
      }
      if (!pool.alive) AUR.log('[worlds] map workers unavailable; maps are made on the main thread at up to 1024 × 512');
    }

    function lookup(key) {
      const entry = cache.get(key);
      if (entry) { cache.delete(key); cache.set(key, entry); }
      return entry || null;
    }
    const inUse = (key) => { for (const keys of users.values()) if (keys.has(key)) return true; return false; };
    function store(maps, placeholder) {
      const old = cache.get(maps.key);
      if (old) { bytes -= old.bytes; cache.delete(maps.key); }
      const entry = { maps, bytes: sizeOf(maps), placeholder };
      cache.set(maps.key, entry);
      bytes += entry.bytes;
      for (const [key, held] of cache) {
        if (bytes <= BUDGET_BYTES) break;
        if (inUse(key)) continue;
        cache.delete(key);
        bytes -= held.bytes;
      }
      return entry;
    }

    // Every waiter settles once: with { maps, source }, or with null when the map failed.
    function settle(job, maps, source) {
      jobs.delete(job.payload.key);
      for (const waiter of job.waiters) {
        const open = epochs.get(waiter.epoch);
        if (open) open.pending -= 1;
        waiter.resolve(maps ? { maps, source } : null);
      }
      job.waiters = [];
    }
    function complete(job, reply, source) {
      if (reply && reply.ok) {
        settle(job, store(mapsOf(reply.key, reply), false).maps, source);
      } else {
        AUR.log('[worlds] a world map could not be made; the current map stays');
        settle(job, null, source);
      }
    }

    function pump() {
      while (pool.idle.length && queue.length) {
        const job = takeHighest(queue);
        const worker = pool.idle.pop();
        job.running = true;
        pool.busy.set(worker, { job, timer: setTimeout(() => retire(worker), TIMEOUT_MS) });
        worker.postMessage(job.payload);
      }
      if (mainQueue.length && !mainTimer) mainTimer = setTimeout(runMain, 16);
    }
    function finish(worker, reply) {
      const busy = pool.busy.get(worker);
      if (!busy) return;
      clearTimeout(busy.timer);
      pool.busy.delete(worker);
      pool.idle.push(worker);
      complete(busy.job, reply, 'worker');
      pump();
    }
    // A worker that errors or runs past the timeout is retired; its job, and every queued job
    // once no worker is left, moves to the main thread.
    function retire(worker) {
      const busy = pool.busy.get(worker);
      const idle = pool.idle.indexOf(worker);
      if (!busy && idle < 0) return;
      if (busy) { clearTimeout(busy.timer); pool.busy.delete(worker); }
      if (idle >= 0) pool.idle.splice(idle, 1);
      try { worker.terminate(); } catch (error) { /* already gone */ }
      pool.alive -= 1;
      AUR.log('[worlds] a map worker stopped; its maps continue on the main thread');
      if (busy) toMain(busy.job);
      if (!pool.alive) while (queue.length) toMain(queue.shift());
      pump();
    }
    function toMain(job) { job.running = false; mainQueue.push(job); }
    // One job per task, so a run of fallbacks never holds the page for more than one map.
    function runMain() {
      mainTimer = 0;
      if (!mainQueue.length) return;
      const job = takeHighest(mainQueue);
      const payload = job.payload.width > MAIN_MAX_WIDTH ? jobFor(job.payload, MAIN_MAX_WIDTH) : job.payload;
      const hit = lookup(payload.key);
      if (hit) settle(job, hit.maps, 'cache');
      else complete(job, worlds.run(payload), 'main');
      pump();
    }

    // Requests of a closed epoch settle with null; a job nobody else wants is dropped unless it
    // is already running, and then its maps are cached for the next visit.
    function close(epoch) {
      if (!epochs.delete(epoch)) return;
      for (const job of Array.from(jobs.values())) {
        const kept = [];
        for (const waiter of job.waiters) {
          if (waiter.epoch === epoch) waiter.resolve(null);
          else kept.push(waiter);
        }
        job.waiters = kept;
        if (kept.length || job.running) continue;
        jobs.delete(job.payload.key);
        for (const list of [queue, mainQueue]) if (list.includes(job)) list.splice(list.indexOf(job), 1);
      }
    }

    return Object.freeze({
      // An epoch for requests made on behalf of `scene`; it closes when the scene is disposed.
      open(scene) {
        const epoch = nextEpoch++;
        epochs.set(epoch, { pending: 0 });
        scene.onDisposeObservable.addOnce(() => close(epoch));
        return epoch;
      },
      close, // early, for a request that is no longer wanted (a superseded prefetch)
      // A Promise of { maps, source: 'worker' | 'main' | 'cache' }, or null. It never rejects.
      request(spec, width, priority, epoch) {
        const open = epochs.get(epoch);
        if (!open) return Promise.resolve(null);
        startPool();
        const payload = jobFor(spec, pool.alive ? width : Math.min(width, MAIN_MAX_WIDTH));
        const hit = lookup(payload.key);
        if (hit) return Promise.resolve({ maps: hit.maps, source: 'cache' });
        let job = jobs.get(payload.key);
        if (!job) {
          job = { payload, priority, waiters: [], running: false };
          jobs.set(payload.key, job);
          (pool.alive ? queue : mainQueue).push(job);
        }
        job.priority = Math.max(job.priority, priority);
        open.pending += 1;
        const reply = new Promise((resolve) => job.waiters.push({ epoch, resolve }));
        pump();
        return reply;
      },
      // At once: the widest cached maps up to maxWidth, else a placeholder made here and now.
      best(spec, maxWidth, placeholderWidth) {
        for (const width of WIDTHS) {
          const entry = width <= maxWidth ? lookup(mapKey(spec, width)) : null;
          if (entry && !entry.placeholder) return { maps: entry.maps, source: 'cache' };
        }
        const job = jobFor(spec, placeholderWidth);
        const entry = lookup(job.key) || store(mapsOf(job.key, worlds.generate(job)), true);
        return { maps: entry.maps, source: 'placeholder' };
      },
      // This scene's textures for the maps: mipmapped, wrapping around the globe, clamped at the
      // poles. The cloud layer only when the world shows clouds.
      upload(scene, maps, withClouds) {
        let keys = users.get(scene);
        if (!keys) {
          keys = new Set();
          users.set(scene, keys);
          scene.onDisposeObservable.addOnce(() => users.delete(scene));
        }
        keys.add(maps.key);
        const aniso = Math.min(8, scene.getEngine().getCaps().maxAnisotropy || 1);
        const texture = (pixels, width, height, wrap) => {
          const map = BABYLON.RawTexture.CreateRGBATexture(pixels, width, height, scene, true, false, BABYLON.Texture.TRILINEAR_SAMPLINGMODE);
          map.wrapU = wrap ? BABYLON.Texture.WRAP_ADDRESSMODE : BABYLON.Texture.CLAMP_ADDRESSMODE;
          map.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;
          map.anisotropicFilteringLevel = aniso;
          return map;
        };
        const { width, height } = maps;
        const textures = {
          width, height,
          surface: texture(maps.surface, width, height, true),
          emission: texture(maps.emission, width, height, true),
          clouds: withClouds && maps.clouds ? texture(maps.clouds, width, height, true) : null,
          rings: maps.rings ? texture(maps.rings, maps.rings.length / 4, 1, false) : null,
          dispose() { for (const layer of LAYERS) if (textures[layer]) textures[layer].dispose(); },
        };
        return textures;
      },
      stats(epoch) {
        const open = epochs.get(epoch);
        return { workers: pool.alive, pending: open ? open.pending : 0, bytes };
      },
    });
  }

  worlds.textures = Object.freeze({ create, SIZES, PLACEHOLDER });
})();

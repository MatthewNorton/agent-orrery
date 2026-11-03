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
  const RESPAWNS = 4; // workers replaced over the service's life; past that the pool shrinks
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
    // Live scene → { keys: map key → its textures not yet disposed (those maps are never evicted),
    // blank: the scene's 1 × 1 clear texture for a missing emission layer }.
    const users = new Map();
    const pool = { idle: [], busy: new Map(), alive: 0, started: false, respawns: RESPAWNS };
    let bytes = 0, nextEpoch = 1, mainTimer = 0;

    function spawn() {
      let worker;
      try { worker = new Worker('worlds/worker.js'); } catch (error) { return false; }
      worker.onmessage = (event) => finish(worker, event.data);
      worker.onerror = (event) => { event.preventDefault(); retire(worker); };
      pool.idle.push(worker);
      pool.alive += 1;
      return true;
    }
    function startPool() {
      if (pool.started) return;
      pool.started = true;
      const size = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 2));
      for (let i = 0; i < size && spawn(); i++);
      if (!pool.alive) AUR.log('[worlds] map workers unavailable; maps are made on the main thread at up to 1024 × 512');
    }
    // The widest map up to `width` that can be made now: the main thread stops at 1024.
    function widthFor(width) {
      startPool();
      return pool.alive ? width : Math.min(width, MAIN_MAX_WIDTH);
    }
    function userOf(scene) {
      let user = users.get(scene);
      if (!user) {
        user = { keys: new Map(), blank: null };
        users.set(scene, user);
        scene.onDisposeObservable.addOnce(() => users.delete(scene));
      }
      return user;
    }

    function lookup(key) {
      const entry = cache.get(key);
      if (entry) { cache.delete(key); cache.set(key, entry); }
      return entry || null;
    }
    const inUse = (key) => { for (const user of users.values()) if (user.keys.has(key)) return true; return false; };
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
    // A worker that errors or runs past the timeout is retired, and replaced while RESPAWNS last.
    // Its job moves to the main thread if anyone still waits for it, and is dropped if not; every
    // queued job moves there too once no worker is left.
    function retire(worker) {
      const busy = pool.busy.get(worker);
      const idle = pool.idle.indexOf(worker);
      if (!busy && idle < 0) return;
      if (busy) { clearTimeout(busy.timer); pool.busy.delete(worker); }
      if (idle >= 0) pool.idle.splice(idle, 1);
      try { worker.terminate(); } catch (error) { /* already gone */ }
      pool.alive -= 1;
      const replaced = pool.respawns > 0 && spawn();
      if (replaced) pool.respawns -= 1;
      AUR.log(replaced ? '[worlds] a map worker stopped and was replaced' : '[worlds] a map worker stopped; its maps continue on the main thread');
      if (busy && busy.job.waiters.length) toMain(busy.job);
      else if (busy) jobs.delete(busy.job.payload.key);
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
        const payload = jobFor(spec, widthFor(width));
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
      widthFor,
      // This scene's textures for the maps: mipmapped, wrapping around the globe, clamped at the
      // poles. Maps without an emission layer share the scene's blank texture, and the cloud layer
      // goes up the first time clouds() asks for it. The maps stay in the cache until dispose().
      upload(scene, maps) {
        const user = userOf(scene);
        user.keys.set(maps.key, (user.keys.get(maps.key) || 0) + 1);
        const aniso = Math.min(8, scene.getEngine().getCaps().maxAnisotropy || 1);
        const own = [];
        const texture = (pixels, width, height, wrap) => {
          const map = BABYLON.RawTexture.CreateRGBATexture(pixels, width, height, scene, true, false, BABYLON.Texture.TRILINEAR_SAMPLINGMODE);
          map.wrapU = wrap ? BABYLON.Texture.WRAP_ADDRESSMODE : BABYLON.Texture.CLAMP_ADDRESSMODE;
          map.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;
          map.anisotropicFilteringLevel = aniso;
          return map;
        };
        const layer = (pixels, width, height, wrap) => { const map = texture(pixels, width, height, wrap); own.push(map); return map; };
        if (!maps.emission && !user.blank) user.blank = texture(new Uint8Array(4), 1, 1, true);
        const { width, height } = maps;
        let clouds = null, disposed = false;
        return {
          width, height,
          surface: layer(maps.surface, width, height, true),
          emission: maps.emission ? layer(maps.emission, width, height, true) : user.blank,
          rings: maps.rings ? layer(maps.rings, maps.rings.length / 4, 1, false) : null,
          clouds() {
            if (!clouds && maps.clouds && !disposed) clouds = layer(maps.clouds, width, height, true);
            return clouds;
          },
          dispose() {
            if (disposed) return;
            disposed = true;
            for (const map of own) map.dispose();
            const left = user.keys.get(maps.key) - 1;
            if (left > 0) user.keys.set(maps.key, left);
            else user.keys.delete(maps.key);
          },
        };
      },
      stats(epoch) {
        const open = epochs.get(epoch);
        return { workers: pool.alive, pending: open ? open.pending : 0, bytes };
      },
    });
  }

  worlds.textures = Object.freeze({ create, SIZES, PLACEHOLDER });
})();

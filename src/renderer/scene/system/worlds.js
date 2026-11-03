// @ts-check
// The system view's generated worlds (kit 15 W4): each planet's globe is a world from
// worlds/material.js lit from the sun at the origin. Its maps go placeholder, then system size
// (the three biggest planets first), and the hovered planet's detail map is prefetched for the
// planet view. Also the sun's photosphere and billboards (worlds/sun.js, W5) and the view's
// worldStats() (W6).
'use strict';

(function () {
  const AUR = window.AUR;

  AUR.sceneParts.system.worlds = function (view) {
    const { scene, projectId, planets, glow, sun, sunHex, sunDia } = view;
    const W = AUR.worlds;
    const { SIZES, PLACEHOLDER } = W.textures;
    const maps = view.worldMaps;
    const epoch = maps.open(scene);
    const origin = BABYLON.Vector3.Zero();
    let tier = view.quality;
    const DWELL_MS = 250; // how long the pointer rests on a planet before its detail map is fetched
    const NO_PREFETCH = Object.freeze({ key: '', epoch: 0, timer: 0 });
    /** @type {{ key: string, epoch: number, timer: number }} */
    let prefetch = NO_PREFETCH; // the latest hovered planet's, keyed by name and width
    const sunFx = W.createSun(scene, sun, { diameter: sunDia, glow, tier: tier.key });

    const showSystemMaps = (world, first) => world.show(SIZES[tier.key].system, first ? 2 : 1, PLACEHOLDER.system);

    // The world for a planet `dia` across, named pl_<name> for picking and the polish harness.
    function makeWorld(name, dia, first) {
      const world = W.createWorld(scene, W.worldSpec(projectId, name, sunHex), {
        name: 'pl_' + name, radius: dia / 2, segments: 32, clouds: false, glow, maps, epoch,
      });
      world.setSun(origin);
      showSystemMaps(world, first);
      return world;
    }

    // The detail map of the planet under the pointer (p, or null once it leaves), requested once
    // the pointer rests there, in the background: the service makes it only in a worker, since on
    // the main thread it would stall the page for a planet that may never be opened. A superseded
    // prefetch is dropped unless its map is already being made.
    function prefetchDetail(p) {
      if (prefetch.timer) { clearTimeout(prefetch.timer); prefetch = NO_PREFETCH; }
      if (!p) return;
      const width = SIZES[tier.key].detail, key = p.name + ':' + width;
      if (prefetch.key === key) return;
      maps.close(prefetch.epoch);
      const next = prefetch = { key, epoch: 0, timer: 0 };
      next.timer = setTimeout(() => {
        next.timer = 0;
        if (scene.isDisposed) return;
        next.epoch = maps.open(scene);
        maps.request(p.world.spec, width, 0, next.epoch, { background: true });
      }, DWELL_MS);
    }

    function setWorldsQuality(next) {
      tier = next;
      sunFx.setTier(next.key);
      for (const p of planets.values()) showSystemMaps(p.world, p.persistent);
    }

    // Where a mesh's centre lands on the page, in CSS pixels.
    function screenPoint(mesh) {
      const engine = scene.getEngine();
      const width = engine.getRenderWidth(), height = engine.getRenderHeight();
      const viewport = scene.activeCamera.viewport.toGlobal(width, height);
      const p = BABYLON.Vector3.Project(mesh.getAbsolutePosition(), BABYLON.Matrix.IdentityReadOnly, scene.getTransformMatrix(), viewport);
      const rect = engine.getRenderingCanvas().getBoundingClientRect();
      return { x: Math.round(rect.left + p.x * rect.width / width), y: Math.round(rect.top + p.y * rect.height / height) };
    }

    function worldStats() {
      const sunMat = sun.material;
      const inGlow = new BABYLON.Color4(1, 1, 1, 1); // what the sun writes in the glow pass
      if (glow.customEmissiveColorSelector) glow.customEmissiveColorSelector(sun, null, sunMat, inGlow);
      return {
        view: 'system', ...W.sceneStats(scene, maps, epoch, tier.key),
        planets: Array.from(planets.values(), (p) => ({
          name: p.name, cls: p.world.spec.cls, expectedCls: AUR.worldProfile(projectId, p.name).key,
          mapWidth: p.world.mapWidth, source: p.world.source,
        })),
        sun: {
          plugin: Boolean(sunMat && sunMat.pluginManager && sunMat.pluginManager.getPlugin('photosphere')),
          darkInGlow: glow.hasMesh(sun) && inGlow.r + inGlow.g + inGlow.b === 0, color: sunHex, screen: screenPoint(sun),
        },
        detail: null,
      };
    }

    return { makeWorld, prefetchDetail, setWorldsQuality, worldStats, sunFx };
  };
})();

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
    let prefetch = { name: '', epoch: 0 }; // only the latest hovered planet's detail map is wanted
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

    // A superseded prefetch is dropped unless its map is already being made.
    function prefetchDetail(p) {
      if (prefetch.name === p.name) return;
      maps.close(prefetch.epoch);
      prefetch = { name: p.name, epoch: maps.open(scene) };
      maps.request(p.world.spec, SIZES[tier.key].detail, 0, prefetch.epoch);
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
      return {
        view: 'system', ...W.sceneStats(scene, maps, epoch, tier.key),
        planets: Array.from(planets.values(), (p) => ({
          name: p.name, cls: p.world.spec.cls, expectedCls: AUR.worldProfile(projectId, p.name).key,
          mapWidth: p.world.mapWidth, source: p.world.source,
        })),
        sun: {
          plugin: Boolean(sunMat && sunMat.pluginManager && sunMat.pluginManager.getPlugin('photosphere')),
          excludedFromGlow: !glow.hasMesh(sun), color: sunHex, screen: screenPoint(sun),
        },
        detail: null,
      };
    }

    return { makeWorld, prefetchDetail, setWorldsQuality, worldStats, sunFx };
  };
})();

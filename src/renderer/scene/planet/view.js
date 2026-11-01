// Planet close-up: one large generated world (worlds/material.js) with its air, clouds and
// rings, generated moons, and this project's ships orbiting with name labels. The detail map
// lands after the view opens; readiness is held until it does (kit 15 D3).
'use strict';

(function () {
  const AUR = window.AUR;

  AUR.views.planet = function (engine, data, ctx) {
    const store = ctx.store;
    const pd = data.planet;
    const projectId = data.projectId;
    const name = data.name;
    const project = pd.project;

    const scene = new BABYLON.Scene(engine);
    scene.clearColor = AUR.color4('#04050a', 1);
    scene.ambientColor = new BABYLON.Color3(0.06, 0.07, 0.1);

    const PDIA = 12;
    AUR.viewCamera(scene, 'pcam', 1.24, PDIA * 1.9, {
      lowerRadiusLimit: PDIA * 1.15, upperRadiusLimit: PDIA * 4,
      lowerBetaLimit: 0.2, upperBetaLimit: 1.55, panningSensibility: 0, minZ: 0.05,
    });

    const key = new BABYLON.DirectionalLight('key', new BABYLON.Vector3(0.55, -0.35, 0.75), scene);
    key.intensity = 1.6;
    const hemi = new BABYLON.HemisphericLight('h', new BABYLON.Vector3(0, 1, 0), scene);
    hemi.intensity = 0.22;

    const glow = new BABYLON.GlowLayer('pglow', scene, { blurKernelSize: 64 });
    glow.intensity = 0.5;

    AUR.addSkybox(scene, project.seed, 1600, 0.055);
    AUR.addStarfield(scene, 3400, 760);
    const gui = AUR.guiLayer(scene);

    // ---- planet ----
    const W = AUR.worlds;
    const { SIZES, PLACEHOLDER } = W.textures;
    const maps = ctx.worldMaps;
    const epoch = maps.open(scene);
    let tier = ctx.quality;
    const sunHex = AUR.sunColor(project.seed);
    const sunPosition = key.direction.scale(-1e5); // the shaders' sun agrees with the key light the ships use
    const worldOpts = { segments: 64, clouds: true, glow, maps, epoch };
    const world = W.createWorld(scene, W.worldSpec(projectId, name, sunHex), { ...worldOpts, name: 'planet', radius: PDIA / 2 });
    const planet = world.globe;
    planet.metadata = { worldType: world.spec.cls };
    // Tilted from a parent node, so the globe spins about its own axis.
    const tilt = new BABYLON.TransformNode('planet-tilt', scene);
    tilt.rotation.z = 0.35;
    planet.parent = tilt;
    world.setSun(sunPosition);
    world.setClouds(tier.key === 'high');

    // D3 (world.show): the best cached map now, 512 soon if nothing that good is cached, then the
    // detail map. The scene stays unready (shots and polish harnesses wait on it) until the
    // detail map is bound or 6 s pass.
    const opened = performance.now();
    const detail = { swapMs: null, heldReady: false };
    let hold = {};
    scene.addPendingData(hold);
    const release = () => {
      if (!hold) return;
      scene.removePendingData(hold);
      hold = null;
      clearTimeout(holdTimer);
    };
    const holdTimer = setTimeout(release, 6000);
    const showDetail = () => world.show(SIZES[tier.key].detail, 3, PLACEHOLDER.planet).then((bound) => {
      if (bound && detail.swapMs == null) Object.assign(detail, { swapMs: Math.round(performance.now() - opened), heldReady: hold !== null });
    });
    showDetail().then(release, release);

    scene.metadata = {
      view: 'planet',
      providerStats() {
        return AUR.sceneProviderStats(scene);
      },
      worldStats() {
        return {
          view: 'planet', ...W.sceneStats(scene, maps, epoch, tier.key), planets: [], sun: null,
          detail: { name, mapWidth: world.mapWidth, swapMs: detail.swapMs, heldReady: detail.heldReady, source: world.source },
        };
      },
    };

    // ---- moons ----
    const moons = [];
    const MOON_ORBIT = { min: 0.9, max: 1.4 }; // in planet diameters; ships orbit beyond it
    (function buildMoons() {
      const rand = AUR.mulberry32(AUR.fnv1a(projectId + ':moons:' + name));
      const nm = 1 + Math.floor(rand() * 2);
      for (let i = 0; i < nm; i++) {
        const md = 0.8 + rand() * 1.1;
        const moon = W.createWorld(scene, W.moonSpec(projectId, name, i, sunHex), { ...worldOpts, name: 'moon' + i, radius: md / 2, segments: 48 });
        moon.globe.isPickable = false;
        moon.setSun(sunPosition);
        moon.show(512, 1, PLACEHOLDER.planet);
        moons.push({
          world: moon, mesh: moon.globe, r: PDIA * (MOON_ORBIT.min + rand() * (MOON_ORBIT.max - MOON_ORBIT.min)), a: rand() * 6.28,
          speed: (0.006 + rand() * 0.006) * (rand() > 0.5 ? 1 : -1),
          tilt: (rand() - 0.5) * 0.8, yoff: (rand() - 0.5) * PDIA * 0.4,
        });
      }
    })();

    // ---- ships ----
    const ships = new Map();
    const SIZE = AUR.SHIP_SIZE.planet;
    const MOON_SHELL = PDIA * (MOON_ORBIT.max + 0.1); // beyond the outermost moon and half a moon
    AUR.shipLights(scene);
    function buildShip(s) {
      const { mesh, tint, providerKey, scale } = AUR.shipMesh(scene, s, 'p', SIZE);
      const rand = AUR.mulberry32(AUR.fnv1a(s.id));
      const label = AUR.label(gui, s.name, { fontSize: 12, mono: true, mesh, offsetY: -20 });
      const rec = {
        id: s.id, mesh, label, tint, providerKey, scale,
        r: MOON_SHELL + rand() * PDIA * 0.25, a: rand() * 6.28,
        speed: (AUR.MOTION.planetShipOrbitMin +
          rand() * AUR.MOTION.planetShipOrbitRange) * (rand() > 0.5 ? 1 : -1),
        tilt: (rand() - 0.5) * 0.7, yoff: (rand() - 0.5) * PDIA * 0.5,
      };
      ships.set(s.id, rec);
      return rec;
    }
    function removeShip(id) {
      const r = ships.get(id);
      if (!r) return;
      r.label.dispose();
      AUR.disposeMeshAndMaterial(r.mesh);
      ships.delete(id);
    }
    for (const s of store.ships.values()) if (s.project === projectId) buildShip(s);

    // ---- animation ----
    const heading = new BABYLON.Vector3();
    scene.onBeforeRenderObservable.add(() => {
      const dt = engine.getDeltaTime() / 1000;
      planet.rotation.y += dt * AUR.MOTION.planetDetailAxialRotation;
      world.update(dt);
      for (const m of moons) {
        m.a += m.speed * dt;
        AUR.orbitPoint(m.a, m.r, m.yoff + Math.sin(m.a) * m.r * m.tilt, m.mesh.position);
        m.world.update(dt);
      }
      const fit = AUR.shipFit(scene, SIZE.minPx);
      for (const r of ships.values()) {
        r.a += r.speed * dt;
        AUR.orbitPoint(r.a, r.r, r.yoff + Math.sin(r.a) * r.r * r.tilt, r.mesh.position);
        const ahead = r.a + Math.sign(r.speed) * 0.025;
        r.mesh.lookAt(AUR.orbitPoint(ahead, r.r, r.yoff, heading));
        AUR.fitShip(fit, r, r.mesh.position);
      }
    });

    function update(batch) {
      for (const ev of batch) {
        if (ev.type === 'ship-spawned' && ev.ship.project === projectId) {
          if (!ships.has(ev.ship.id)) buildShip(ev.ship);
        } else if (ev.type === 'ship-departed') {
          removeShip(ev.shipId);
        }
      }
    }

    return {
      scene,
      planetData: pd,
      update,
      setQuality(next) {
        tier = next;
        world.setClouds(tier.key === 'high');
        showDetail();
      },
      dispose() {
        release();
        AUR.disposeView(scene, gui);
      },
    };
  };
})();

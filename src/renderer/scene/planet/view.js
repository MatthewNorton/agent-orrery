// Planet close-up: one large textured planet, atmosphere
// rim, moons, this project's ships orbiting with name labels.
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
    const atmosphere = AUR.atmosphereProfile(projectId, name);
    scene.metadata = {
      view: 'planet',
      providerStats() {
        return AUR.sceneProviderStats(scene);
      },
    };

    // ---- planet ----
    const planet = BABYLON.MeshBuilder.CreateSphere('planet', { diameter: PDIA, segments: 64 }, scene);
    const pmat = new BABYLON.StandardMaterial('pmat', scene);
    const world = AUR.applyPlanetSurface(scene, pmat, projectId, name, {
      detail: true, generate: Boolean(pd.procedural),
    });
    const shine = world.key === 'gas' || world.key === 'oceanic' ? 0.2 : 0.075;
    pmat.specularColor = new BABYLON.Color3(shine, shine, shine * 1.12);
    pmat.specularPower = world.key === 'oceanic' ? 64 : 24;
    pmat.emissiveColor = new BABYLON.Color3(0.05, 0.055, 0.07);
    planet.material = pmat;
    planet.metadata = { worldType: world.key };
    planet.rotation.z = 0.35;

    // Planet-specific shells stay close to the surface instead of reading as
    // the same oversized blue bubble around every world.
    const atmo = BABYLON.MeshBuilder.CreateSphere('atmo', {
      diameter: PDIA * atmosphere.scale, segments: 64,
    }, scene);
    const amat = AUR.unlitMaterial(scene, 'amat', new BABYLON.Color3(0, 0, 0), atmosphere.alpha * 0.55);
    const atmosphereColor = AUR.color3(atmosphere.color);
    amat.backFaceCulling = false;
    amat.disableLighting = true;
    const emissiveFresnel = new BABYLON.FresnelParameters();
    emissiveFresnel.bias = 0;
    emissiveFresnel.power = atmosphere.power;
    emissiveFresnel.leftColor = atmosphereColor.scale(0.58);
    emissiveFresnel.rightColor = BABYLON.Color3.Black();
    amat.emissiveFresnelParameters = emissiveFresnel;
    atmo.material = amat;
    atmo.isPickable = false;

    // ---- moons ----
    const moons = [];
    const MOON_ORBIT = { min: 0.9, max: 1.4 }; // in planet diameters; ships orbit beyond it
    (function buildMoons() {
      const rand = AUR.mulberry32(AUR.fnv1a(projectId + ':moons:' + name));
      const nm = 1 + Math.floor(rand() * 2);
      for (let i = 0; i < nm; i++) {
        const md = 0.8 + rand() * 1.1;
        const moon = BABYLON.MeshBuilder.CreateSphere('moon' + i, { diameter: md, segments: 24 }, scene);
        const mm = new BABYLON.StandardMaterial('moonm' + i, scene);
        mm.diffuseColor = new BABYLON.Color3(0.55, 0.55, 0.6);
        mm.emissiveColor = new BABYLON.Color3(0.05, 0.05, 0.06);
        mm.specularColor = new BABYLON.Color3(0, 0, 0);
        moon.material = mm;
        moon.isPickable = false;
        moons.push({
          mesh: moon, r: PDIA * (MOON_ORBIT.min + rand() * (MOON_ORBIT.max - MOON_ORBIT.min)), a: rand() * 6.28,
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
      if (world.key === 'gas' && pmat.diffuseTexture) {
        const drift = dt * 0.007;
        pmat.diffuseTexture.uOffset += drift;
        if (pmat.bumpTexture) pmat.bumpTexture.uOffset += drift;
      }
      for (const m of moons) {
        m.a += m.speed * dt;
        AUR.orbitPoint(m.a, m.r, m.yoff + Math.sin(m.a) * m.r * m.tilt, m.mesh.position);
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
      dispose() {
        AUR.disposeView(scene, gui);
      },
    };
  };
})();

// scene-planet.js — planet close-up: one large textured planet, atmosphere
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
    const canvas = engine.getRenderingCanvas();

    const scene = new BABYLON.Scene(engine);
    scene.clearColor = AUR.color4('#04050a', 1);
    scene.ambientColor = new BABYLON.Color3(0.06, 0.07, 0.1);

    const PDIA = 12;
    const camera = new BABYLON.ArcRotateCamera(
      'pcam', -Math.PI / 2, 1.24, PDIA * 1.9, BABYLON.Vector3.Zero(), scene);
    camera.attachControl(canvas, true);
    camera.lowerRadiusLimit = PDIA * 1.15;
    camera.upperRadiusLimit = PDIA * 4;
    camera.lowerBetaLimit = 0.2;
    camera.upperBetaLimit = 1.55;
    camera.panningSensibility = 0;
    camera.minZ = 0.05;
    camera.maxZ = 6000;
    AUR.configureComfortCamera(camera);

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
      atmosphere,
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
    const amat = new BABYLON.StandardMaterial('amat', scene);
    const atmosphereColor = AUR.color3(atmosphere.color);
    amat.emissiveColor = new BABYLON.Color3(0, 0, 0);
    amat.diffuseColor = new BABYLON.Color3(0, 0, 0);
    amat.specularColor = new BABYLON.Color3(0, 0, 0);
    amat.backFaceCulling = false;
    amat.disableLighting = true;
    const emissiveFresnel = new BABYLON.FresnelParameters();
    emissiveFresnel.bias = 0;
    emissiveFresnel.power = atmosphere.power;
    emissiveFresnel.leftColor = atmosphereColor.scale(0.58);
    emissiveFresnel.rightColor = BABYLON.Color3.Black();
    amat.emissiveFresnelParameters = emissiveFresnel;
    amat.alpha = atmosphere.alpha * 0.55;
    atmo.material = amat;
    atmo.isPickable = false;

    // ---- moons ----
    const moons = [];
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
          mesh: moon, r: PDIA * (0.9 + rand() * 0.5), a: rand() * 6.28,
          speed: (0.006 + rand() * 0.006) * (rand() > 0.5 ? 1 : -1),
          tilt: (rand() - 0.5) * 0.8, yoff: (rand() - 0.5) * PDIA * 0.4,
        });
      }
    })();

    // ---- ships ----
    const ships = new Map();
    function buildShip(s) {
      const tint = AUR.shipTint(s.id, s.provider);
      const signal = AUR.isSignalEntity(s);
      const scale = signal ? 0.72 : 1.1;
      let mesh = signal
        ? AUR.signalMarker(scene, 'psig_' + s.id, tint)
        : AUR.ships.instantiate(scene, s);
      const usedFallback = !signal && !mesh;
      if (usedFallback) mesh = AUR.dartMesh(scene, 'pshp_' + s.id, tint, scale);
      else mesh.scaling.setAll(scale);
      const provider = AUR.markShipMesh(mesh, s);
      const rand = AUR.mulberry32(AUR.fnv1a(s.id));
      const label = AUR.label(gui, s.name, { fontSize: 12, mono: true, color: '#eeece6' });
      label.linkWithMesh(mesh);
      label.linkOffsetY = -20;
      const rec = {
        id: s.id, mesh, label, tint, providerKey: provider.key,
        r: PDIA * (0.82 + rand() * 0.5), a: rand() * 6.28,
        speed: (AUR.MOTION.planetShipOrbitMin +
          rand() * AUR.MOTION.planetShipOrbitRange) * (rand() > 0.5 ? 1 : -1),
        tilt: (rand() - 0.5) * 0.7, yoff: (rand() - 0.5) * PDIA * 0.5,
      };
      if (usedFallback) AUR.ships.upgrade(scene, s, mesh, scale);
      ships.set(s.id, rec);
      return rec;
    }
    function removeShip(id) {
      const r = ships.get(id);
      if (!r) return;
      if (r.label) r.label.dispose();
      if (r.mesh) r.mesh.dispose();
      ships.delete(id);
    }
    for (const s of store.ships.values()) if (s.project === projectId) buildShip(s);

    // ---- animation ----
    const tmp = new BABYLON.Vector3();
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
        tmp.set(Math.cos(m.a) * m.r, m.yoff + Math.sin(m.a) * m.r * m.tilt, Math.sin(m.a) * m.r);
        m.mesh.position.copyFrom(tmp);
      }
      for (const r of ships.values()) {
        r.a += r.speed * dt;
        tmp.set(Math.cos(r.a) * r.r, r.yoff + Math.sin(r.a) * r.r * r.tilt, Math.sin(r.a) * r.r);
        r.mesh.position.copyFrom(tmp);
        r.mesh.lookAt(new BABYLON.Vector3(
          Math.cos(r.a + Math.sign(r.speed) * 0.025) * r.r, r.yoff, Math.sin(r.a + Math.sign(r.speed) * 0.025) * r.r));
      }
    });

    function update(batch) {
      for (const ev of batch) {
        if (ev.type === 'ship-spawned' && ev.ship.project === projectId) {
          if (!ships.has(ev.ship.id)) buildShip(ev.ship);
        } else if (ev.type === 'ship-departed') {
          if (ships.has(ev.shipId)) removeShip(ev.shipId);
        }
      }
    }

    return {
      scene,
      planetData: pd,
      update,
      dispose() {
        scene.onBeforeRenderObservable.clear();
        scene.onPointerObservable.clear();
        canvas.style.cursor = 'default';
        gui.dispose();
        AUR.ships.dispose(scene);
        scene.dispose();
      },
    };
  };
})();

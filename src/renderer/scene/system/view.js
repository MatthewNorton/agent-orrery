// One project's solar system: central sun, orbit rings and generated planets. The asteroid belt,
// the ships, their engine plumes, agent focus (its camera and the fade of the other ships) and
// the planets' worlds are the belt, ships, exhaust, focus and worlds parts in this folder.
'use strict';

(function () {
  const AUR = window.AUR;
  const POLISH = window.AUR_POLISH;

  AUR.views.system = function (engine, data, ctx) {
    const store = ctx.store;
    const sys = data.system;
    const projectId = data.projectId;
    const project = sys.project;
    const canvas = engine.getRenderingCanvas();

    const scene = new BABYLON.Scene(engine);
    scene.clearColor = AUR.color4('#04050a', 1);
    scene.ambientColor = new BABYLON.Color3(0.05, 0.05, 0.08);

    const planetList = sys.planets || [];
    const orbitR = (i) => 11 + i * 6;
    const outer = orbitR(Math.max(0, planetList.length - 1));

    const camera = AUR.viewCamera(scene, 'scam', 0.92, outer * 2.3 + 14, {
      lowerRadiusLimit: 18, upperRadiusLimit: outer * 3.4 + 40,
      lowerBetaLimit: 0.15, upperBetaLimit: 1.45, panningSensibility: 0,
    });

    const sunLight = new BABYLON.PointLight('sunl', BABYLON.Vector3.Zero(), scene);
    sunLight.intensity = 1.5;
    sunLight.range = outer * 4 + 60;
    const hemi = new BABYLON.HemisphericLight('h', new BABYLON.Vector3(0.3, 1, 0.2), scene);
    hemi.intensity = 0.18;

    const glow = new BABYLON.GlowLayer('sglow', scene, { blurKernelSize: 64 });
    glow.intensity = 0.82;

    AUR.addSkybox(scene, project.seed, 1600, 0.055);
    AUR.addStarfield(scene, 3400, 760);
    const gui = AUR.guiLayer(scene);

    // ---- sun ----
    const sunDia = AUR.clamp(4.5 + Math.log10((project.totalBytes || 0) + 1), 5, 9);
    const sun = BABYLON.MeshBuilder.CreateSphere('sun', { diameter: sunDia, segments: 64 }, scene);
    const sunMat = new BABYLON.StandardMaterial('sunm', scene);
    const sunHex = AUR.sunColor(project.seed);
    const sunCol = AUR.color3(sunHex);
    const sunColInitial = sunCol.clone();
    // The material is pulsed in place every frame, so it must never alias the
    // immutable base color. Otherwise each scale becomes the next frame's base
    // and the core decays geometrically toward black.
    sunMat.emissiveColor = sunCol.clone();
    sunMat.diffuseColor = new BABYLON.Color3(0, 0, 0);
    sunMat.specularColor = new BABYLON.Color3(0, 0, 0);
    sun.material = sunMat;
    // The photosphere (worlds/sun.js, from the worlds part) is the sun's own light; glow stacked
    // on it bleached the core white. So in the glow pass the sun takes the neutral colour, like
    // the globes: it hides the glow of ships behind it and adds none. Every other mesh keeps
    // Babylon's own choice: emissive colour by texture level and intensity, at the material's alpha.
    glow.customEmissiveColorSelector = (mesh, subMesh, material, result) => {
      const emissive = mesh !== sun && material && material.emissiveColor;
      if (!emissive) { result.copyFrom(glow.neutralColor); return; }
      const level = (material.emissiveTexture ? material.emissiveTexture.level : 1) * (material.emissiveIntensity ?? 1);
      result.set(emissive.r * level, emissive.g * level, emissive.b * level, material.alpha);
    };
    let lastPulseFactor = 1;

    // State shared with the parts in scene/system/.
    const planets = new Map(); // name -> record
    const ships = new Map();
    // The asteroid belt sits between the middle orbits (past the last one in a small system),
    // `beltWidth` across; ships patrol outside it.
    const beltR = planetList.length >= 2 ? (orbitR(Math.floor(planetList.length / 2) - 1) + orbitR(Math.floor(planetList.length / 2))) / 2 : outer + 4;
    const view = {
      scene, gui, sys, projectId, orbitR, outer, beltR, beltWidth: 3.4, planets, ships,
      camera, canvas, glow, shipFocus: null, buildPlanet,
      sun, sunHex, sunDia, worldMaps: ctx.worldMaps, quality: ctx.quality,
    };
    const parts = AUR.sceneParts.system;
    Object.assign(view, parts.exhaust(view), parts.ships(view), parts.focus(view), parts.worlds(view));

    scene.metadata = {
      view: 'system',
      worldStats: view.worldStats,
      providerStats() {
        return AUR.sceneProviderStats(scene);
      },
      polishStats() {
        return {
          materialOwnsColor: sunMat.emissiveColor !== sunCol,
          coronaOwnsColor: view.sunFx.tint !== sunCol,
          baseStable: sunCol.equalsWithEpsilon(sunColInitial, 0),
          lastPulseFactor,
        };
      },
    };

    // ---- planets ----
    const topNames = planetList.slice()
      .sort((a, b) => AUR.planetWeight(b) - AUR.planetWeight(a))
      .slice(0, 3).map((p) => p.name);

    function buildPlanet(pd, i) {
      const rand = AUR.mulberry32(AUR.fnv1a(projectId + ':' + pd.name));
      const r = orbitR(i);
      const ring = AUR.orbitRing(scene, r, '#9fb0e0', 0.16, 0);
      const dia = AUR.clamp(AUR.PLANET_DIA.min + Math.sqrt(AUR.planetWeight(pd)) * 0.18, AUR.PLANET_DIA.min, AUR.PLANET_DIA.max);
      const persistent = topNames.indexOf(pd.name) >= 0;
      const world = view.makeWorld(pd.name, dia, persistent);
      const mesh = world.globe;
      mesh.metadata = { planetName: pd.name, isPlanet: true, worldType: world.spec.cls };
      const a0 = rand() * Math.PI * 2;
      AUR.orbitPoint(a0, r, 0, mesh.position);

      const label = AUR.label(gui, pd.name, {
        fontSize: 12.5, weight: '600', mesh, offsetY: -(18 + dia * 5),
      });
      // Hidden, not transparent: Babylon GUI still projects and draws a linked label at alpha 0.
      label.alpha = 0.95;
      label.isVisible = persistent;

      const rec = {
        name: pd.name, mesh, ring, world, r, a: a0,
        speed: AUR.MOTION.systemPlanetOrbitMin +
          rand() * AUR.MOTION.systemPlanetOrbitRange,
        axialSpeed: AUR.MOTION.systemPlanetAxialMin +
          rand() * AUR.MOTION.systemPlanetAxialRange,
        dia, baseScale: 1,
        label, persistent, pulseUntil: 0, appear: 1,
      };
      planets.set(pd.name, rec);
      return rec;
    }
    planetList.forEach(buildPlanet);

    const belt = parts.belt(view);

    // ---- ships ----
    AUR.shipLights(scene);
    for (const s of store.ships.values()) if (s.project === projectId) view.buildShip(s);

    // ---- interaction ----
    let hovered = null;
    // Takes back the hovered planet's label and cursor.
    function leaveHover() {
      const left = hovered && planets.get(hovered);
      if (left && !left.persistent) left.label.isVisible = false;
      canvas.style.cursor = 'default';
      hovered = null;
      view.prefetchDetail(null); // a planet the pointer only crossed is not prefetched
    }
    scene.onPointerObservable.add((pi) => {
      if (view.shipFocus) {
        leaveHover(); // the followed ship owns the pointer: no planet opens or lights up
        view.orbitShipFocus(pi);
      } else if (pi.type === BABYLON.PointerEventTypes.POINTERPICK) {
        const m = pi.pickInfo && pi.pickInfo.pickedMesh;
        if (m && m.metadata && m.metadata.isPlanet) ctx.openPlanet(projectId, m.metadata.planetName);
      } else if (pi.type === BABYLON.PointerEventTypes.POINTERMOVE) {
        const pick = scene.pick(scene.pointerX, scene.pointerY, (mm) => mm.metadata && mm.metadata.isPlanet);
        const hit = pick && pick.hit ? pick.pickedMesh.metadata.planetName : null;
        if (hit !== hovered) {
          leaveHover();
          const entered = hit && planets.get(hit);
          if (entered) {
            Object.assign(entered.label, { isVisible: true, alpha: 0.98 });
            view.prefetchDetail(entered);
          }
          hovered = hit;
        }
        canvas.style.cursor = hit ? 'pointer' : 'default';
      }
    });

    // ---- animation ----
    scene.onBeforeRenderObservable.add(() => {
      const dt = engine.getDeltaTime() / 1000;
      const now = performance.now();
      const t = now / 1000;
      lastPulseFactor = POLISH.applySunPulse(sunMat.emissiveColor, sunCol, t);
      sun.rotation.y += dt * 0.05;
      view.sunFx.update(dt);

      for (const p of planets.values()) {
        p.a += p.speed * dt;
        AUR.orbitPoint(p.a, p.r, 0, p.mesh.position);
        p.mesh.rotation.y += dt * p.axialSpeed;
        if (p.appear < 1) { p.appear = Math.min(1, p.appear + dt * 1.6); }
        let sc = p.appear;
        if (now < p.pulseUntil) {
          const f = (p.pulseUntil - now) / 600;
          sc *= 1 + 0.15 * Math.sin((1 - f) * Math.PI);
        }
        p.mesh.scaling.setAll(sc);
        p.world.update(dt);
      }
      belt.rotation.y += dt * 0.03;

      view.animateShips(dt, now, t);
      if (view.shipFocus) view.updateShipFocusCamera(false, dt);
    });

    return {
      scene,
      systemData: sys,
      update: view.update,
      focusShip: view.focusShip,
      setShipFocus: view.setShipFocus,
      clearShipFocus: view.clearShipFocus,
      shipFocusState: view.shipFocusState,
      setQuality: view.setWorldsQuality,
      dispose() {
        view.clearShipFocus();
        AUR.disposeView(scene, gui);
      },
    };
  };
})();

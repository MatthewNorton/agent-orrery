// One project's solar system: central sun, orbit rings and generated planets. The asteroid belt,
// the ships, their engine plumes, agent focus (its camera and the fade of the other ships), the
// planets' worlds and the planets themselves are the belt, ships, exhaust, focus, worlds and
// planets parts in this folder.
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

    const sky = AUR.addSky(scene, glow, ctx.skyLook, ctx.quality.sky);
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
    const planets = new Map(); // name -> record; a build finds its planet by key (AUR.planetOfBuild)
    const ships = new Map();
    // The asteroid belt sits between the middle orbits (past the last one in a small system),
    // `beltWidth` across; ships patrol outside it.
    const beltR = planetList.length >= 2 ? (orbitR(Math.floor(planetList.length / 2) - 1) + orbitR(Math.floor(planetList.length / 2))) / 2 : outer + 4;
    const ringRoot = new BABYLON.TransformNode('orbitRings', scene); // every orbit ring; Settings turns it off
    ringRoot.setEnabled(ctx.orbitRings);
    const view = {
      scene, gui, sys, projectId, orbitR, outer, beltR, beltWidth: 3.4, planets, ships, ringRoot,
      camera, canvas, glow, shipFocus: null, sysBehind: false,
      // The stream the app shows this view in; null once it is closed or another view has its place.
      shown: () => (scene.isDisposed ? null : ctx.shown(scene)),
      sun, sunHex, sunDia, worldMaps: ctx.worldMaps, quality: ctx.quality,
    };
    const parts = AUR.sceneParts.system;
    Object.assign(view, parts.exhaust(view), parts.ships(view), parts.focus(view), parts.worlds(view), parts.planets(view));

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

    planetList.forEach(view.buildPlanet); // one that cannot be built is left out, and its orbit stays empty

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
        // The system rides along for the planet card, unless a planet has started since it was read.
        if (m && m.metadata && m.metadata.isPlanet) ctx.openPlanet(projectId, m.metadata.planetName, view.sysBehind ? undefined : view.sys);
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
      // The system as last fetched: the ships part fetches it again when a build starts a planet.
      get systemData() { return view.sys; },
      update: view.update,
      focusShip: view.focusShip,
      setShipFocus: view.setShipFocus,
      clearShipFocus: view.clearShipFocus,
      shipFocusState: view.shipFocusState,
      setQuality(tier) {
        view.setWorldsQuality(tier);
        sky.setSize(tier.sky);
      },
      setSkyLook: sky.setLook,
      setOrbitRings(on) { ringRoot.setEnabled(on); },
      dispose() {
        view.clearShipFocus();
        AUR.disposeView(scene, gui);
      },
    };
  };
})();

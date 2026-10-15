// scene-universe.js — the universe map: project solar-system glyphs on a
// starfield, live ships, event pulses, click-through to a system. Glyph state,
// galaxies, ships, label layout and stats are the scene-universe-*.js parts.
'use strict';

(function () {
  const AUR = window.AUR;
  const VCS = AUR.ProjectVcsStatus;
  const UNIVERSE_SKY_LEVEL = 0.04;

  AUR.views.universe = function (engine, data, ctx) {
    const store = ctx.store;
    const canvas = engine.getRenderingCanvas();
    const scene = new BABYLON.Scene(engine);
    scene.clearColor = AUR.color4('#04050a', 1);
    scene.ambientColor = new BABYLON.Color3(0, 0, 0);

    const camera = new BABYLON.ArcRotateCamera(
      'ucam', -Math.PI / 2, 0.82, 175, BABYLON.Vector3.Zero(), scene);
    camera.attachControl(canvas, true);
    camera.lowerRadiusLimit = 60;
    camera.upperRadiusLimit = 320;
    camera.lowerBetaLimit = 0.15;
    camera.upperBetaLimit = 1.35;
    camera.panningSensibility = 0;
    camera.minZ = 0.1;
    camera.maxZ = 6000;
    AUR.configureComfortCamera(camera);

    const glow = new BABYLON.GlowLayer('uglow', scene, { blurKernelSize: 48 });
    glow.intensity = 0.9;

    // SPEC §5: skybox-001.png (seed 0), dimmed to a near-black subtle backdrop
    // so the nebula reads as a faint band — not a washed-out bright field.
    AUR.addSkybox(scene, 0, 1600, UNIVERSE_SKY_LEVEL);
    AUR.addStarfield(scene, 3200, 760);

    const gui = AUR.guiLayer(scene);
    const vcsLayer = document.createElement('div');
    vcsLayer.className = 'universe-vcs-layer';
    vcsLayer.setAttribute('aria-label', 'Project repository status');
    document.body.appendChild(vcsLayer);

    // State shared with the scene-universe-*.js parts.
    const glyphs = new Map(); // projectId -> glyph record
    const ships = new Map();  // shipId -> ship record
    const galaxies = new Map(); // galaxy key -> rendered region record
    const view = {
      engine, scene, canvas, camera, gui, store, glyphs, ships, galaxies, glow,
      softDisc: AUR.softDiscTexture(scene), coronaMaterials: new Map(),
      skyLevel: UNIVERSE_SKY_LEVEL, searchMatchIds: null, hoveredProjectId: null,
    };
    const parts = AUR.sceneParts.universe;
    Object.assign(view, parts.labels(view), parts.glyphs(view), parts.stars(view),
      parts.galaxies(view), parts.ships(view), parts.stats(view));

    // ---- glyphs ----
    // Suns come in five colours, so five corona materials serve every glyph.
    function coronaMaterial(hex) {
      let material = view.coronaMaterials.get(hex);
      if (!material) {
        material = AUR.softMaterial(scene, 'corona:' + hex, AUR.color3(hex).scale(0.85), 1, view.softDisc);
        view.coronaMaterials.set(hex, material);
      }
      return material;
    }

    function buildGlyph(p) {
      const rand = AUR.mulberry32(p.seed >>> 0);

      const root = new BABYLON.TransformNode('g_' + p.id, scene);
      root.position.set(0, 0, 0);

      const dia = 1.2 + Math.log10((p.totalBytes || 0) + 1) * 0.35;
      const sunR = dia / 2;
      const sun = BABYLON.MeshBuilder.CreateSphere('sun_' + p.id, { diameter: dia, segments: 16 }, scene);
      sun.parent = root;
      sun.metadata = { projectId: p.id, isSun: true, projectExists: p.exists !== false };
      const sunMat = new BABYLON.StandardMaterial('sunm_' + p.id, scene);
      const col = AUR.color3(AUR.sunColor(p.seed));
      // Give the material its OWN emissive Color3. The per-frame pulse does
      // `emissiveColor.copyFrom(baseEmissive).scaleInPlace(k)`; if the material's
      // color and baseEmissive were the same object, copyFrom would be a no-op
      // self-copy and scaleInPlace would shrink the shared base every frame,
      // decaying the sun to black (~0.68/frame idle). Keep `col` pristine.
      sunMat.emissiveColor = col.clone();
      sunMat.diffuseColor = new BABYLON.Color3(0, 0, 0);
      sunMat.specularColor = new BABYLON.Color3(0, 0, 0);
      sun.material = sunMat;

      // A soft corona behind the sun, in its colour, always facing the camera. The glow layer
      // ignores opacity textures, so it stays out of the glow pass.
      const corona = BABYLON.MeshBuilder.CreatePlane('corona_' + p.id, { size: dia * 2.4 }, scene);
      corona.parent = root;
      corona.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
      corona.isPickable = false;
      corona.material = coronaMaterial(AUR.sunColor(p.seed));
      glow.addExcludedMesh(corona);

      // One reusable alert halo per glyph. It stays disabled until a main
      // ship in this project needs a question answered or permission granted.
      const halo = BABYLON.MeshBuilder.CreateTorus('alert_' + p.id, {
        diameter: Math.max(3.2, dia * 1.9), thickness: 0.13, tessellation: 48,
      }, scene);
      halo.parent = root;
      halo.isPickable = false;
      const haloMat = new BABYLON.StandardMaterial('alertm_' + p.id, scene);
      haloMat.emissiveColor = new BABYLON.Color3(0, 0, 0);
      haloMat.diffuseColor = new BABYLON.Color3(0, 0, 0);
      haloMat.specularColor = new BABYLON.Color3(0, 0, 0);
      haloMat.alpha = 0;
      halo.material = haloMat;
      halo.setEnabled(false);

      // rings + planet dots
      const ringN = 2 + Math.floor(rand() * 2); // 2-3
      const planetN = 3 + Math.floor(rand() * 3); // 3-5
      const ringBase = sunR + 2.4;
      const ringRadii = [];
      for (let i = 0; i < ringN; i++) ringRadii.push(ringBase + i * 2.0);
      const rings = [];
      for (const rr of ringRadii) {
        const ring = AUR.orbitRing(scene, rr, '#9fb0e0', 0.22, 0);
        ring.parent = root;
        rings.push(ring);
      }
      const dots = [];
      const dotColors = ['#7ea6ff', '#c0965f', '#8fb08a', '#b9c2d8', '#d98f6a'];
      for (let i = 0; i < planetN; i++) {
        const rr = ringRadii[i % ringRadii.length];
        const a = rand() * Math.PI * 2;
        const dot = BABYLON.MeshBuilder.CreateSphere('dot', { diameter: 0.3 + rand() * 0.35, segments: 8 }, scene);
        dot.parent = root;
        dot.position.set(Math.cos(a) * rr, 0, Math.sin(a) * rr);
        const dm = new BABYLON.StandardMaterial('dm', scene);
        const dc = AUR.color3(dotColors[i % dotColors.length]);
        dm.emissiveColor = dc.scale(0.55);
        dm.diffuseColor = dc.scale(0.4);
        dm.specularColor = new BABYLON.Color3(0, 0, 0);
        dot.material = dm;
        dots.push({
          mesh: dot,
          r: rr,
          a,
          speed: AUR.MOTION.universePlanetOrbitMin +
            rand() * AUR.MOTION.universePlanetOrbitRange,
        });
      }

      const label = AUR.label(gui, String(p.name), { fontSize: 13, weight: '600', color: '#eeece6' });
      label.name = 'project-label:' + p.id;
      label.linkWithMesh(sun);
      const labelOffsetY = -(24 + sunR * 6);
      label.linkOffsetY = labelOffsetY;
      label.isVisible = false;

      const markerHost = document.createElement('span');
      markerHost.className = 'universe-project-vcs-marker hidden';
      markerHost.dataset.projectId = p.id;
      VCS.renderMarkers(markerHost, p);
      vcsLayer.appendChild(markerHost);

      const g = {
        id: p.id, root, sun, sunMat, corona, baseEmissive: col, rings, dots, label,
        markerHost,
        galaxyKey: null,
        halo, haloMat, attention: null,
        lastActivity: p.lastActivity || 0, recencyRank: Number.MAX_SAFE_INTEGER,
        labelBaseAlpha: 0.85, labelWidth: Math.min(260, Math.max(60, label.text.length * 7.6)),
        labelOffsetY, labelScreen: null,
        sunR, pulseUntil: 0, phase: rand() * Math.PI * 2, appear: 0,
        derelict: false, searchFactor: 1, searchLabelFactor: 1,
      };
      view.applyGlyphState(g);
      glyphs.set(p.id, g);
      return g;
    }

    // ---- init from store ----
    // Keep every system pickable. Readability comes from label selection,
    // never from silently dropping projects from the universe.
    for (const p of store.projects.values()) buildGlyph(p);
    view.refreshRecencyRanks();
    view.rebuildGalaxyLayout();
    for (const s of store.ships.values()) if (glyphs.has(s.project)) view.buildShip(s);

    // ---- interaction ----
    scene.onPointerObservable.add((pi) => {
      if (pi.type === BABYLON.PointerEventTypes.POINTERPICK) {
        const m = pi.pickInfo && pi.pickInfo.pickedMesh;
        if (m && m.metadata && m.metadata.isSun) ctx.openSystem(m.metadata.projectId);
      } else if (pi.type === BABYLON.PointerEventTypes.POINTERMOVE) {
        const pick = scene.pick(scene.pointerX, scene.pointerY, (mm) => mm.metadata && mm.metadata.isSun);
        const nextHovered = pick && pick.hit ? pick.pickedMesh.metadata.projectId : null;
        canvas.style.cursor = nextHovered ? 'pointer' : 'default';
        if (nextHovered !== view.hoveredProjectId) {
          view.hoveredProjectId = nextHovered;
          view.markLabelLayoutDirty();
        }
      }
    });

    // ---- animation ----
    scene.onBeforeRenderObservable.add(() => {
      const dt = engine.getDeltaTime() / 1000;
      const now = performance.now();
      const t = now / 1000;
      if (view.cameraLayoutChanged()) view.markLabelLayoutDirty();
      view.animateGlyphs(dt, now, t);
      view.animateShips(dt, now, t);
    });

    // ---- live updates ----
    function update(batch) {
      let structuralLayout = false;
      let recencyDirty = false;
      for (const ev of batch) {
        if (ev.type === 'project-added') {
          if (!glyphs.has(ev.project.id)) {
            buildGlyph(ev.project);
            structuralLayout = true;
            recencyDirty = true;
          }
        } else if (ev.type === 'project-updated') {
          const g = glyphs.get(ev.project.id);
          if (g) {
            const nextGalaxyKey = ev.project.galaxy && ev.project.galaxy.key
              ? ev.project.galaxy.key
              : (ev.project.exists === false ? 'graveyard' : 'unassigned');
            if (g.galaxyKey !== nextGalaxyKey) structuralLayout = true;
            view.refreshProjectLabel(g, ev.project);
            view.applyGlyphState(g);
            recencyDirty = true;
          }
        } else if (ev.type === 'ship-spawned') {
          const g = glyphs.get(ev.ship.project);
          if (g && !ships.has(ev.ship.id)) view.buildShip(ev.ship);
          if (g) view.applyGlyphState(g);
        } else if (ev.type === 'ship-updated') {
          const g = glyphs.get(ev.ship.project);
          if (g) view.applyGlyphState(g);
        } else if (ev.type === 'ship-departed') {
          const r = ships.get(ev.shipId);
          const proj = r && r.mesh && r.mesh.parent ? r.mesh.parent.name.slice(2) : null;
          view.removeShip(ev.shipId);
          if (proj && glyphs.has(proj)) view.applyGlyphState(glyphs.get(proj));
        } else if (ev.type === 'build' || ev.type === 'activity') {
          const g = glyphs.get(ev.project);
          if (g) g.pulseUntil = performance.now() + 500;
        } else if (ev.type === 'project-vcs-status') {
          const g = glyphs.get(ev.projectId);
          const project = store.projects.get(ev.projectId);
          if (g && project) {
            view.refreshProjectLabel(g, project);
            view.applyGlyphSearchState(g);
            view.markLabelLayoutDirty();
          }
        }
      }
      if (recencyDirty) view.refreshRecencyRanks();
      if (structuralLayout) view.rebuildGalaxyLayout();
    }

    scene.metadata = {
      view: 'universe',
      galaxyStats: view.galaxyStats,
      providerStats() {
        return AUR.sceneProviderStats(scene);
      },
      searchStats: view.searchStats,
      vcsStats: view.vcsStats,
      polishStats: view.polishStats,
    };

    scene.executeWhenReady(() => {});

    return {
      scene,
      update,
      setSearchMatches: view.setSearchMatches,
      resize: view.reframeCamera,
      dispose() {
        view.cancelLabelLayout();
        scene.onBeforeRenderObservable.clear();
        scene.onPointerObservable.clear();
        canvas.style.cursor = 'default';
        vcsLayer.remove();
        gui.dispose();
        AUR.ships.dispose(scene);
        scene.dispose();
      },
    };
  };
})();

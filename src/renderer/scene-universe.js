// scene-universe.js — the universe map: project solar-system glyphs on a
// starfield, live ships, event pulses, click-through to a system.
'use strict';

(function () {
  const AUR = window.AUR;
  const POLISH = window.AUR_POLISH;
  const GALAXY = window.AUR_GALAXY;
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

    // ---- glyphs ----
    const glyphs = new Map(); // projectId -> glyph record
    const ships = new Map();  // shipId -> ship record
    const galaxies = new Map(); // galaxy key -> rendered region record
    let hoveredProjectId = null;
    let searchMatchIds = null;
    let labelLayoutDirty = true;
    let labelLayoutTimer = null;
    let lastLabelMetrics = null;
    const lastCameraLayout = {
      alpha: NaN, beta: NaN, radius: NaN,
      tx: NaN, ty: NaN, tz: NaN, width: 0, height: 0,
    };

    function markLabelLayoutDirty() {
      labelLayoutDirty = true;
      if (labelLayoutTimer != null) return;
      labelLayoutTimer = setTimeout(() => {
        labelLayoutTimer = null;
        if (labelLayoutDirty && !scene.isDisposed) updateLabelLayout();
      }, 16);
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

      const label = AUR.label(gui, 'PROJECT: ' + String(p.name).toUpperCase(),
        { fontSize: 15, weight: 'bold', color: '#e9edf8' });
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
        id: p.id, root, sun, sunMat, baseEmissive: col, rings, dots, label,
        markerHost,
        galaxyKey: null,
        halo, haloMat, attention: null,
        lastActivity: p.lastActivity || 0, recencyRank: Number.MAX_SAFE_INTEGER,
        labelBaseAlpha: 0.8, labelWidth: Math.min(300, Math.max(88, label.text.length * 8.4)),
        labelOffsetY, labelScreen: null,
        sunR, pulseUntil: 0, phase: rand() * Math.PI * 2, appear: 0,
        derelict: false, searchFactor: 1, searchLabelFactor: 1,
      };
      applyGlyphState(g);
      glyphs.set(p.id, g);
      return g;
    }

    function shipCount(projectId) {
      let n = 0;
      for (const s of store.ships.values()) if (s.project === projectId) n++;
      return n;
    }

    function projectAttention(projectId) {
      let state = null;
      for (const s of store.ships.values()) {
        if (s.project !== projectId) continue;
        if (s.attention === 'question') return 'question';
        if (s.attention === 'permission') state = 'permission';
      }
      return state;
    }

    function applyAttentionHalo(g) {
      const attention = projectAttention(g.id);
      if (attention === g.attention) return;
      g.attention = attention;
      if (!attention) {
        g.haloMat.alpha = 0;
        g.halo.setEnabled(false);
        return;
      }
      g.haloMat.emissiveColor.copyFrom(AUR.color3(AUR.attentionColor(attention)));
      g.halo.setEnabled(true);
    }

    function applyGlyphState(g) {
      const p = store.projects.get(g.id);
      const online = shipCount(g.id) > 0;
      const derelict = p && p.exists === false;
      let mul, alpha;
      if (derelict) { mul = 0.4; alpha = 0.4; }
      else if (online) { mul = 1.0; alpha = 1.0; }
      else { mul = 0.68; alpha = 0.8; }
      g.online = online && !derelict;
      g.mul = mul;
      g.derelict = Boolean(derelict);
      g.labelBaseAlpha = alpha;
      if (p) g.lastActivity = p.lastActivity || 0;
      applyGlyphSearchState(g);
      applyAttentionHalo(g);
      markLabelLayoutDirty();
    }

    function applyGlyphSearchState(g) {
      const active = searchMatchIds !== null;
      const matched = active && searchMatchIds.has(g.id);
      g.searchFactor = active ? (matched ? 1.45 : 0.18) : 1;
      g.searchLabelFactor = active ? (matched ? 1 : 0.2) : 1;
      const ringAlpha = g.derelict ? 0.1 : 0.22;
      for (const ring of g.rings) ring.alpha = ringAlpha * g.searchFactor;
      for (const dot of g.dots) {
        if (dot.mesh && dot.mesh.material) dot.mesh.material.alpha = active && !matched ? 0.18 : 1;
      }
      if (g.markerHost) g.markerHost.style.opacity = String(active && !matched ? 0.16 : 1);
    }

    function setSearchMatches(ids) {
      searchMatchIds = ids == null ? null : new Set(ids);
      for (const g of glyphs.values()) applyGlyphSearchState(g);
      markLabelLayoutDirty();
    }

    // ---- deterministic galaxy regions ----
    function galaxyLabelText(spec, memberCount) {
      if (spec.key === 'graveyard') {
        return 'GRAVEYARD · ' + memberCount + ' DERELICT' + (memberCount === 1 ? '' : 'S');
      }
      return 'GALAXY: ' + String(spec.label).toUpperCase() + ' · ' + memberCount +
        ' SYSTEM' + (memberCount === 1 ? '' : 'S');
    }

    function buildGalaxyVisual(spec, memberCount) {
      const colorHex = GALAXY.galaxyColor(spec.key);
      const color = AUR.color3(colorHex);
      const region = BABYLON.MeshBuilder.CreateDisc('galaxy-region:' + spec.key, {
        radius: 1, tessellation: 64, sideOrientation: BABYLON.Mesh.DOUBLESIDE,
      }, scene);
      region.rotation.x = Math.PI / 2;
      region.isPickable = false;
      region.metadata = { isGalaxyRegion: true, galaxyKey: spec.key };
      const material = new BABYLON.StandardMaterial('galaxy-region-mat:' + spec.key, scene);
      material.emissiveColor = color.scale(spec.key === 'graveyard' ? 0.025 : 0.04);
      material.diffuseColor = new BABYLON.Color3(0, 0, 0);
      material.specularColor = new BABYLON.Color3(0, 0, 0);
      material.alpha = spec.key === 'graveyard' ? 0.045 : 0.055;
      material.backFaceCulling = false;
      material.disableDepthWrite = true;
      region.material = material;

      const outline = AUR.orbitRing(scene, 1, colorHex,
        spec.key === 'graveyard' ? 0.12 : 0.19, -2.35);
      outline.name = 'galaxy-outline:' + spec.key;
      outline.isPickable = false;
      outline.metadata = { isGalaxyOutline: true, galaxyKey: spec.key };

      const label = AUR.label(gui, galaxyLabelText(spec, memberCount), {
        fontSize: 14, weight: 'bold', color: colorHex, outline: 5,
      });
      label.name = 'galaxy-label:' + spec.key;
      label.linkWithMesh(outline);
      label.linkOffsetY = -12;
      label.isVisible = false;

      const record = {
        key: spec.key, labelText: spec.label, colorHex,
        x: spec.x, z: spec.z, radius: spec.radius, memberCount,
        region, material, outline, label,
        labelWidth: Math.min(330, Math.max(130, label.text.length * 8.1)),
        labelOffsetY: -12, labelScreen: null,
      };
      updateGalaxyVisual(record, spec, memberCount);
      galaxies.set(spec.key, record);
      return record;
    }

    function updateGalaxyVisual(record, spec, memberCount) {
      record.x = spec.x;
      record.z = spec.z;
      record.radius = spec.radius;
      record.memberCount = memberCount;
      record.labelText = spec.label;
      record.region.position.set(spec.x, -2.5, spec.z);
      record.region.scaling.set(spec.radius, spec.radius, 1);
      record.outline.position.set(spec.x, 0, spec.z);
      record.outline.scaling.set(spec.radius, 1, spec.radius);
      record.label.text = galaxyLabelText(spec, memberCount);
      record.labelWidth = Math.min(330, Math.max(130, record.label.text.length * 8.1));
    }

    function disposeGalaxyVisual(record) {
      if (!record) return;
      if (record.label) record.label.dispose();
      if (record.outline) record.outline.dispose();
      if (record.region) record.region.dispose();
      if (record.material) record.material.dispose();
    }

    function refreshProjectLabel(g, project) {
      if (!g || !project) return;
      g.sun.metadata.projectExists = project.exists !== false;
      const text = 'PROJECT: ' + String(project.name).toUpperCase();
      if (g.label.text !== text) {
        g.label.text = text;
        g.labelWidth = Math.min(300, Math.max(88, text.length * 8.4));
      }
      if (g.markerHost) VCS.renderMarkers(g.markerHost, project);
    }

    function rebuildGalaxyLayout() {
      const layout = GALAXY.layoutGalaxyProjects([...store.projects.values()]);
      const galaxySpecs = new Map(layout.galaxies.map((item) => [item.key, item]));
      const projectSpecs = new Map(layout.projects.map((item) => [item.id, item]));
      const memberCounts = new Map();
      for (const item of layout.projects) {
        memberCounts.set(item.galaxyKey, (memberCounts.get(item.galaxyKey) || 0) + 1);
      }

      for (const [key, record] of galaxies) {
        if (galaxySpecs.has(key)) continue;
        disposeGalaxyVisual(record);
        galaxies.delete(key);
      }
      for (const spec of layout.galaxies) {
        const count = memberCounts.get(spec.key) || 0;
        const record = galaxies.get(spec.key);
        if (record) updateGalaxyVisual(record, spec, count);
        else buildGalaxyVisual(spec, count);
      }

      for (const g of glyphs.values()) {
        const project = store.projects.get(g.id);
        const spec = projectSpecs.get(g.id);
        if (!project || !spec) continue;
        const y = ((((project.seed >>> 0) % 1009) / 1008) - 0.5) * 6;
        g.root.position.set(spec.x, y, spec.z);
        g.galaxyKey = spec.galaxyKey;
        refreshProjectLabel(g, project);
      }
      markLabelLayoutDirty();
      frameCamera();
    }

    // ---- ships ----
    function buildShip(s) {
      const g = glyphs.get(s.project);
      const tint = AUR.shipTint(s.id, s.provider);
      const signal = AUR.isSignalEntity(s);
      const scale = signal ? 0.64 : 1.0;
      let mesh = signal
        ? AUR.signalMarker(scene, 'usig_' + s.id, tint)
        : AUR.ships.instantiate(scene, s);
      const usedFallback = !signal && !mesh;
      if (usedFallback) mesh = AUR.dartMesh(scene, 'ushp_' + s.id, tint, scale);
      else mesh.scaling.setAll(scale);
      const provider = AUR.markShipMesh(mesh, s);
      const rand = AUR.mulberry32(AUR.fnv1a(s.id));
      const rec = {
        id: s.id, mesh, kind: s.kind, tint, providerKey: provider.key,
        r: 5 + rand() * 2.5, a: rand() * Math.PI * 2,
        speed: (AUR.MOTION.universeShipOrbitMin +
          rand() * AUR.MOTION.universeShipOrbitRange) * (rand() > 0.5 ? 1 : -1),
        bob: rand() * Math.PI * 2, born: performance.now(),
      };
      mesh.parent = g.root;
      if (usedFallback) AUR.ships.upgrade(scene, s, mesh, scale);
      ships.set(s.id, rec);
      return rec;
    }

    function removeShip(id) {
      const r = ships.get(id);
      if (!r) return;
      if (r.mesh) {
        const material = r.mesh.material;
        const sharedAssetMaterial = Boolean(r.mesh.metadata && r.mesh.metadata.assetHullId);
        r.mesh.dispose();
        if (material && !sharedAssetMaterial) material.dispose();
      }
      ships.delete(id);
    }

    // ---- init from store ----
    // Keep every system pickable. Readability comes from label selection,
    // never from silently dropping projects from the universe.
    function refreshRecencyRanks() {
      const ordered = [...glyphs.values()].sort((a, b) => {
        const pa = store.projects.get(a.id);
        const pb = store.projects.get(b.id);
        const ax = pa && pa.exists ? 1 : 0;
        const bx = pb && pb.exists ? 1 : 0;
        if (ax !== bx) return bx - ax;
        const recent = (b.lastActivity || 0) - (a.lastActivity || 0);
        return recent || String(a.id).localeCompare(String(b.id));
      });
      ordered.forEach((g, index) => { g.recencyRank = index; });
      markLabelLayoutDirty();
    }
    for (const p of store.projects.values()) buildGlyph(p);
    refreshRecencyRanks();
    rebuildGalaxyLayout();
    for (const s of store.ships.values()) if (glyphs.has(s.project)) buildShip(s);

    function frameCamera() {
      if (galaxies.size === 0) return;
      let minX = Infinity; let maxX = -Infinity;
      let minZ = Infinity; let maxZ = -Infinity;
      for (const galaxy of galaxies.values()) {
        minX = Math.min(minX, galaxy.x - galaxy.radius);
        maxX = Math.max(maxX, galaxy.x + galaxy.radius);
        minZ = Math.min(minZ, galaxy.z - galaxy.radius);
        maxZ = Math.max(maxZ, galaxy.z + galaxy.radius);
      }
      const cx = (minX + maxX) / 2;
      const cz = (minZ + maxZ) / 2;
      const extent = Math.max((maxX - minX) / 2, (maxZ - minZ) / 2);
      // ArcRotate perspective and the reserved overlay gutters need more than
      // a diameter-only fit. Keep every region edge on canvas even when a
      // peripheral Graveyard makes the world bounds strongly asymmetric.
      const desiredRadius = Math.max(90, extent * 2.55 + 44);
      camera.upperRadiusLimit = Math.max(320, desiredRadius * 1.25);
      camera.setTarget(new BABYLON.Vector3(cx, 0, cz));
      camera.radius = Math.min(desiredRadius, camera.upperRadiusLimit);
    }

    // ---- interaction ----
    scene.onPointerObservable.add((pi) => {
      if (pi.type === BABYLON.PointerEventTypes.POINTERPICK) {
        const m = pi.pickInfo && pi.pickInfo.pickedMesh;
        if (m && m.metadata && m.metadata.isSun) ctx.openSystem(m.metadata.projectId);
      } else if (pi.type === BABYLON.PointerEventTypes.POINTERMOVE) {
        const pick = scene.pick(scene.pointerX, scene.pointerY, (mm) => mm.metadata && mm.metadata.isSun);
        const nextHovered = pick && pick.hit ? pick.pickedMesh.metadata.projectId : null;
        canvas.style.cursor = nextHovered ? 'pointer' : 'default';
        if (nextHovered !== hoveredProjectId) {
          hoveredProjectId = nextHovered;
          markLabelLayoutDirty();
        }
      }
    });

    function cameraLayoutChanged() {
      const target = camera.target;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const changed =
        Math.abs(camera.alpha - lastCameraLayout.alpha) > 0.0001 ||
        Math.abs(camera.beta - lastCameraLayout.beta) > 0.0001 ||
        Math.abs(camera.radius - lastCameraLayout.radius) > 0.01 ||
        Math.abs(target.x - lastCameraLayout.tx) > 0.001 ||
        Math.abs(target.y - lastCameraLayout.ty) > 0.001 ||
        Math.abs(target.z - lastCameraLayout.tz) > 0.001 ||
        width !== lastCameraLayout.width || height !== lastCameraLayout.height;
      if (!changed) return false;
      lastCameraLayout.alpha = camera.alpha;
      lastCameraLayout.beta = camera.beta;
      lastCameraLayout.radius = camera.radius;
      lastCameraLayout.tx = target.x;
      lastCameraLayout.ty = target.y;
      lastCameraLayout.tz = target.z;
      lastCameraLayout.width = width;
      lastCameraLayout.height = height;
      return true;
    }

    function labelPointIsClear(rect) {
      if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return false;
      const inset = 2;
      const points = [
        [rect.x + rect.width / 2, rect.y + rect.height / 2],
        [rect.x + inset, rect.y + inset],
        [rect.x + rect.width - inset, rect.y + inset],
        [rect.x + inset, rect.y + rect.height - inset],
        [rect.x + rect.width - inset, rect.y + rect.height - inset],
      ];
      return points.every(([x, y]) => document.elementFromPoint(x, y) === canvas);
    }

    function updateLabelLayout() {
      labelLayoutDirty = false;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const bounds = { x: 8, y: 64, width: Math.max(1, width - 354), height: Math.max(1, height - 72) };
      const renderEngine = scene.getEngine();
      const activeCamera = scene.activeCamera;
      const renderWidth = renderEngine.getRenderWidth();
      const renderHeight = renderEngine.getRenderHeight();
      const viewport = activeCamera.viewport.toGlobal(renderWidth, renderHeight);
      const recentLimit = camera.radius < 105 ? Number.MAX_SAFE_INTEGER
        : camera.radius < 150 ? 12
          : camera.radius < 220 ? 8 : 6;
      const candidates = [];
      let finiteProjections = 0;

      for (const g of glyphs.values()) {
        g.sun.computeWorldMatrix(true);
        const worldCenter = g.sun.getBoundingInfo().boundingSphere.centerWorld;
        const projected = BABYLON.Vector3.Project(
          worldCenter, BABYLON.Matrix.IdentityReadOnly,
          scene.getTransformMatrix(), viewport);
        const centerX = projected.x * width / renderWidth;
        const projectedY = projected.y * height / renderHeight;
        if (!Number.isFinite(centerX) || !Number.isFinite(projectedY) || !Number.isFinite(projected.z)) {
          g.label.isVisible = false;
          g.label.alpha = 0;
          g.labelScreen = null;
          if (g.markerHost) g.markerHost.classList.add('hidden');
          continue;
        }
        finiteProjections++;
        const centerY = projectedY + g.labelOffsetY;
        const rect = {
          x: centerX - g.labelWidth / 2,
          y: centerY - 11,
          width: g.labelWidth,
          height: 22,
        };
        const searchMatched = searchMatchIds !== null && searchMatchIds.has(g.id);
        const priority = searchMatched ? 0 : g.id === hoveredProjectId ? 0
          : g.attention ? 1
            : g.online ? 3 : 4;
        const eligible = priority < 4 || g.recencyRank < recentLimit;
        const onScreen = projected.z >= 0 && projected.z <= 1 && labelPointIsClear(rect);
        g.labelScreen = {
          id: g.id, x: centerX, y: projectedY,
          rect, eligible, visible: false,
          markerVisible: projected.z >= 0 && projected.z <= 1 &&
            centerX >= bounds.x && centerX <= bounds.x + bounds.width &&
            projectedY >= bounds.y && projectedY <= bounds.y + bounds.height,
        };
        if (!eligible || !onScreen) continue;
        candidates.push({
          id: g.id, kind: 'project', rect, priority,
          lastActivity: g.lastActivity,
          alpha: (priority < 4 ? 1 : Math.min(0.9, g.labelBaseAlpha)) * g.searchLabelFactor,
        });
      }

      // In pathological one-project-per-galaxy maps, showing a label for every
      // region would consume every project-label slot. Keep the three most
      // populous/stably-late galaxy labels eligible at overview scale; normal
      // maps (including the four-galaxy contract fixture) keep every galaxy.
      const galaxyCandidateLimit = galaxies.size > 12 ? 3 : galaxies.size;
      const galaxyCandidateKeys = new Set([...galaxies.values()]
        .sort((a, b) => b.memberCount - a.memberCount || b.key.localeCompare(a.key))
        .slice(0, galaxyCandidateLimit)
        .map((galaxy) => galaxy.key));
      let finiteGalaxyProjections = 0;
      for (const galaxy of galaxies.values()) {
        galaxy.outline.computeWorldMatrix(true);
        const worldCenter = galaxy.outline.getBoundingInfo().boundingSphere.centerWorld;
        const projected = BABYLON.Vector3.Project(
          worldCenter, BABYLON.Matrix.IdentityReadOnly,
          scene.getTransformMatrix(), viewport);
        const centerX = projected.x * width / renderWidth;
        const projectedY = projected.y * height / renderHeight;
        if (!Number.isFinite(centerX) || !Number.isFinite(projectedY) || !Number.isFinite(projected.z)) {
          galaxy.label.isVisible = false;
          galaxy.label.alpha = 0;
          galaxy.labelScreen = null;
          continue;
        }
        finiteGalaxyProjections++;
        const centerY = projectedY + galaxy.labelOffsetY;
        const rect = {
          x: centerX - galaxy.labelWidth / 2,
          y: centerY - 11,
          width: galaxy.labelWidth,
          height: 22,
        };
        const onScreen = projected.z >= 0 && projected.z <= 1 && labelPointIsClear(rect);
        const id = 'galaxy:' + galaxy.key;
        const eligible = galaxyCandidateKeys.has(galaxy.key);
        galaxy.labelScreen = {
          id, key: galaxy.key, x: centerX, y: projectedY,
          rect, eligible, visible: false,
        };
        if (!eligible || !onScreen) continue;
        candidates.push({
          id, kind: 'galaxy', rect, priority: 2,
          lastActivity: Number.MAX_SAFE_INTEGER, alpha: 0.96,
        });
      }

      const selected = POLISH.selectLabelLayout(candidates, bounds, 6);
      const selectedById = new Map(selected.map((item) => [item.id, item]));
      for (const g of glyphs.values()) {
        const placed = selectedById.get(g.id);
        g.label.isVisible = Boolean(placed);
        g.label.alpha = placed ? placed.alpha : 0;
        if (g.labelScreen) g.labelScreen.visible = Boolean(placed);
        if (g.markerHost) {
          const empty = Boolean(g.markerHost.querySelector('.project-vcs-markers-empty'));
          const visible = !empty && g.labelScreen && g.labelScreen.markerVisible;
          g.markerHost.classList.toggle('hidden', !visible);
          if (visible) {
            const x = placed ? placed.rect.x + placed.rect.width : g.labelScreen.x;
            const y = placed ? placed.rect.y + placed.rect.height / 2 : g.labelScreen.y;
            g.markerHost.style.left = `${Math.round(x)}px`;
            g.markerHost.style.top = `${Math.round(y)}px`;
          }
        }
      }
      for (const galaxy of galaxies.values()) {
        const placed = selectedById.get('galaxy:' + galaxy.key);
        galaxy.label.isVisible = Boolean(placed);
        galaxy.label.alpha = placed ? placed.alpha : 0;
        if (galaxy.labelScreen) galaxy.labelScreen.visible = Boolean(placed);
      }

      let overlaps = 0;
      for (let i = 0; i < selected.length; i++) {
        for (let j = i + 1; j < selected.length; j++) {
          if (POLISH.rectsOverlap(selected[i].rect, selected[j].rect, 6)) overlaps++;
        }
      }
      const selectedProjects = selected.filter((item) => item.kind === 'project');
      const selectedGalaxies = selected.filter((item) => item.kind === 'galaxy');
      lastLabelMetrics = {
        glyphCount: glyphs.size,
        totalLabels: glyphs.size,
        visibleLabels: selectedProjects.length,
        hiddenLabels: glyphs.size - selectedProjects.length,
        overlaps,
        hoveredProjectId,
        cameraRadius: camera.radius,
        skyLevel: UNIVERSE_SKY_LEVEL,
        finiteProjections,
        labels: [...glyphs.values()].map((g) => g.labelScreen),
        visibleGalaxyLabels: selectedGalaxies.length,
        finiteGalaxyProjections,
        galaxyLabels: [...galaxies.values()].map((galaxy) => galaxy.labelScreen),
      };
      if (finiteProjections < glyphs.size) markLabelLayoutDirty();
    }

    function measuredLabelStats() {
      const scaleX = canvas.clientWidth / engine.getRenderWidth();
      const scaleY = canvas.clientHeight / engine.getRenderHeight();
      const bounds = {
        x: 8, y: 64,
        width: Math.max(1, canvas.clientWidth - 354),
        height: Math.max(1, canvas.clientHeight - 72),
      };
      const measured = [];
      const combined = [];
      let chromeOcclusions = 0;
      let combinedChromeOcclusions = 0;
      for (const g of glyphs.values()) {
        if (!g.label.isVisible) continue;
        const value = g.label._currentMeasure;
        if (!value) continue;
        const rect = {
          x: value.left * scaleX,
          y: value.top * scaleY,
          width: value.width * scaleX,
          height: value.height * scaleY,
        };
        if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) continue;
        measured.push({ id: g.id, rect });
        combined.push({ id: g.id, kind: 'project', rect });
        const inside = rect.x >= bounds.x && rect.y >= bounds.y &&
          rect.x + rect.width <= bounds.x + bounds.width &&
          rect.y + rect.height <= bounds.y + bounds.height;
        if (!inside || !labelPointIsClear(rect)) {
          chromeOcclusions++;
          combinedChromeOcclusions++;
        }
      }
      let measuredGalaxyLabelCount = 0;
      for (const galaxy of galaxies.values()) {
        if (!galaxy.label.isVisible) continue;
        const value = galaxy.label._currentMeasure;
        if (!value) continue;
        const rect = {
          x: value.left * scaleX,
          y: value.top * scaleY,
          width: value.width * scaleX,
          height: value.height * scaleY,
        };
        if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) continue;
        measuredGalaxyLabelCount++;
        combined.push({ id: 'galaxy:' + galaxy.key, kind: 'galaxy', rect });
        const inside = rect.x >= bounds.x && rect.y >= bounds.y &&
          rect.x + rect.width <= bounds.x + bounds.width &&
          rect.y + rect.height <= bounds.y + bounds.height;
        if (!inside || !labelPointIsClear(rect)) combinedChromeOcclusions++;
      }
      let overlaps = 0;
      for (let i = 0; i < measured.length; i++) {
        for (let j = i + 1; j < measured.length; j++) {
          if (POLISH.rectsOverlap(measured[i].rect, measured[j].rect, 6)) overlaps++;
        }
      }
      let combinedOverlaps = 0;
      for (let i = 0; i < combined.length; i++) {
        for (let j = i + 1; j < combined.length; j++) {
          if (POLISH.rectsOverlap(combined[i].rect, combined[j].rect, 6)) combinedOverlaps++;
        }
      }
      return {
        pickableSunCount: scene.meshes.filter(
          (mesh) => mesh.isPickable && mesh.metadata && mesh.metadata.isSun
        ).length,
        labelControlCount: gui.rootContainer.children.filter(
          (control) => String(control.name || '').startsWith('project-label:')
        ).length,
        measuredLabelCount: measured.length,
        measuredOverlaps: overlaps,
        measuredChromeOcclusions: chromeOcclusions,
        measuredGalaxyLabelCount,
        combinedMeasuredOverlaps: combinedOverlaps,
        combinedChromeOcclusions,
      };
    }

    function galaxyStats(measuredStats) {
      if (labelLayoutDirty || !lastLabelMetrics) updateLabelLayout();
      const measured = measuredStats || measuredLabelStats();
      const regionMeshes = scene.meshes.filter(
        (mesh) => mesh.metadata && mesh.metadata.isGalaxyRegion
      );
      const assignments = [];
      let assignmentMismatchCount = 0;
      let memberOutsideCount = 0;

      for (const g of glyphs.values()) {
        const project = store.projects.get(g.id);
        const expectedKey = project && project.galaxy && project.galaxy.key
          ? project.galaxy.key : (project && project.exists === false ? 'graveyard' : 'unassigned');
        const galaxy = galaxies.get(g.galaxyKey);
        g.root.computeWorldMatrix(true);
        const position = g.root.getAbsolutePosition();
        const distance = galaxy
          ? Math.hypot(position.x - galaxy.region.position.x, position.z - galaxy.region.position.z)
          : Infinity;
        if (g.galaxyKey !== expectedKey) assignmentMismatchCount++;
        if (!galaxy || distance > galaxy.region.scaling.x + 1e-6) memberOutsideCount++;
        assignments.push({
          projectId: g.id, expectedGalaxyKey: expectedKey,
          galaxyKey: g.galaxyKey, x: position.x, y: position.y, z: position.z,
          distanceFromCenter: distance,
        });
      }
      assignments.sort((a, b) => String(a.projectId).localeCompare(String(b.projectId)));

      const clusters = [...galaxies.values()].map((galaxy) => {
        const members = assignments.filter((item) => item.galaxyKey === galaxy.key);
        const actualColor = galaxy.outline.color.toHexString().toLowerCase();
        return {
          key: galaxy.key,
          label: galaxy.labelText,
          memberCount: members.length,
          x: galaxy.region.position.x,
          z: galaxy.region.position.z,
          radius: galaxy.region.scaling.x,
          maxMemberDistance: members.reduce(
            (value, item) => Math.max(value, item.distanceFromCenter), 0),
          color: actualColor,
          expectedColor: GALAXY.galaxyColor(galaxy.key).toLowerCase(),
          regionPickable: galaxy.region.isPickable,
          labelVisible: Boolean(galaxy.label.isVisible),
        };
      }).sort((a, b) => a.key.localeCompare(b.key));

      let minClusterGap = Infinity;
      for (let i = 0; i < clusters.length; i++) {
        for (let j = i + 1; j < clusters.length; j++) {
          const gap = Math.hypot(clusters[i].x - clusters[j].x, clusters[i].z - clusters[j].z) -
            clusters[i].radius - clusters[j].radius;
          minClusterGap = Math.min(minClusterGap, gap);
        }
      }
      if (!Number.isFinite(minClusterGap)) minClusterGap = 0;

      return {
        projectCount: glyphs.size,
        galaxyCount: galaxies.size,
        galaxyKeys: clusters.map((item) => item.key),
        graveyardProjectCount: assignments.filter((item) => item.galaxyKey === 'graveyard').length,
        pickableSunCount: scene.meshes.filter(
          (mesh) => mesh.isPickable && mesh.metadata && mesh.metadata.isSun
        ).length,
        projectLabelControlCount: gui.rootContainer.children.filter(
          (control) => String(control.name || '').startsWith('project-label:')
        ).length,
        regionMeshCount: regionMeshes.length,
        pickableRegionCount: regionMeshes.filter((mesh) => mesh.isPickable).length,
        galaxyLabelControlCount: gui.rootContainer.children.filter(
          (control) => String(control.name || '').startsWith('galaxy-label:')
        ).length,
        visibleGalaxyLabelCount: measured.measuredGalaxyLabelCount,
        combinedLabelOverlaps: measured.combinedMeasuredOverlaps,
        combinedChromeOcclusions: measured.combinedChromeOcclusions,
        assignmentMismatchCount,
        memberOutsideCount,
        minClusterGap,
        distinctColorCount: new Set(clusters.map((item) => item.color)).size,
        clusters,
        assignments,
      };
    }

    // ---- animation ----
    const tmp = new BABYLON.Vector3();
    scene.onBeforeRenderObservable.add(() => {
      const dt = engine.getDeltaTime() / 1000;
      const now = performance.now();
      const t = now / 1000;
      if (cameraLayoutChanged()) markLabelLayoutDirty();
      for (const g of glyphs.values()) {
        // appear-in
        if (g.appear < 1) { g.appear = Math.min(1, g.appear + dt * 2.2); g.root.scaling.setAll(g.appear); }
        // sun pulse
        let k = g.mul;
        k *= g.searchFactor;
        if (g.online) k *= 1 + 0.12 * Math.sin(t * 2 + g.phase);
        if (now < g.pulseUntil) {
          const f = (g.pulseUntil - now) / 500;
          k *= 1 + 0.6 * f;
        }
        g.sunMat.emissiveColor.copyFrom(g.baseEmissive).scaleInPlace(k);
        if (g.attention) {
          // One opacity cycle per second, phase-offset so multiple alerts do
          // not flash in lockstep. The mesh/material are reused every frame.
          const haloAlpha = 0.3 + 0.42 * (0.5 + 0.5 * Math.sin(t * Math.PI * 2 + g.phase));
          g.haloMat.alpha = haloAlpha * Math.min(1, g.searchFactor);
        }
        // dot orbit
        for (const d of g.dots) {
          d.a += d.speed * dt;
          d.mesh.position.set(Math.cos(d.a) * d.r, 0, Math.sin(d.a) * d.r);
        }
      }
      for (const r of ships.values()) {
        r.a += r.speed * dt;
        tmp.set(
          Math.cos(r.a) * r.r,
          Math.sin(r.bob + t * AUR.MOTION.universeShipBobRate) * AUR.MOTION.universeShipBobAmount,
          Math.sin(r.a) * r.r
        );
        r.mesh.position.copyFrom(tmp);
        r.mesh.rotation.y = -r.a + (r.speed < 0 ? Math.PI : 0);
        // warp-in grow
        const age = (now - r.born) / 900;
        if (age < 1) r.mesh.scaling.setAll(0.3 + 0.7 * age);
      }
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
            refreshProjectLabel(g, ev.project);
            applyGlyphState(g);
            recencyDirty = true;
          }
        } else if (ev.type === 'ship-spawned') {
          const g = glyphs.get(ev.ship.project);
          if (g && !ships.has(ev.ship.id)) buildShip(ev.ship);
          if (g) applyGlyphState(g);
        } else if (ev.type === 'ship-updated') {
          const g = glyphs.get(ev.ship.project);
          if (g) applyGlyphState(g);
        } else if (ev.type === 'ship-departed') {
          const r = ships.get(ev.shipId);
          const proj = r && r.mesh && r.mesh.parent ? r.mesh.parent.name.slice(2) : null;
          removeShip(ev.shipId);
          if (proj && glyphs.has(proj)) applyGlyphState(glyphs.get(proj));
        } else if (ev.type === 'build' || ev.type === 'activity') {
          const g = glyphs.get(ev.project);
          if (g) g.pulseUntil = performance.now() + 500;
        } else if (ev.type === 'project-vcs-status') {
          const g = glyphs.get(ev.projectId);
          const project = store.projects.get(ev.projectId);
          if (g && project) {
            refreshProjectLabel(g, project);
            applyGlyphSearchState(g);
            markLabelLayoutDirty();
          }
        }
      }
      if (recencyDirty) refreshRecencyRanks();
      if (structuralLayout) rebuildGalaxyLayout();
    }

    scene.metadata = {
      view: 'universe',
      galaxyStats,
      providerStats() {
        return AUR.sceneProviderStats(scene);
      },
      searchStats() {
        return {
          active: searchMatchIds !== null,
          matchIds: searchMatchIds === null ? [] : [...searchMatchIds],
          glyphs: [...glyphs.values()].map((g) => ({
            id: g.id, factor: g.searchFactor, labelFactor: g.searchLabelFactor,
          })),
        };
      },
      vcsStats() {
        const statuses = [...glyphs.values()].map((g) => ({
          id: g.id,
          ...VCS.normalize(store.projects.get(g.id)),
          markerVisible: g.markerHost ? !g.markerHost.classList.contains('hidden') : false,
        }));
        return {
          githubCount: statuses.filter((status) => status.hasGitHub).length,
          dirtyCount: statuses.filter((status) => status.dirty).length,
          visibleMarkerCount: statuses.filter((status) => status.markerVisible).length,
          statuses,
        };
      },
      polishStats() {
        if (labelLayoutDirty || !lastLabelMetrics) updateLabelLayout();
        const measured = measuredLabelStats();
        return {
          ...lastLabelMetrics,
          ...measured,
          galaxyMetrics: galaxyStats(measured),
        };
      },
    };

    scene.executeWhenReady(() => {});

    return {
      scene,
      update,
      setSearchMatches,
      dispose() {
        if (labelLayoutTimer != null) clearTimeout(labelLayoutTimer);
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

// Shared Babylon helpers on AUR: colors, skybox, starfield, orbit rings,
// ship and signal markers, provider stats, GUI labels. Loads right after util.js.
'use strict';

(function () {
  const AUR = window.AUR;

  // ---- Babylon color helpers ----
  AUR.color3 = (hex) => BABYLON.Color3.FromHexString(hex);
  AUR.color4 = (hex, a) => {
    const c = BABYLON.Color3.FromHexString(hex);
    return new BABYLON.Color4(c.r, c.g, c.b, a == null ? 1 : a);
  };

  // ---- shared 3D scene helpers ----

  // Equirectangular skybox via PhotoDome, dimmed to a subtle backdrop.
  AUR.addSkybox = function (scene, seed, size, level) {
    const dome = new BABYLON.PhotoDome(
      'sky_' + seed, AUR.skyboxPath(seed),
      { resolution: 32, size: size || 1400 }, scene
    );
    try { if (dome.texture) dome.texture.level = level == null ? 0.5 : level; } catch (e) { /* ignore */ }
    if (dome.mesh) { dome.mesh.isPickable = false; dome.mesh.infiniteDistance = true; }
    return dome;
  };

  // Volumetric starfield as a points cloud. Returns the PCS (mesh built async).
  AUR.addStarfield = function (scene, count, spread) {
    const pcs = new BABYLON.PointsCloudSystem('stars', 2, scene);
    const rand = AUR.mulberry32(0x51ed5eed);
    const rad = spread || 700;
    pcs.addPoints(count || 2500, (p) => {
      const r = rad * (0.35 + 0.65 * rand());
      const theta = rand() * Math.PI * 2;
      const phi = Math.acos(2 * rand() - 1);
      p.position = new BABYLON.Vector3(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.cos(phi) * 0.6,
        r * Math.sin(phi) * Math.sin(theta)
      );
      const b = 0.45 + 0.55 * rand();
      const warm = rand() > 0.88;
      p.color = new BABYLON.Color4(b, warm ? b * 0.85 : b, warm ? b * 0.7 : b, 1);
    });
    pcs.buildMeshAsync().then((mesh) => {
      mesh.isPickable = false;
      mesh.alwaysSelectAsActiveMesh = true;
      if (mesh.material) {
        mesh.material.pointSize = 1.35;
        mesh.material.disableLighting = true;
      }
    });
    return pcs;
  };

  // Flat circular orbit ring (LinesMesh) in the x-z plane at height y.
  AUR.orbitRing = function (scene, radius, color, alpha, y) {
    const pts = [];
    const seg = 108;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      pts.push(new BABYLON.Vector3(Math.cos(a) * radius, y || 0, Math.sin(a) * radius));
    }
    const line = BABYLON.MeshBuilder.CreateLines('ring', { points: pts }, scene);
    line.color = BABYLON.Color3.FromHexString(color || '#8ea2d8');
    line.alpha = alpha == null ? 0.25 : alpha;
    line.isPickable = false;
    return line;
  };

  // Small emissive dart mesh for ships (an octahedron; the view scales it like any hull root).
  AUR.dartMesh = function (scene, name, hex) {
    const m = BABYLON.MeshBuilder.CreatePolyhedron(name, { type: 1, size: 0.5 }, scene);
    m.layerMask |= AUR.SHIP_LAYER;
    const mat = new BABYLON.StandardMaterial(name + '_m', scene);
    const c = BABYLON.Color3.FromHexString(hex);
    mat.emissiveColor = c;
    mat.diffuseColor = c.scale(0.25);
    mat.specularColor = new BABYLON.Color3(0.2, 0.2, 0.25);
    m.material = mat;
    return m;
  };

  // A point on an orbit in the XZ plane at `angle`, written into `out`.
  AUR.orbitPoint = function (angle, radius, y, out) {
    return out.set(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
  };

  // A metadata-only Signal agent is an information source, not a spacecraft: a billboarded
  // transmission glyph keeps it visible without a hull.
  AUR.signalMarker = function signalMarker(scene, name, hex) {
    const texture = new BABYLON.DynamicTexture(name + '_signal_texture', {
      width: 128, height: 128,
    }, scene, false);
    const context = texture.getContext();
    context.clearRect(0, 0, 128, 128);
    context.strokeStyle = '#ffffff';
    context.fillStyle = '#ffffff';
    context.lineCap = 'round';
    context.lineWidth = 7;
    context.beginPath();
    context.arc(64, 64, 35, -0.78, 0.78);
    context.stroke();
    context.beginPath();
    context.arc(64, 64, 35, Math.PI - 0.78, Math.PI + 0.78);
    context.stroke();
    context.lineWidth = 5;
    context.beginPath();
    context.arc(64, 64, 19, 0, Math.PI * 2);
    context.stroke();
    context.beginPath();
    context.arc(64, 64, 5, 0, Math.PI * 2);
    context.fill();
    texture.hasAlpha = true;
    texture.update();

    const marker = BABYLON.MeshBuilder.CreatePlane(name, { size: 1.15 }, scene);
    marker.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
    const material = AUR.unlitMaterial(scene, name + '_material', BABYLON.Color3.FromHexString(hex));
    material.emissiveTexture = texture;
    material.opacityTexture = texture;
    material.disableLighting = true;
    material.backFaceCulling = false;
    marker.material = material;
    marker.metadata = { visualKind: 'signal-marker', providerTint: hex };
    return marker;
  };

  // A soft radial disc, white at the centre and clear at the rim: the opacity of every glow.
  AUR.softDiscTexture = function (scene) {
    const size = 128;
    const texture = new BABYLON.DynamicTexture('soft-disc', size, scene, false);
    const context = texture.getContext();
    const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.45, 'rgba(255,255,255,0.45)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
    texture.hasAlpha = true;
    texture.update();
    return texture;
  };

  // Emissive colour only: no diffuse or specular response to the scene's lights.
  AUR.unlitMaterial = function (scene, name, emissive, alpha) {
    const material = new BABYLON.StandardMaterial(name, scene);
    material.emissiveColor = emissive;
    material.diffuseColor = new BABYLON.Color3(0, 0, 0);
    material.specularColor = new BABYLON.Color3(0, 0, 0);
    if (alpha != null) material.alpha = alpha;
    return material;
  };

  // Unlit colour through an opacity texture, drawn without writing depth: discs and coronas.
  AUR.softMaterial = function (scene, name, color, alpha, opacityTexture) {
    const material = new BABYLON.StandardMaterial(name, scene);
    material.emissiveColor = color;
    material.opacityTexture = opacityTexture;
    material.disableLighting = true;
    material.disableDepthWrite = true;
    material.alpha = alpha;
    return material;
  };

  // A node and every mesh under it (a mesh root included), in one list.
  AUR.nodeFamily = function (node) {
    if (!node) return [];
    return typeof node.getChildMeshes === 'function' ? [node, ...node.getChildMeshes(false)] : [node];
  };

  // The hull a ship mesh flies: the asset swapped in under a dart, or the asset root itself.
  AUR.shipHullId = function (mesh) {
    const metadata = mesh && mesh.metadata;
    return (metadata && (metadata.upgradedHullId || metadata.assetHullId)) || null;
  };

  // The connected pieces of a mesh (triangles sharing a vertex position), each as its centre and
  // the radius of its vertices about it: a hull's glow discs, joined into one mesh but never welded.
  AUR.meshIslands = function (positions, indices) {
    const count = positions.length / 3;
    const parent = new Int32Array(count);
    // A flat-shaded export gives every face its own vertices: weld them by position first.
    const firstAt = new Map();
    for (let i = 0; i < count; i++) {
      const key = positions[i * 3] + ',' + positions[i * 3 + 1] + ',' + positions[i * 3 + 2];
      const first = firstAt.get(key);
      if (first === undefined) firstAt.set(key, i);
      parent[i] = first === undefined ? i : first;
    }
    const find = (i) => {
      while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
      return i;
    };
    for (let i = 0; i + 2 < indices.length; i += 3) {
      const root = find(indices[i]);
      parent[find(indices[i + 1])] = root;
      parent[find(indices[i + 2])] = root;
    }
    const members = new Map();
    for (let i = 0; i < count; i++) {
      const root = find(i);
      if (!members.has(root)) members.set(root, []);
      members.get(root).push(i);
    }
    const islands = [];
    for (const vertices of members.values()) {
      if (vertices.length < 3) continue;
      const center = [0, 0, 0];
      for (const v of vertices) for (let k = 0; k < 3; k++) center[k] += positions[v * 3 + k];
      for (let k = 0; k < 3; k++) center[k] /= vertices.length;
      let radius = 0;
      for (const v of vertices) {
        radius = Math.max(radius, Math.hypot(positions[v * 3] - center[0], positions[v * 3 + 1] - center[1], positions[v * 3 + 2] - center[2]));
      }
      islands.push({ center, radius });
    }
    return islands;
  };

  // The stern nozzles among a hull's glow islands ({ position: { z } }, +Z the nose): those within
  // `share` of the hull's length of the aft-most one. Lit intakes forward of it are no exhaust.
  AUR.sternIslands = function (islands, length, share) {
    const stern = Math.min(...islands.map((island) => island.position.z));
    return islands.filter((island) => island.position.z - stern <= length * share);
  };

  // A missing node counts as disposed.
  AUR.isNodeDisposed = function (node) {
    if (!node) return true;
    return typeof node.isDisposed === 'function' ? node.isDisposed() : node.isDisposed === true;
  };

  // Attach normalized, renderer-owned identity to the actual hull mesh. This
  // keeps provider evidence observable without exposing raw log-source text.
  AUR.markShipMesh = function markShipMesh(mesh, ship) {
    const provider = AUR.providerMeta(ship && ship.provider);
    const existing = mesh.metadata && typeof mesh.metadata === 'object' ? mesh.metadata : {};
    mesh.metadata = {
      ...existing,
      isShip: true,
      shipId: ship && ship.id != null ? String(ship.id) : '',
      projectId: ship && ship.project != null ? String(ship.project) : null,
      providerKey: provider.key,
      providerLabel: provider.label,
      kind: ship && ship.kind ? ship.kind : 'ship',
    };
    return provider;
  };

  // Mechanical proof derived from live Babylon meshes and materials. Each
  // scene exposes this through scene.metadata.providerStats().
  AUR.sceneProviderStats = function sceneProviderStats(scene) {
    const counts = { claude: 0, codex: 0, generic: 0 };
    const ships = [];
    const meshes = scene && Array.isArray(scene.meshes) ? scene.meshes : [];
    for (const mesh of meshes) {
      const metadata = mesh.metadata;
      if (!metadata || metadata.isShip !== true) continue;
      const provider = AUR.providerMeta(metadata.providerKey);
      const emissive = mesh.material && mesh.material.emissiveColor;
      const actualColor = emissive && typeof emissive.toHexString === 'function'
        ? emissive.toHexString().toLowerCase() : null;
      const expectedColor = typeof metadata.providerTint === 'string'
        ? metadata.providerTint.toLowerCase()
        : AUR.shipTint(metadata.shipId, provider.key).toLowerCase();
      counts[provider.key]++;
      ships.push({
        shipId: metadata.shipId,
        projectId: metadata.projectId,
        kind: metadata.kind,
        providerKey: provider.key,
        providerLabel: provider.label,
        actualColor,
        expectedColor,
        colorMatches: actualColor === expectedColor,
      });
    }
    ships.sort((a, b) => String(a.shipId).localeCompare(String(b.shipId)));
    const representedProviders = Object.keys(counts).filter((key) => counts[key] > 0);
    const colorMismatchCount = ships.filter((ship) => !ship.colorMatches).length;
    return {
      shipMeshCount: ships.length,
      providerCounts: counts,
      representedProviders,
      distinctProviderCount: representedProviders.length,
      distinctColorCount: new Set(ships.map((ship) => ship.actualColor).filter(Boolean)).size,
      colorMismatchCount,
      ships,
    };
  };

  // Fullscreen GUI layer for a scene (exactly one per scene). Its labels keep their size and
  // layout when the graphics setting renders the scene with fewer pixels; they share the scene's
  // buffer, so they soften with it.
  AUR.guiLayer = function (scene) {
    const gui = BABYLON.GUI.AdvancedDynamicTexture.CreateFullscreenUI('ui', true, scene);
    const engine = scene.getEngine();
    const matchDisplay = () => {
      gui.renderScale = Math.round(1000 * engine.getHardwareScalingLevel() * window.devicePixelRatio) / 1000;
    };
    matchDisplay();
    // Ahead of the GUI's own resize handler, so the texture is sized once.
    const resized = engine.onResizeObservable.add(matchDisplay, undefined, true);
    gui.onDisposeObservable.addOnce(() => engine.onResizeObservable.remove(resized));
    return gui;
  };

  // Map labels use the chrome's faces (shipped under fonts/, declared in styles/tokens.css); the GUI
  // measures text on a canvas, so app/boot.js awaits loadLabelFonts() before the first scene draws.
  AUR.LABEL_FONTS = {
    sans: '"Archivo", system-ui, "Segoe UI", sans-serif',
    mono: '"IBM Plex Mono", Consolas, monospace',
  };
  AUR.loadLabelFonts = function () {
    if (!document.fonts || typeof document.fonts.load !== 'function') return Promise.resolve();
    const wanted = ['600 13px "Archivo"', '700 12px "Archivo"', '400 12px "IBM Plex Mono"'];
    const timeout = new Promise((resolve) => setTimeout(resolve, 1500));
    return Promise.race([Promise.all(wanted.map((f) => document.fonts.load(f))).catch(() => null), timeout]);
  };

  // A text label added to a GUI layer, following opts.mesh (offset opts.offsetY pixels) when given.
  AUR.label = function (gui, text, opts) {
    opts = opts || {};
    const tb = new BABYLON.GUI.TextBlock();
    tb.text = text;
    tb.color = opts.color || '#eeece6';
    tb.fontSize = opts.fontSize || 13;
    tb.fontFamily = opts.mono ? AUR.LABEL_FONTS.mono : AUR.LABEL_FONTS.sans;
    tb.fontStyle = opts.weight || '';
    tb.outlineWidth = opts.outline == null ? 3 : opts.outline;
    tb.outlineColor = 'rgba(4,6,11,0.8)';
    tb.resizeToFit = true;
    gui.addControl(tb);
    if (opts.mesh) tb.linkWithMesh(opts.mesh);
    if (opts.offsetY != null) tb.linkOffsetY = opts.offsetY;
    return tb;
  };
})();

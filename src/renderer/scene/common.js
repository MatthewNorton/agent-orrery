// Helpers shared by the views, and the AUR.sceneParts
// registry the split-off scene/<view>/*.js parts add their builders to.
'use strict';

(function () {
  const AUR = window.AUR;

  AUR.sceneParts = { universe: {}, system: {} };

  // The part of the canvas not covered by the fixed chrome: below the top bar, between the rails,
  // above the timeline. Labels and the chrome-occlusion stats both lay out inside it.
  AUR.chromeBounds = function (canvas) {
    const edge = (id, side, fallback) => {
      const el = document.getElementById(id);
      if (!el || el.classList.contains('hidden') || getComputedStyle(el).display === 'none') return fallback;
      return el.getBoundingClientRect()[side];
    };
    const width = canvas.clientWidth, height = canvas.clientHeight;
    const top = edge('topbar', 'bottom', 0) + 8;
    const left = edge('rail-left', 'right', 0) + 8;
    const right = edge('sidebar', 'left', width) - 8;
    const bottom = edge('history-bar', 'top', height) - 8;
    return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
  };

  // Every view's orbit camera; settings are properties set on it, such as its radius and beta limits.
  AUR.viewCamera = function (scene, name, beta, radius, settings) {
    const camera = new BABYLON.ArcRotateCamera(name, -Math.PI / 2, beta, radius, BABYLON.Vector3.Zero(), scene);
    camera.attachControl(scene.getEngine().getRenderingCanvas(), true);
    Object.assign(camera, { minZ: 0.1, maxZ: 6000, ...settings });
    return AUR.configureComfortCamera(camera);
  };

  // A ship's mesh: a transmission glyph for signals and drones, else its hull, or a dart until
  // the hull loads (upgrade is that load's promise, null otherwise). Names start with prefix.
  AUR.shipMesh = function (scene, ship, prefix, signalScale, hullScale) {
    const tint = AUR.shipTint(ship.id, ship.provider);
    const signal = AUR.isSignalEntity(ship);
    const scale = signal ? signalScale : hullScale;
    let mesh = signal
      ? AUR.signalMarker(scene, prefix + 'sig_' + ship.id, tint)
      : AUR.ships.instantiate(scene, ship);
    const usedFallback = !signal && !mesh;
    if (usedFallback) mesh = AUR.dartMesh(scene, prefix + 'shp_' + ship.id, tint, scale);
    else mesh.scaling.setAll(scale);
    const provider = AUR.markShipMesh(mesh, ship);
    const upgrade = usedFallback ? AUR.ships.upgrade(scene, ship, mesh, scale) : null;
    return { mesh, tint, providerKey: provider.key, upgrade };
  };

  // The teardown every view ends with, after its own.
  AUR.disposeView = function (scene, gui) {
    scene.onBeforeRenderObservable.clear();
    scene.onPointerObservable.clear();
    scene.getEngine().getRenderingCanvas().style.cursor = 'default';
    gui.dispose();
    AUR.ships.dispose(scene);
    scene.dispose();
  };

  // Hull materials are shared per scene and released by AUR.ships.dispose. Any other material is
  // the mesh's own, textures included (a signal marker draws its glyph into one).
  AUR.disposeMeshAndMaterial = function (mesh) {
    if (!mesh) return;
    const material = mesh.material;
    const sharedAssetMaterial = Boolean(mesh.metadata && mesh.metadata.assetHullId);
    mesh.dispose();
    if (material && !sharedAssetMaterial) material.dispose(false, true);
  };
})();

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

  // Scene units per screen pixel at unit distance from the view's camera: the per-frame constant
  // of the ship size floor, computed once per animate loop.
  AUR.unitsPerPixel = function (scene) {
    const camera = scene.activeCamera;
    if (!camera) return 0;
    return 2 * Math.tan((camera.fov || 0.8) / 2) / Math.max(1, scene.getEngine().getRenderHeight());
  };

  // What one animate loop needs to size its ships: the camera and the floor per unit of distance.
  AUR.shipFit = function (scene, minPx) {
    return { camera: scene.activeCamera, floorPerUnit: minPx * AUR.unitsPerPixel(scene) };
  };

  // A ship's display scale this frame: its view scale, the warp-in growth since `rec.born` (none
  // without one), and a floor keeping the view's pixel minimum of hull on screen (1 up close).
  AUR.fitShip = function (fit, rec, position, now) {
    const floor = fit.camera
      ? Math.max(1, fit.floorPerUnit * BABYLON.Vector3.Distance(fit.camera.globalPosition, position) / rec.scale)
      : 1;
    const grow = rec.born == null ? 1 : Math.min(1, 0.3 + 0.7 * (now - rec.born) / 900);
    rec.mesh.scaling.setAll(rec.scale * grow * floor);
  };

  // Ship-only key and rim: hull maps need a viewer-relative key while the planets keep their sun
  // (the studio environment is the fill). The lights follow the active camera each frame and
  // affect only meshes carrying AUR.SHIP_LAYER, which every dart and hull mesh gets at birth.
  function shipLight(light, intensity, diffuse) {
    light.intensity = intensity;
    light.diffuse = diffuse;
    light.specular = diffuse.clone();
    light.includeOnlyWithLayerMask = AUR.SHIP_LAYER;
    return light;
  }
  AUR.shipLights = function (scene) {
    const keyDir = new BABYLON.Vector3(0.45, -0.55, 1); // camera-relative: over the right shoulder
    const rimDir = new BABYLON.Vector3(-0.5, -0.3, -1); // and from behind the ship, cool
    const key = shipLight(new BABYLON.DirectionalLight('ship-key', keyDir.clone(), scene), 2.6, new BABYLON.Color3(1, 0.96, 0.9));
    const rim = shipLight(new BABYLON.DirectionalLight('ship-rim', rimDir.clone(), scene), 1.3, new BABYLON.Color3(0.7, 0.82, 1));
    scene.onBeforeRenderObservable.add(() => {
      const camera = scene.activeCamera;
      if (!camera) return;
      camera.getDirectionToRef(keyDir, key.direction);
      camera.getDirectionToRef(rimDir, rim.direction);
    });
  };

  // Every view's orbit camera; settings are properties set on it, such as its radius and beta limits.
  AUR.viewCamera = function (scene, name, beta, radius, settings) {
    const camera = new BABYLON.ArcRotateCamera(name, -Math.PI / 2, beta, radius, BABYLON.Vector3.Zero(), scene);
    camera.attachControl(scene.getEngine().getRenderingCanvas(), true);
    Object.assign(camera, { minZ: 0.1, maxZ: 6000, ...settings });
    return AUR.configureComfortCamera(camera);
  };

  // A ship's mesh: a transmission glyph for signals, else its hull, or a dart until the hull loads
  // under it. Names start with prefix; `size` is the view's AUR.SHIP_SIZE entry, and the root
  // carries the resulting scale (the views animate it).
  AUR.shipMesh = function (scene, ship, prefix, size) {
    const tint = AUR.shipTint(ship.id, ship.provider);
    const signal = AUR.isSignalEntity(ship);
    const scale = signal ? size.signal : size.hull * (ship.kind === 'drone' ? AUR.DRONE_SCALE : 1);
    let mesh = signal
      ? AUR.signalMarker(scene, prefix + 'sig_' + ship.id, tint)
      : AUR.ships.instantiate(scene, ship);
    const usedFallback = !signal && !mesh;
    if (usedFallback) mesh = AUR.dartMesh(scene, prefix + 'shp_' + ship.id, tint);
    mesh.scaling.setAll(scale);
    const provider = AUR.markShipMesh(mesh, ship);
    if (usedFallback) AUR.ships.upgrade(scene, ship, mesh);
    return { mesh, tint, providerKey: provider.key, scale };
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

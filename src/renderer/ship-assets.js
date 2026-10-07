// @ts-check
// ship-assets.js — manifest-backed original hull loading with procedural fallback.
'use strict';

(function () {
  const AUR = window.AUR;
  const MANIFEST_PATH = '../../assets/ships/manifest.json';
  const HULL_ROOT = '../../assets/ships/';
  const sceneStates = new WeakMap();
  const logged = new Set();

  function logOnce(key, message) {
    if (logged.has(key)) return;
    logged.add(key);
    AUR.log(message);
  }

  function loadWithFetch() {
    if (typeof fetch !== 'function') return Promise.reject(new Error('fetch unavailable'));
    return fetch(MANIFEST_PATH, { cache: 'no-store' }).then((response) => {
      if (!response.ok && response.status !== 0) throw new Error('manifest status ' + response.status);
      return response.json();
    });
  }

  function loadWithXhr() {
    return new Promise((resolve, reject) => {
      if (typeof XMLHttpRequest !== 'function') {
        reject(new Error('XHR unavailable'));
        return;
      }
      const request = new XMLHttpRequest();
      request.open('GET', MANIFEST_PATH, true);
      request.onload = () => {
        if (request.status !== 0 && (request.status < 200 || request.status >= 300)) {
          reject(new Error('manifest status ' + request.status));
          return;
        }
        try { resolve(JSON.parse(request.responseText)); } catch (error) { reject(error); }
      };
      request.onerror = () => reject(new Error('manifest request unavailable'));
      request.send();
    });
  }

  function validateManifest(value) {
    if (!value || value.schemaVersion !== 1 || !value.providerFamilies || !Array.isArray(value.hulls)) {
      throw new Error('manifest schema unsupported');
    }
    return value;
  }

  let manifestValue = null;
  let manifestSettled = false;
  const manifestPromise = loadWithFetch()
    .catch(() => loadWithXhr())
    .then(validateManifest)
    .catch(() => {
      logOnce('manifest', 'Ship assets unavailable; using procedural hulls.');
      return null;
    })
    .then((manifest) => {
      manifestValue = manifest;
      manifestSettled = true;
      return manifest;
    });

  function isSceneDisposed(scene, state) {
    if (!scene || !state || state.disposed) return true;
    if (typeof scene.isDisposed === 'function') return scene.isDisposed();
    return scene.isDisposed === true;
  }

  function stateFor(scene) {
    let state = sceneStates.get(scene);
    if (!state) {
      state = { containers: new Map(), materials: new Map(), triangles: 0, disposed: false };
      sceneStates.set(scene, state);
    }
    return state;
  }

  function selectHull(manifest, ship) {
    if (!manifest) return null;
    const shipId = String(ship && ship.id != null ? ship.id : '');
    const hash = AUR.fnv1a(shipId);
    const providerKey = AUR.providerKey(ship && ship.provider);
    if (ship && (ship.kind === 'drone' || providerKey === 'generic')) return null;
    const family = manifest.providerFamilies[providerKey];
    if (!family) return null;
    const role = ['main-s', 'main-m', 'main-l'][hash % 3];
    const exact = manifest.hulls.filter((hull) => hull.family === family && hull.role === role);
    if (exact.length) return exact[hash % exact.length];
    const familyHulls = manifest.hulls.filter((hull) => hull.family === family && hull.role !== 'drone');
    return familyHulls.length ? familyHulls[hash % familyHulls.length] : null;
  }

  function ensureContainer(scene, state, hull) {
    let record = state.containers.get(hull.id);
    if (!record) {
      record = { container: null, promise: null, triangles: 0 };
      state.containers.set(hull.id, record);
    }
    if (record.container) return Promise.resolve(record.container);
    if (record.promise) return record.promise;
    record.promise = BABYLON.SceneLoader.LoadAssetContainerAsync(HULL_ROOT, hull.file, scene)
      .then((container) => {
        if (isSceneDisposed(scene, state)) {
          container.dispose();
          return null;
        }
        record.container = container;
        record.triangles = container.meshes.reduce((total, mesh) => {
          const indices = typeof mesh.getTotalIndices === 'function' ? mesh.getTotalIndices() : 0;
          return total + Math.floor(indices / 3);
        }, 0);
        return container;
      })
      .catch(() => {
        logOnce('hull:' + hull.id, 'Hull ' + hull.id + ' unavailable; using procedural hulls.');
        return null;
      });
    return record.promise;
  }

  function childMeshes(entries) {
    const meshes = [];
    const seen = new Set();
    for (const root of entries.rootNodes) {
      const candidates = [];
      if (root && root.material) candidates.push(root);
      if (root && typeof root.getChildMeshes === 'function') candidates.push(...root.getChildMeshes(false));
      for (const mesh of candidates) {
        if (!mesh || seen.has(mesh) || !mesh.material) continue;
        seen.add(mesh);
        meshes.push(mesh);
      }
    }
    return meshes;
  }

  function paletteTone(color, strength, lift) {
    return new BABYLON.Color3(
      Math.min(1, lift + color.r * strength),
      Math.min(1, lift + color.g * strength),
      Math.min(1, lift + color.b * strength)
    );
  }

  function fleetMaterial(scene, state, hull, ship, baseMaterial) {
    const provider = AUR.providerMeta(ship && ship.provider);
    const sourceName = String(baseMaterial && baseMaterial.name || 'material');
    const key = hull.id + ':' + provider.key + ':' + sourceName;
    let material = state.materials.get(key);
    if (material) return material;
    material = baseMaterial && typeof baseMaterial.clone === 'function'
      ? baseMaterial.clone('ship_fleet_' + hull.id + '_' + provider.key + '_' + sourceName)
      : new BABYLON.StandardMaterial('ship_fleet_' + hull.id + '_' + provider.key + '_' + sourceName, scene);
    const tint = AUR.color3(provider.color);
    const name = sourceName.toLowerCase();
    let surface = paletteTone(tint, 0.38, 0.09);
    let emissive = new BABYLON.Color3(0, 0, 0);

    if (/armor_secondary|hull_textured/.test(name)) surface = paletteTone(tint, 0.58, 0.10);
    if (/structure|ivory/.test(name)) surface = paletteTone(tint, 0.25, 0.42);
    if (/mechanical|gunmetal/.test(name)) surface = paletteTone(tint, 0.06, 0.045);
    if (/canopy|glass/.test(name)) {
      surface = paletteTone(tint, 0.16, 0.015);
      emissive = tint.scale(0.07);
    }
    if (/accent|energy|engine|glow|metalred|orange/.test(name)) {
      surface = paletteTone(tint, 0.76, 0.10);
      emissive = tint.clone();
    }

    if (material.albedoColor) material.albedoColor = surface;
    if (material.diffuseColor) material.diffuseColor = surface;
    material.emissiveColor = emissive;
    if (typeof material.metallic === 'number' && /accent|energy|engine|glow/.test(name)) material.metallic = 0.42;
    if (typeof material.roughness === 'number' && /accent|energy|engine|glow/.test(name)) material.roughness = 0.22;
    state.materials.set(key, material);
    return material;
  }

  function instantiateReady(scene, state, hull, ship) {
    const record = state.containers.get(hull.id);
    if (!record || !record.container || isSceneDisposed(scene, state)) return null;
    if (state.triangles + record.triangles >= 100000) {
      logOnce('budget:' + scene.uid, 'Ship hull triangle budget reached; using procedural hulls.');
      return null;
    }
    let entries;
    try {
      entries = record.container.instantiateModelsToScene(
        (sourceName) => 'ship_' + String(ship.id) + '_' + sourceName,
        false,
        { doNotInstantiate: true }
      );
    } catch (error) {
      logOnce('instance:' + hull.id, 'Hull ' + hull.id + ' could not be instantiated; using procedural hulls.');
      return null;
    }

    const root = new BABYLON.Mesh('ship_asset_' + ship.id, scene);
    const correction = new BABYLON.TransformNode('ship_correction_' + ship.id, scene);
    const pivot = new BABYLON.TransformNode('ship_pivot_' + ship.id, scene);
    correction.parent = root;
    pivot.parent = correction;
    const data = hull.correction || {};
    correction.rotation.y = Number(data.rotateY) || 0;
    correction.scaling.setAll(Number(data.scale) || 1);
    const offset = Array.isArray(data.offset) ? data.offset : [0, 0, 0];
    pivot.position.set(Number(offset[0]) || 0, Number(offset[1]) || 0, Number(offset[2]) || 0);
    for (const node of entries.rootNodes) node.parent = pivot;

    const meshes = childMeshes(entries);
    let evidenceMaterial = null;
    for (const mesh of meshes) {
      mesh.isPickable = false;
      const sourceName = String(mesh.material && mesh.material.name || '');
      mesh.material = fleetMaterial(scene, state, hull, ship, mesh.material);
      if (!evidenceMaterial || /accent|energy|engine|glow/i.test(sourceName)) evidenceMaterial = mesh.material;
      mesh.metadata = {
        ...(mesh.metadata || {}),
        providerPalette: true,
        providerKey: AUR.providerKey(ship && ship.provider),
        assetHullId: hull.id,
      };
    }
    root.material = evidenceMaterial || fleetMaterial(scene, state, hull, ship, null);
    root.metadata = {
      assetHullId: hull.id,
      assetFamily: hull.family,
      assetRole: hull.role,
      providerTint: AUR.shipTint(ship && ship.id, ship && ship.provider),
    };
    root.isPickable = false;
    state.triangles += record.triangles;
    root.onDisposeObservable.addOnce(() => {
      state.triangles = Math.max(0, state.triangles - record.triangles);
    });
    return root;
  }

  function instantiate(scene, ship) {
    const state = stateFor(scene);
    if (!manifestSettled || !manifestValue || isSceneDisposed(scene, state)) return null;
    const hull = selectHull(manifestValue, ship);
    if (!hull) return null;
    const record = state.containers.get(hull.id);
    if (!record || !record.container) {
      ensureContainer(scene, state, hull);
      return null;
    }
    return instantiateReady(scene, state, hull, ship);
  }

  function upgrade(scene, ship, fallback, displayScale) {
    const state = stateFor(scene);
    return manifestPromise.then((manifest) => {
      if (!manifest || isSceneDisposed(scene, state)) return null;
      const hull = selectHull(manifest, ship);
      if (!hull) return null;
      return ensureContainer(scene, state, hull).then((container) => {
        const fallbackDisposed = !fallback ||
          (typeof fallback.isDisposed === 'function' && fallback.isDisposed());
        if (!container || fallbackDisposed || isSceneDisposed(scene, state)) return null;
        const assetRoot = instantiateReady(scene, state, hull, ship);
        if (!assetRoot) return null;
        assetRoot.parent = fallback;
        assetRoot.position.setAll(0);
        assetRoot.scaling.setAll(Number(displayScale) || 1);
        fallback.scaling.setAll(1);
        fallback.isPickable = false;
        if (fallback.material) fallback.material.alpha = 0;
        AUR.markShipMesh(assetRoot, ship);
        fallback.metadata = {
          ...(fallback.metadata || {}),
          isShip: false,
          upgradedHullId: hull.id,
        };
        return assetRoot;
      });
    }).catch(() => null);
  }

  function dispose(scene) {
    const state = sceneStates.get(scene);
    if (!state) return;
    state.disposed = true;
    for (const record of state.containers.values()) {
      if (record.container) record.container.dispose();
    }
    for (const material of state.materials.values()) material.dispose();
    state.containers.clear();
    state.materials.clear();
    sceneStates.delete(scene);
  }

  AUR.ships = { instantiate, upgrade, dispose };
})();

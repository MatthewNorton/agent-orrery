// @ts-check
// ship-assets.js — manifest-backed original hull loading with procedural fallback.
'use strict';

/**
 * @import { Ship } from '../types/contract'
 * @typedef {{ rotateY?: number, scale?: number, offset?: number[] }} HullCorrection
 * @typedef {{ id: string, file: string, lods?: { far?: string }, family: string, role: string,
 *   minBuilds?: number, correction?: HullCorrection }} HullEntry
 * @typedef {{ schemaVersion: number, providerFamilies: Record<string, string>,
 *   hulls: HullEntry[] }} ShipManifest
 * @typedef {{ container: BABYLON.AssetContainer | null, promise: Promise<HullRecord | null> | null,
 *   triangles: number }} HullRecord
 * @typedef {{ file: string, lod: 'far' | 'near' | null }} HullFile
 * @typedef {HullFile & { record: HullRecord }} HullAsset
 * @typedef {{ root: BABYLON.Mesh, correction: BABYLON.TransformNode, hull: HullEntry,
 *   triangles: number, wanted: string, fallback: BABYLON.AbstractMesh | null }} ShipEntry
 * @typedef {{ containers: Map<string, HullRecord>, materials: Map<string, any>,
 *   templates: Map<string, BABYLON.TransformNode[]>, ships: Map<string, ShipEntry>,
 *   triangles: number, disposed: boolean }} SceneState
 */

(function () {
  const AUR = window.AUR;
  const MANIFEST_PATH = '../../assets/ships/manifest.json';
  const HULL_ROOT = '../../assets/ships/';
  const TRIANGLE_BUDGET = 100000;
  // The universe map has no lights, so far hulls carry a faint tint of their
  // own; without it they read as black cut-outs behind their accent lights.
  const FAR_SELF_LIGHT = 0.1;
  /** @type {WeakMap<object, SceneState>} */
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

  /** @type {ShipManifest | null} */
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

  function isNodeDisposed(node) {
    if (!node) return true;
    return typeof node.isDisposed === 'function' ? node.isDisposed() : node.isDisposed === true;
  }

  /** @returns {SceneState} */
  function stateFor(scene) {
    let state = sceneStates.get(scene);
    if (!state) {
      state = {
        containers: new Map(), materials: new Map(), templates: new Map(), ships: new Map(),
        triangles: 0, disposed: false,
      };
      sceneStates.set(scene, state);
    }
    return state;
  }

  // ---------- hull choice ----------

  /**
   * Far hulls for the universe map, near hulls for the system and planet views.
   * Null until the scene declares its view: the universe builds its first ships
   * before it sets scene.metadata.
   * @returns {'far' | 'near' | null}
   */
  function viewLod(scene) {
    const view = scene && scene.metadata ? scene.metadata.view : null;
    if (view === 'universe') return 'far';
    if (view === 'system' || view === 'planet') return 'near';
    return null;
  }

  /** @param {ShipManifest} manifest @param {string} family */
  function rankLadder(manifest, family) {
    return manifest.hulls
      .filter((hull) => hull.family === family && Number.isFinite(hull.minBuilds))
      .sort((a, b) => a.minBuilds - b.minBuilds);
  }

  /** The highest rank whose promotion threshold the ship's build count has reached. */
  function rankedHull(ladder, builds) {
    let chosen = ladder[0];
    for (const hull of ladder) if (builds >= hull.minBuilds) chosen = hull;
    return chosen;
  }

  // Families without a rank ladder keep the original stable hash pick.
  function hashedHull(manifest, family, ship) {
    const hash = AUR.fnv1a(String(ship && ship.id != null ? ship.id : ''));
    const role = ['main-s', 'main-m', 'main-l'][hash % 3];
    const exact = manifest.hulls.filter((hull) => hull.family === family && hull.role === role);
    if (exact.length) return exact[hash % exact.length];
    const familyHulls = manifest.hulls.filter((hull) => hull.family === family && hull.role !== 'drone');
    return familyHulls.length ? familyHulls[hash % familyHulls.length] : null;
  }

  /** @param {ShipManifest | null} manifest @param {Ship} ship @returns {HullEntry | null} */
  function selectHull(manifest, ship) {
    if (!manifest) return null;
    const providerKey = AUR.providerKey(ship && ship.provider);
    if (ship && (ship.kind === 'drone' || providerKey === 'generic')) return null;
    const family = manifest.providerFamilies[providerKey];
    if (!family) return null;
    const ladder = rankLadder(manifest, family);
    if (ladder.length) return rankedHull(ladder, Number(ship && ship.builds) || 0);
    return hashedHull(manifest, family, ship);
  }

  /**
   * Files to try in order: a near view steps down to the far file when the
   * triangle budget is short. Hulls without LODs have one file for every view.
   * @param {HullEntry} hull @param {'far' | 'near'} lod @returns {HullFile[]}
   */
  function hullFiles(hull, lod) {
    const far = hull.lods && hull.lods.far;
    if (!far) return [{ file: hull.file, lod: null }];
    const farFile = { file: far, lod: /** @type {'far'} */ ('far') };
    return lod === 'near' ? [{ file: hull.file, lod: 'near' }, farFile] : [farFile];
  }

  // ---------- loading ----------

  /** @returns {Promise<HullRecord | null>} */
  function ensureContainer(scene, state, file) {
    let record = state.containers.get(file);
    if (!record) {
      record = { container: null, promise: null, triangles: 0 };
      state.containers.set(file, record);
    }
    if (record.container) return Promise.resolve(record);
    if (record.promise) return record.promise;
    const loading = record;
    record.promise = BABYLON.SceneLoader.LoadAssetContainerAsync(HULL_ROOT, file, scene)
      .then((container) => {
        if (isSceneDisposed(scene, state)) {
          container.dispose();
          return null;
        }
        loading.container = container;
        loading.triangles = container.meshes.reduce((total, mesh) => {
          const indices = typeof mesh.getTotalIndices === 'function' ? mesh.getTotalIndices() : 0;
          return total + Math.floor(indices / 3);
        }, 0);
        return loading;
      })
      .catch(() => {
        logOnce('hull:' + file, 'Hull ' + file + ' unavailable; using procedural hulls.');
        return null;
      });
    return record.promise;
  }

  function fitsBudget(state, record, released) {
    return state.triangles - released + record.triangles < TRIANGLE_BUDGET;
  }

  function logBudget(scene) {
    logOnce('budget:' + scene.uid, 'Ship hull triangle budget reached; using procedural hulls.');
  }

  /**
   * Loads the first of the hull's files that fits the scene's triangle budget.
   * @param {number} released triangles the ship gives back if this replaces its hull
   * @returns {Promise<HullAsset | null>}
   */
  function resolveAsset(scene, state, hull, released) {
    const files = hullFiles(hull, viewLod(scene) || 'far');
    const tryFile = (index) => {
      if (index >= files.length) {
        logBudget(scene);
        return Promise.resolve(null);
      }
      return ensureContainer(scene, state, files[index].file).then((record) => {
        if (!record || isSceneDisposed(scene, state)) return null;
        if (fitsBudget(state, record, released)) return { ...files[index], record };
        return tryFile(index + 1);
      });
    };
    return tryFile(0);
  }

  // ---------- materials ----------

  function childMeshes(rootNodes) {
    const meshes = [];
    const seen = new Set();
    for (const root of rootNodes) {
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

  function fleetMaterial(scene, state, file, selfLight, ship, baseMaterial) {
    const provider = AUR.providerMeta(ship && ship.provider);
    const sourceName = String(baseMaterial && baseMaterial.name || 'material');
    const key = file + ':' + provider.key + ':' + sourceName;
    let material = state.materials.get(key);
    if (material) return material;
    const id = 'ship_fleet_' + file + '_' + provider.key + '_' + sourceName;
    material = baseMaterial && typeof baseMaterial.clone === 'function'
      ? baseMaterial.clone(id)
      : new BABYLON.StandardMaterial(id, scene);
    const tint = AUR.color3(provider.color);
    const name = sourceName.toLowerCase();
    let surface = paletteTone(tint, 0.38, 0.09);
    let emissive = null;

    if (/armor_secondary|hull_textured/.test(name)) surface = paletteTone(tint, 0.58, 0.10);
    if (/structure|ivory/.test(name)) surface = paletteTone(tint, 0.25, 0.42);
    if (/mechanical|gunmetal/.test(name)) surface = paletteTone(tint, 0.06, 0.045);
    if (/recess/.test(name)) surface = paletteTone(tint, 0.03, 0.02);
    if (/solar/.test(name)) surface = paletteTone(tint, 0.12, 0.03);
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
    material.emissiveColor = emissive || (selfLight ? surface.scale(FAR_SELF_LIGHT) : new BABYLON.Color3(0, 0, 0));
    if (typeof material.metallic === 'number' && /accent|energy|engine|glow/.test(name)) material.metallic = 0.42;
    if (typeof material.roughness === 'number' && /accent|energy|engine|glow/.test(name)) material.roughness = 0.22;
    state.materials.set(key, material);
    return material;
  }

  // ---------- building a hull ----------

  /** One tinted, hidden copy of a hull per provider; universe ships draw as its instances. */
  function providerTemplate(scene, state, asset, ship) {
    const key = asset.file + '|' + AUR.providerKey(ship && ship.provider);
    let roots = state.templates.get(key);
    if (roots) return roots;
    const entries = asset.record.container.instantiateModelsToScene(
      (sourceName) => 'ship_template_' + key + '_' + sourceName,
      false,
      { doNotInstantiate: true }
    );
    for (const mesh of childMeshes(entries.rootNodes)) {
      mesh.material = fleetMaterial(scene, state, asset.file, asset.lod === 'far', ship, mesh.material);
      mesh.isPickable = false;
      mesh.isVisible = false;
    }
    roots = entries.rootNodes;
    state.templates.set(key, roots);
    return roots;
  }

  // Instances share their source's material and visibility, so only the
  // universe map (no focus mode fading ships one by one) instances hulls.
  function placeInstances(scene, state, asset, ship, pivot) {
    const created = [];
    for (const node of providerTemplate(scene, state, asset, ship)) {
      node.instantiateHierarchy(pivot, undefined, (source, copy) => {
        copy.name = 'ship_' + String(ship.id) + '_' + source.name;
        created.push(copy);
      });
    }
    const meshes = childMeshes(created);
    for (const mesh of meshes) mesh.isVisible = true;
    return meshes;
  }

  function placeClones(scene, state, asset, ship, pivot) {
    const entries = asset.record.container.instantiateModelsToScene(
      (sourceName) => 'ship_' + String(ship.id) + '_' + sourceName,
      false,
      { doNotInstantiate: true }
    );
    for (const node of entries.rootNodes) node.parent = pivot;
    const meshes = childMeshes(entries.rootNodes);
    for (const mesh of meshes) {
      mesh.material = fleetMaterial(scene, state, asset.file, asset.lod === 'far', ship, mesh.material);
    }
    return meshes;
  }

  /**
   * Builds the correction node (rotation, class display size, offset) holding
   * the hull's meshes. Returns null when the model cannot be instantiated.
   * @param {HullEntry} hull @param {HullAsset} asset
   */
  function buildHull(scene, state, hull, asset, ship) {
    const correction = new BABYLON.TransformNode('ship_correction_' + ship.id, scene);
    const pivot = new BABYLON.TransformNode('ship_pivot_' + ship.id, scene);
    pivot.parent = correction;
    const data = hull.correction || {};
    correction.rotation.y = Number(data.rotateY) || 0;
    correction.scaling.setAll(Number(data.scale) || 1);
    const offset = Array.isArray(data.offset) ? data.offset : [0, 0, 0];
    pivot.position.set(Number(offset[0]) || 0, Number(offset[1]) || 0, Number(offset[2]) || 0);
    let meshes;
    try {
      meshes = viewLod(scene) === 'far'
        ? placeInstances(scene, state, asset, ship, pivot)
        : placeClones(scene, state, asset, ship, pivot);
    } catch (error) {
      correction.dispose();
      logOnce('instance:' + hull.id, 'Hull ' + hull.id + ' could not be instantiated; using procedural hulls.');
      return null;
    }
    let evidence = null;
    for (const mesh of meshes) {
      mesh.isPickable = false;
      const sourceName = String(mesh.material && mesh.material.name || '');
      if (!evidence || /accent|energy|engine|glow/i.test(sourceName)) evidence = mesh.material;
      mesh.metadata = {
        ...(mesh.metadata || {}),
        providerPalette: true,
        providerKey: AUR.providerKey(ship && ship.provider),
        assetHullId: hull.id,
      };
    }
    return {
      correction,
      evidence: evidence || fleetMaterial(scene, state, asset.file, false, ship, null),
    };
  }

  function hullMetadata(hull, asset, ship) {
    return {
      assetHullId: hull.id,
      assetFamily: hull.family,
      assetRole: hull.role,
      assetLod: asset.lod,
      providerTint: AUR.shipTint(ship && ship.id, ship && ship.provider),
    };
  }

  /** @param {HullEntry} hull @param {HullAsset} asset @returns {ShipEntry | null} */
  function createShipEntry(scene, state, hull, asset, ship) {
    const built = buildHull(scene, state, hull, asset, ship);
    if (!built) return null;
    const root = new BABYLON.Mesh('ship_asset_' + ship.id, scene);
    built.correction.parent = root;
    root.material = built.evidence;
    root.metadata = hullMetadata(hull, asset, ship);
    root.isPickable = false;
    /** @type {ShipEntry} */
    const entry = {
      root, correction: built.correction, hull, triangles: asset.record.triangles,
      wanted: hull.id, fallback: null,
    };
    const shipId = String(ship.id);
    state.triangles += entry.triangles;
    state.ships.set(shipId, entry);
    root.onDisposeObservable.addOnce(() => {
      state.triangles = Math.max(0, state.triangles - entry.triangles);
      if (state.ships.get(shipId) === entry) state.ships.delete(shipId);
    });
    return entry;
  }

  // ---------- public API ----------

  function instantiate(scene, ship) {
    const state = stateFor(scene);
    if (!manifestSettled || !manifestValue || isSceneDisposed(scene, state)) return null;
    const hull = selectHull(manifestValue, ship);
    if (!hull) return null;
    const lod = viewLod(scene);
    if (!lod && hull.lods) return null; // upgrade() resolves the file once the view is known
    const file = hullFiles(hull, lod || 'far')[0];
    const record = state.containers.get(file.file);
    if (!record || !record.container) {
      ensureContainer(scene, state, file.file);
      return null;
    }
    if (!fitsBudget(state, record, 0)) return null; // upgrade() may step down to the far file
    const entry = createShipEntry(scene, state, hull, { ...file, record }, ship);
    return entry ? entry.root : null;
  }

  function upgrade(scene, ship, fallback, displayScale) {
    const state = stateFor(scene);
    return manifestPromise.then((manifest) => {
      if (!manifest || isSceneDisposed(scene, state)) return null;
      const hull = selectHull(manifest, ship);
      if (!hull) return null;
      return resolveAsset(scene, state, hull, 0).then((asset) => {
        if (!asset || isNodeDisposed(fallback) || isSceneDisposed(scene, state)) return null;
        const entry = createShipEntry(scene, state, hull, asset, ship);
        if (!entry) return null;
        const assetRoot = entry.root;
        entry.fallback = fallback;
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

  // Focus mode in the system view saves and restores each mesh's visibility;
  // a hull swapped in meanwhile would escape that, so it waits.
  function isFaded(entry) {
    const nodes = [entry.root, ...entry.root.getChildMeshes(false)];
    if (entry.fallback) nodes.push(entry.fallback);
    return nodes.some((node) => typeof node.visibility === 'number' && node.visibility < 1);
  }

  /** @param {ShipEntry} entry @param {HullEntry} hull @param {HullAsset} asset */
  function swapHull(scene, state, entry, hull, asset, ship) {
    const built = buildHull(scene, state, hull, asset, ship);
    if (!built) return false;
    built.correction.parent = entry.root;
    entry.correction.dispose(false, false);
    state.triangles += asset.record.triangles - entry.triangles;
    entry.triangles = asset.record.triangles;
    entry.correction = built.correction;
    entry.hull = hull;
    entry.root.material = built.evidence;
    entry.root.metadata = { ...(entry.root.metadata || {}), ...hullMetadata(hull, asset, ship) };
    if (entry.fallback && entry.fallback.metadata) {
      entry.fallback.metadata = { ...entry.fallback.metadata, upgradedHullId: hull.id };
    }
    return true;
  }

  /**
   * Swaps a ship's hull in place when its rank has changed. The asset root the
   * scene holds (directly, or under its fallback dart) stays the same node.
   * Resolves to the root once swapped, else null (no model yet, same rank,
   * superseded, or deferred while focus mode fades the ship).
   * @param {Ship} ship
   * @returns {Promise<BABYLON.Mesh | null>}
   */
  function refresh(scene, ship) {
    const state = sceneStates.get(scene);
    const entry = state && ship ? state.ships.get(String(ship.id)) : null;
    if (!entry || isSceneDisposed(scene, state)) return Promise.resolve(null);
    const hull = selectHull(manifestValue, ship);
    if (!hull || hull.id === entry.hull.id) return Promise.resolve(null);
    entry.wanted = hull.id;
    return resolveAsset(scene, state, hull, entry.triangles).then((asset) => {
      if (!asset || entry.wanted !== hull.id || isNodeDisposed(entry.root) ||
          isSceneDisposed(scene, state) || isFaded(entry)) return null;
      return swapHull(scene, state, entry, hull, asset, ship) ? entry.root : null;
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
    state.templates.clear();
    state.ships.clear();
    sceneStates.delete(scene);
  }

  AUR.ships = { instantiate, upgrade, refresh, dispose };
})();

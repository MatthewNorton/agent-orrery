// @ts-check
// ship-assets.js — manifest-backed original hull loading with procedural fallback: the manifest,
// per-scene state, hull choice and container loading. ship-assets-hulls.js builds hulls from these
// and ship-assets-api.js publishes AUR.ships.
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
 *   triangles: number, look: string, wanted: string, fallback: BABYLON.AbstractMesh | null }} ShipEntry
 * @typedef {{ containers: Map<string, HullRecord>, materials: Map<string, any>,
 *   templates: Map<string, BABYLON.TransformNode[]>, ships: Map<string, ShipEntry>,
 *   triangles: number, disposed: boolean }} SceneState
 * @typedef {object} ShipAssetsCore shared by the ship-assets*.js files as AUR.shipAssets
 * @property {(key: string, message: string) => void} logOnce
 * @property {Promise<ShipManifest | null>} manifestPromise
 * @property {() => ShipManifest | null} settledManifest null until the manifest has loaded
 * @property {WeakMap<object, SceneState>} sceneStates
 * @property {(scene: any) => SceneState} stateFor
 * @property {(scene: any, state: SceneState) => boolean} isSceneDisposed
 * @property {(scene: any) => 'far' | 'near' | null} viewLod
 * @property {(manifest: ShipManifest | null, ship: Ship) => HullEntry | null} selectHull
 * @property {(hull: HullEntry, lod: 'far' | 'near') => HullFile[]} hullFiles
 * @property {(scene: any, state: SceneState, file: string) => Promise<HullRecord | null>} ensureContainer
 * @property {(state: SceneState, record: HullRecord, released: number) => boolean} fitsBudget
 * @property {(scene: any, state: SceneState, hull: HullEntry, released: number) => Promise<HullAsset | null>} resolveAsset
 */

(function () {
  const AUR = window.AUR;
  const MANIFEST_PATH = '../../assets/ships/manifest.json';
  const HULL_ROOT = '../../assets/ships/';
  const TRIANGLE_BUDGET = 100000;
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

  /** @type {ShipAssetsCore} */
  const core = {
    logOnce, manifestPromise, sceneStates, stateFor, isSceneDisposed,
    settledManifest: () => (manifestSettled ? manifestValue : null),
    viewLod, selectHull, hullFiles, ensureContainer, fitsBudget, resolveAsset,
  };
  AUR.shipAssets = core;
})();

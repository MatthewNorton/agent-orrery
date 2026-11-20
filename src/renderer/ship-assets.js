// @ts-check
// Manifest-backed original hull loading with procedural fallback: the manifest,
// per-scene state, hull choice and container loading. ship-assets-hulls.js builds hulls from these
// and ship-assets-api.js publishes AUR.ships.
'use strict';

/**
 * @import { Ship } from '../types/contract'
 * @import { ShipModel } from './ships/models.js'
 * @typedef {{ rotateY?: number, scale?: number, offset?: number[] }} HullCorrection
 * @typedef {{ id: string, file: string, lods?: { far?: string }, family: string, role: string,
 *   minBuilds?: number, correction?: HullCorrection, model?: ShipModel }} HullEntry a hull of the
 *   manifest, or the hull a ship model flies as (ships/models.js): `model` builds it and its
 *   `file` names no file
 * @typedef {{ schemaVersion: number, providerFamilies: Record<string, string>,
 *   hulls: HullEntry[] }} ShipManifest
 * @typedef {{ container: BABYLON.AssetContainer | null, promise: Promise<HullRecord | null> | null,
 *   triangles: number }} HullRecord
 * @typedef {{ file: string, lod: 'far' | 'near' | null, model?: ShipModel }} HullFile
 * @typedef {HullFile & { record: HullRecord }} HullAsset
 * @typedef {{ roots: BABYLON.TransformNode[], meshes: BABYLON.AbstractMesh[] }} HullTemplate a hidden
 *   copy of a hull that ships draw as instances of, and its meshes
 * @typedef {{ root: BABYLON.Mesh, correction: BABYLON.TransformNode, own: HullTemplate | null,
 *   hull: HullEntry, asset: HullAsset, ship: any, request: number,
 *   fallback: BABYLON.AbstractMesh | null }} ShipEntry `hull`, `asset` and `ship` are what its hull
 *   was last built from, so a fade can rebuild that hull exactly (its triangles are its asset's,
 *   its look lookOf(hull, ship)); `request` counts its refresh calls, so a waiting one can tell a
 *   later one came; `own` is the template of its own it is built on while focus mode shows it apart
 * @typedef {{ containers: Map<string, HullRecord>, materials: Map<string, any>,
 *   templates: Map<string, HullTemplate>, ships: Map<string, ShipEntry>, triangles: number,
 *   visibility: number, apart: { shipId: string, visibility: number } | null,
 *   disposed: boolean }} SceneState `visibility` is the fleet's, which every template shows, and
 *   `apart` the one ship focus mode shows at a visibility of its own (AUR.ships.fade)
 * @typedef {object} ShipAssetsCore shared by the ship-assets*.js files as AUR.shipAssets
 * @property {(key: string, message: string) => void} logOnce
 * @property {Promise<ShipManifest | null>} manifestPromise
 * @property {() => ShipManifest | null} settledManifest null until the manifest has loaded
 * @property {WeakMap<object, SceneState>} sceneStates
 * @property {(scene: any) => SceneState} stateFor
 * @property {(scene: any, state: SceneState) => boolean} isSceneDisposed
 * @property {(state: SceneState, ship: any) => number | null} apartVisibility
 * @property {(state: SceneState, ship: any) => number | null} ownVisibility
 * @property {(scene: any) => 'far' | 'near' | null} viewLod
 * @property {(manifest: ShipManifest | null, ship: Ship) => HullEntry | null} selectHull
 * @property {(hull: HullEntry, lod: 'far' | 'near') => HullFile[]} hullFiles
 * @property {(scene: any, state: SceneState, file: HullFile) => Promise<HullRecord | null>} ensureContainer
 * @property {(scene: any, state: SceneState, record: HullRecord, released: number) => boolean} fitsBudget
 * @property {<T>(scene: any, state: SceneState, hull: HullEntry, released: () => number, live: () => boolean,
 *   build: (asset: HullAsset) => T) => Promise<T | null>} resolveAsset
 */

(function () {
  const AUR = window.AUR;
  const MANIFEST_PATH = '../../assets/ships/manifest.json';
  const HULL_ROOT = '../../assets/ships/';
  // The triangles a view's hulls may hold, past which a ship flies its dart (a near view tries a
  // hull's far file first). Hulls carry their detail as geometry (10k to 58k triangles each), and
  // a template's ships draw in one draw per part, so what grows with the fleet is the triangles
  // drawn, which is what this counts. A system or planet view holds fifty-one ships of the first
  // rank (Petrel, 17,544), the universe map seventy.
  const TRIANGLE_BUDGET = { near: 900000, far: 1240000 };
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
    return !state || state.disposed || AUR.isNodeDisposed(scene);
  }

  /** @returns {SceneState} */
  function stateFor(scene) {
    let state = sceneStates.get(scene);
    if (!state) {
      state = {
        containers: new Map(), materials: new Map(), templates: new Map(), ships: new Map(),
        triangles: 0, visibility: 1, apart: null, disposed: false,
      };
      sceneStates.set(scene, state);
    }
    return state;
  }

  // What focus mode's fade shows of a ship apart from the fleet, or null when it shows the fleet's.
  function apartVisibility(state, ship) {
    const { apart } = state;
    return apart && apart.shipId === String(ship.id) ? apart.visibility : null;
  }

  // The visibility of the template of its own a ship's hull is built on, or null for the fleet's
  // template of its look. A hidden ship (0) is disabled, never built on a template at 0.
  function ownVisibility(state, ship) {
    const visibility = apartVisibility(state, ship);
    return visibility === null || visibility === 0 || visibility === state.visibility ? null : visibility;
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
    const familyHulls = manifest.hulls.filter((hull) => hull.family === family);
    return familyHulls.length ? familyHulls[hash % familyHulls.length] : null;
  }

  /** @param {ShipManifest | null} manifest @param {Ship} ship @returns {HullEntry | null} */
  function selectHull(manifest, ship) {
    if (!manifest) return null;
    const providerKey = AUR.providerKey(ship && ship.provider);
    if (providerKey === 'generic') return null;
    // A provider the frozen manifest does not list (a local server) flies the first listed family.
    const family = manifest.providerFamilies[providerKey] || Object.values(manifest.providerFamilies)[0];
    if (!family) return null;
    const ladder = rankLadder(manifest, family);
    if (!ladder.length) return hashedHull(manifest, family, ship);
    // A drone (subagent) flies the family's first rank whatever its build count; the view shrinks it.
    const ranked = ship && ship.kind === 'drone' ? ladder[0] : rankedHull(ladder, Number(ship && ship.builds) || 0);
    return AUR.shipModels.inPlaceOf(ranked); // a rank a model has taken over flies the model
  }

  /**
   * Files to try in order: a near view steps down to the far file when the
   * triangle budget is short. Hulls without LODs have one file for every view.
   * @param {HullEntry} hull @param {'far' | 'near'} lod @returns {HullFile[]}
   */
  function hullFiles(hull, lod) {
    const far = hull.lods && hull.lods.far;
    if (!far) return [{ file: hull.file, lod: null, model: hull.model }];
    const farFile = { file: far, lod: /** @type {'far'} */ ('far') };
    return lod === 'near' ? [{ file: hull.file, lod: 'near' }, farFile] : [farFile];
  }

  // ---------- loading ----------

  /** @param {HullFile} hullFile @returns {Promise<HullRecord | null>} */
  function ensureContainer(scene, state, hullFile) {
    const { file, model } = hullFile;
    let record = state.containers.get(file);
    if (!record) {
      record = { container: null, promise: null, triangles: 0 };
      state.containers.set(file, record);
    }
    if (record.container) return Promise.resolve(record);
    if (record.promise) return record.promise;
    const loading = record;
    // A model's container is built in code, a manifest hull's is loaded from its file. A build
    // queued for a scene that is gone by the time it runs builds nothing.
    record.promise = (model
      ? Promise.resolve().then(() => (isSceneDisposed(scene, state) ? null : AUR.shipModels.container(scene, model)))
      : BABYLON.SceneLoader.LoadAssetContainerAsync(HULL_ROOT, file, scene))
      .then((container) => {
        if (!container) return null;
        if (isSceneDisposed(scene, state)) {
          container.dispose(); // with its materials and textures, a model's as a file's
          return null;
        }
        loading.container = container;
        loading.triangles = container.meshes.reduce((total, mesh) => {
          const indices = typeof mesh.getTotalIndices === 'function' ? mesh.getTotalIndices() : 0;
          return total + Math.floor(indices / 3);
        }, 0);
        return loading;
      })
      .catch((error) => {
        logOnce('hull:' + file, 'Hull ' + file + ' unavailable (' + (error && error.message || error) + '); using procedural hulls.');
        return null;
      });
    return record.promise;
  }

  function fitsBudget(scene, state, record, released) {
    return state.triangles - released + record.triangles < TRIANGLE_BUDGET[viewLod(scene) || 'far'];
  }

  function logBudget(scene) {
    logOnce('budget:' + scene.uid, 'Ship hull triangle budget reached; using procedural hulls.');
  }

  /**
   * Builds the hull from the first of its files that fits the scene's triangle budget, in the
   * callback that finds it fits. A build is synchronous, so no other hull is built between that
   * check and this one, and ships waiting on one container keep to the budget as ships that come
   * one by one do. A request that has ended (its scene or ship gone, its swap superseded) starts
   * no further load and builds nothing.
   * @template T
   * @param {() => number} released triangles the ship gives back if this replaces its hull
   * @param {() => boolean} live
   * @param {(asset: HullAsset) => T} build
   * @returns {Promise<T | null>}
   */
  function resolveAsset(scene, state, hull, released, live, build) {
    const files = hullFiles(hull, viewLod(scene) || 'far');
    const ended = () => isSceneDisposed(scene, state) || !live();
    const tryFile = (index) => {
      if (ended()) return Promise.resolve(null);
      if (index >= files.length) {
        logBudget(scene);
        return Promise.resolve(null);
      }
      return ensureContainer(scene, state, files[index]).then((record) => {
        if (!record || ended()) return null;
        if (fitsBudget(scene, state, record, released())) return build({ ...files[index], record });
        return tryFile(index + 1);
      });
    };
    return tryFile(0);
  }

  /** @type {ShipAssetsCore} */
  const core = {
    logOnce, manifestPromise, sceneStates, stateFor, isSceneDisposed, apartVisibility, ownVisibility,
    settledManifest: () => (manifestSettled ? manifestValue : null),
    viewLod, selectHull, hullFiles, ensureContainer, fitsBudget, resolveAsset,
  };
  AUR.shipAssets = core;
})();

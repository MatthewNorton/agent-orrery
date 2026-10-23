// @ts-check
// AUR.ships: instantiate a ship's hull, upgrade a fallback dart to one,
// refresh it in place on promotion, and dispose a scene's hull state.
'use strict';

/**
 * @import { Ship } from '../types/contract'
 * @import { ShipAssetsCore } from './ship-assets.js'
 * @import { ShipAssetsHulls } from './ship-assets-hulls.js'
 */

(function () {
  const AUR = window.AUR;
  /** @type {ShipAssetsCore & ShipAssetsHulls} */
  const assets = AUR.shipAssets;
  const {
    manifestPromise, settledManifest, sceneStates, stateFor, isSceneDisposed, viewLod, selectHull,
    hullFiles, ensureContainer, fitsBudget, resolveAsset, lookOf, createShipEntry, swapHull,
  } = assets;

  function instantiate(scene, ship) {
    const state = stateFor(scene);
    const manifest = settledManifest();
    if (!manifest || isSceneDisposed(scene, state)) return null;
    const hull = selectHull(manifest, ship);
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

  function upgrade(scene, ship, fallback) {
    const state = stateFor(scene);
    return manifestPromise.then((manifest) => {
      if (!manifest || isSceneDisposed(scene, state)) return null;
      const hull = selectHull(manifest, ship);
      if (!hull) return null;
      return resolveAsset(scene, state, hull, 0).then((asset) => {
        if (!asset || AUR.isNodeDisposed(fallback) || isSceneDisposed(scene, state)) return null;
        const entry = createShipEntry(scene, state, hull, asset, ship);
        if (!entry) return null;
        const assetRoot = entry.root;
        entry.fallback = fallback;
        // The dart root keeps the view's display scale; the hull sits inside it at unit scale.
        assetRoot.parent = fallback;
        fallback.isPickable = false;
        fallback.isVisible = false; // children keep drawing; the dart itself leaves the render queues
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
    const nodes = AUR.nodeFamily(entry.root);
    if (entry.fallback) nodes.push(entry.fallback);
    return nodes.some((node) => typeof node.visibility === 'number' && node.visibility < 1);
  }

  /**
   * Swaps a ship's hull in place when its rank or colors have changed (a ship
   * learns it runs a local model after it spawns). The asset root the scene
   * holds (directly, or under its fallback dart) stays the same node. Resolves
   * to the root once swapped, else null (no model yet, same look, superseded,
   * or deferred while focus mode fades the ship).
   * @param {Ship} ship
   * @returns {Promise<BABYLON.Mesh | null>}
   */
  function refresh(scene, ship) {
    const state = sceneStates.get(scene);
    const entry = state && ship ? state.ships.get(String(ship.id)) : null;
    if (!entry || isSceneDisposed(scene, state)) return Promise.resolve(null);
    const hull = selectHull(settledManifest(), ship);
    if (!hull) return Promise.resolve(null);
    const look = lookOf(hull, ship);
    entry.wanted = look; // also cancels a pending swap when the rank falls back
    if (look === entry.look) return Promise.resolve(null);
    return resolveAsset(scene, state, hull, entry.triangles).then((asset) => {
      if (!asset || entry.wanted !== look || AUR.isNodeDisposed(entry.root) ||
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

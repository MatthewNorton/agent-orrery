// @ts-check
// AUR.ships: instantiate a ship's hull, upgrade a fallback dart to one, refresh it in place on
// promotion, fade the fleet while focus mode follows a ship, and dispose a scene's hull state.
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
    manifestPromise, settledManifest, sceneStates, stateFor, isSceneDisposed, apartVisibility, ownVisibility,
    viewLod, selectHull, hullFiles, ensureContainer, fitsBudget, resolveAsset, lookOf, createShipEntry, swapHull,
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
      ensureContainer(scene, state, file);
      return null;
    }
    if (!fitsBudget(scene, state, record, 0)) return null; // upgrade() may step down to the far file
    const entry = createShipEntry(scene, state, hull, { ...file, record }, ship);
    return entry ? entry.root : null;
  }

  function upgrade(scene, ship, fallback) {
    const state = stateFor(scene);
    return manifestPromise.then((manifest) => {
      if (!manifest || isSceneDisposed(scene, state)) return null;
      const hull = selectHull(manifest, ship);
      if (!hull) return null;
      return resolveAsset(scene, state, hull, () => 0, () => !AUR.isNodeDisposed(fallback), (asset) => {
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

  /**
   * Shows every hull in the scene at `visibility`, except the ship `apart` names, at its own (0
   * hides it): focus mode in the system view fades the ships it does not follow and shows the one
   * it follows in full, or hides it from inside, then restores them all at 1. It holds for hulls
   * built later too (a ship that arrives, a promotion). The fleet fades on its templates. A ship
   * is rebuilt exactly when it must move onto or off a template of its own: onto one when it is
   * shown apart above 0 at a visibility other than the fleet's, off it when it is shown at the
   * fleet's. Hiding or showing a ship that stays on the template it has rebuilds nothing. Focus
   * mode shows one ship apart at a time, so entering or leaving focus rebuilds at most one hull
   * and following another ship at most two. A ship that cannot be rebuilt keeps the hull it has,
   * drawn exactly when the fade shows it and at the fade's visibility as far as that hull's
   * template allows, and is rebuilt at a later fade. A dart or a signal has meshes of its own,
   * which focus mode fades itself.
   * @param {number} visibility
   * @param {{ shipId: string, visibility: number }} [apart]
   */
  function fade(scene, visibility, apart) {
    const state = stateFor(scene);
    if (isSceneDisposed(scene, state)) return;
    const before = state.apart;
    state.visibility = visibility;
    state.apart = apart ? { shipId: String(apart.shipId), visibility: apart.visibility } : null;
    const show = (template, value) => { for (const mesh of template.meshes) mesh.visibility = value; };
    for (const template of state.templates.values()) show(template, visibility);
    // The ships apart before and now, and any that a failed rebuild left on a template of its own.
    const ids = new Set([before && before.shipId, state.apart && state.apart.shipId]);
    for (const [id, entry] of state.ships) if (entry.own) ids.add(id);
    for (const id of ids) {
      const entry = id ? state.ships.get(id) : null;
      if (!entry) continue;
      const shown = apartVisibility(state, entry.ship);
      const own = ownVisibility(state, entry.ship);
      const moves = shown !== 0 && (own !== null) !== Boolean(entry.own);
      if (moves && swapHull(scene, state, entry, entry.hull, entry.asset, entry.ship)) continue; // lands as the fade says
      // On the hull it has: shown as the fade shows it, as far as that hull's template allows.
      if (entry.own && shown !== 0) show(entry.own, own === null ? visibility : own);
      entry.correction.setEnabled(shown !== 0);
    }
  }

  /**
   * Swaps a ship's hull in place when its rank or colors have changed (a ship
   * learns it runs a local model after it spawns). The asset root the scene
   * holds (directly, or under its fallback dart) stays the same node, and the
   * new hull lands as focus mode's fade shows the ship (fade). Every call is a
   * new request that ends the ones before it, so only the latest builds: a call
   * for the look already loading takes over from the one before, and the hull
   * is built once; a call for the look the ship has builds nothing. Resolves to
   * the root once this request swapped it, else null (no model, the same look,
   * or ended).
   * @param {Ship} ship
   * @returns {Promise<BABYLON.Mesh | null>}
   */
  function refresh(scene, ship) {
    const state = sceneStates.get(scene);
    const entry = state && ship ? state.ships.get(String(ship.id)) : null;
    if (!entry || isSceneDisposed(scene, state)) return Promise.resolve(null);
    const request = ++entry.request;
    const hull = selectHull(settledManifest(), ship);
    if (!hull || lookOf(hull, ship) === lookOf(entry.hull, entry.ship)) return Promise.resolve(null);
    const live = () => entry.request === request && !AUR.isNodeDisposed(entry.root);
    return resolveAsset(scene, state, hull, () => entry.asset.record.triangles, live,
      (asset) => (swapHull(scene, state, entry, hull, asset, ship) ? entry.root : null)).catch(() => null);
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

  AUR.ships = { instantiate, upgrade, refresh, fade, dispose };
})();

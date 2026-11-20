// @ts-check
// Builds a ship's hull from a loaded model, in its livery (ships/livery.js): instances of a
// template per hull file and palette in every view, and in-place swaps on promotion, each built as
// focus mode's fade shows the ship.
'use strict';

/**
 * @import { HullAsset, HullEntry, HullTemplate, SceneState, ShipAssetsCore, ShipEntry } from './ship-assets.js'
 * @import { ShipAssetsLivery } from './ships/livery.js'
 * @typedef {object} ShipAssetsHulls added to AUR.shipAssets by ship-assets-hulls.js
 * @property {(hull: HullEntry, ship: any) => string} lookOf
 * @property {(scene: any, state: SceneState, hull: HullEntry, asset: HullAsset, ship: any) => ShipEntry | null} createShipEntry
 * @property {(scene: any, state: SceneState, entry: ShipEntry, hull: HullEntry, asset: HullAsset, ship: any) => boolean} swapHull
 * @property {(state: SceneState, entry: ShipEntry) => void} forget
 */

(function () {
  const AUR = window.AUR;
  /** @type {ShipAssetsCore & ShipAssetsLivery} */
  const core = AUR.shipAssets;
  const { logFailure, guarded, viewLod, apartVisibility, ownVisibility, paletteKey, hullMaterial, evidenceMaterial } = core;

  /** What refresh() compares: the rank's hull and the colors it wears. */
  function lookOf(hull, ship) {
    return hull.id + '|' + paletteKey(ship);
  }

  // ---------- building a hull ----------

  function childMeshes(rootNodes) {
    const meshes = [];
    const seen = new Set();
    for (const root of rootNodes) {
      for (const mesh of AUR.nodeFamily(root)) {
        if (seen.has(mesh) || !mesh.material) continue;
        seen.add(mesh);
        meshes.push(mesh);
      }
    }
    return meshes;
  }

  /** @param {Pick<HullTemplate, 'roots'>} template */
  function disposeTemplate(template) {
    for (const root of template.roots) root.dispose(false, false); // its materials are the scene's
  }

  /**
   * A tinted, hidden copy of a hull: every ship of that look draws as its instances, in one draw
   * per part. An instance takes its source's material, visibility and lights, so the template
   * carries the layer of the ship-only lights that reach the hull (the models' own, or the fleet's
   * key and rim), and the visibility its ships show: the fleet's, which focus mode fades by
   * writing it on every template (AUR.ships.fade), or one of its own for the ship it shows apart.
   * @returns {HullTemplate}
   */
  function makeTemplate(scene, state, asset, ship, name, visibility) {
    const roots = asset.record.container.instantiateModelsToScene(
      (sourceName) => name + '_' + sourceName,
      false,
      { doNotInstantiate: true }
    ).rootNodes;
    try {
      // The lightless map's hulls light themselves, as does a far file stepped down to up close.
      const selfLight = viewLod(scene) === 'far' || asset.lod === 'far';
      const layer = asset.model ? AUR.shipModels.LAYER : AUR.SHIP_LAYER;
      const meshes = childMeshes(roots);
      for (const mesh of meshes) {
        mesh.material = hullMaterial(scene, state, asset, selfLight, ship, mesh.material);
        mesh.isPickable = false;
        mesh.isVisible = false;
        mesh.visibility = visibility;
        mesh.layerMask |= layer;
        // Babylon sorts a template's ships as one, at the template's place: the scene origin,
        // where the sun's glow is too. Past the default (Number.MAX_VALUE), which every other mesh
        // keeps, a faded fleet draws after every other blended mesh, wherever its ships are, and
        // never with the glow or a planet's shell between its parts. Only a faded hull blends: no
        // flown hull has a blended material in full.
        mesh.alphaIndex = Number.POSITIVE_INFINITY;
      }
      return { roots, meshes };
    } catch (error) {
      // The parts not reached yet would draw, in the file's materials.
      for (const root of roots) AUR.disposeLogged(root, 'Unmade template ' + name);
      throw error;
    }
  }

  // The template a ship's hull is built on: its look's, one per hull file and palette at the
  // fleet's visibility, or one of its own while focus mode shows it apart (`own`).
  function templateFor(scene, state, asset, ship, own) {
    const key = asset.file + '|' + paletteKey(ship);
    if (own !== null) return makeTemplate(scene, state, asset, ship, 'ship_template_' + key + '|' + ship.id, own);
    return AUR.memo(state.templates, key,
      () => makeTemplate(scene, state, asset, ship, 'ship_template_' + key, state.visibility));
  }

  /**
   * Builds the correction node (rotation, class display size, offset) holding the hull's meshes,
   * on the template and in the state focus mode's fade gives the ship: disabled when it is hidden.
   * Returns null, leaving nothing of it behind, when the hull cannot be built: for a new ship, a
   * promotion or a fade alike, the ship keeps the hull or dart it has.
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
    correction.setEnabled(apartVisibility(state, ship) !== 0);
    const own = ownVisibility(state, ship);
    const tags = { providerPalette: true, providerKey: AUR.providerKey(ship && ship.provider), assetHullId: hull.id };
    let template = null;
    try {
      template = templateFor(scene, state, asset, ship, own);
      for (const node of template.roots) {
        // An instance for each part, a copy for each node without geometry.
        node.instantiateHierarchy(pivot, undefined, (source, copy) => {
          copy.name = 'ship_' + String(ship.id) + '_' + source.name;
          if (!copy.material) return;
          copy.isPickable = false;
          copy.metadata = { ...(copy.metadata || {}), ...tags };
        });
      }
      return { correction, own: own === null ? null : template, evidence: evidenceMaterial(scene, state, ship) };
    } catch (error) {
      // The fleet's template stays.
      unbuilt(hull, error, { correction, own: template && own !== null ? template : null }, null);
      return null;
    }
  }

  // Lets go of a hull no ship is to hold: hidden first, then off what holds it, then disposed, a
  // template of its own with it. Each step is guarded, so the hull is let go as far as it can be.
  /** @param {string} name @param {BABYLON.TransformNode} correction @param {HullTemplate | null} own */
  function discard(name, correction, own) {
    guarded(name, [
      [' could not be hidden', () => correction.setEnabled(false)],
      [' could not be taken off its ship', () => { correction.parent = null; }],
      [' could not be disposed', () => correction.dispose(false, false)],
    ]);
    if (own) discardTemplate(name, own);
  }

  function discardTemplate(name, own) {
    guarded(name, [["'s own template could not be disposed", () => disposeTemplate(own)]]);
  }

  function hullMetadata(hull, asset, ship) {
    const { id, family, role } = hull;
    return {
      assetHullId: id,
      assetFamily: family,
      assetRole: role,
      assetLod: asset.lod,
      providerTint: AUR.shipColor(ship),
    };
  }

  /** @param {HullEntry} hull @param {HullAsset} asset @returns {ShipEntry | null} */
  function createShipEntry(scene, state, hull, asset, ship) {
    const built = buildHull(scene, state, hull, asset, ship);
    if (!built) return null;
    let root = null;
    try {
      root = new BABYLON.Mesh('ship_asset_' + ship.id, scene);
      built.correction.parent = root;
      root.material = built.evidence;
      root.metadata = hullMetadata(hull, asset, ship);
      root.isPickable = false;
      /** @type {ShipEntry} */
      const entry = {
        root, correction: built.correction, own: built.own, hull, asset, ship, request: 0, fallback: null, counted: true,
      };
      root.onDisposeObservable.addOnce(() => forget(state, entry));
      state.triangles += asset.record.triangles;
      state.ships.set(String(ship.id), entry);
      return entry;
    } catch (error) {
      unbuilt(hull, error, built, root);
      return null;
    }
  }

  // Takes a ship's hull off the scene's books, once: when its root goes, or for a root that could
  // not. The books first; a template of its own that cannot go with its ship is logged.
  /** @param {SceneState} state @param {ShipEntry} entry */
  function forget(state, entry) {
    if (!entry.counted) return;
    entry.counted = false;
    state.triangles = Math.max(0, state.triangles - entry.asset.record.triangles);
    if (state.ships.get(String(entry.ship.id)) === entry) state.ships.delete(String(entry.ship.id));
    if (entry.own) discardTemplate('Hull ' + entry.hull.id, entry.own);
  }

  // A hull built that its ship could not take: logged as one that could not be built, and let go.
  function unbuilt(hull, error, built, root) {
    logFailure('Hull ' + hull.id + ' could not be built', error, 'the ship keeps the hull or dart it has.');
    discard('Unbuilt hull ' + hull.id, built.correction, built.own);
    if (root) guarded('Unbuilt hull ' + hull.id, [["'s root could not be disposed", () => root.dispose()]]);
  }

  /**
   * Builds a hull in place of the entry's own, under the same root, on the template and in the
   * state focus mode's fade gives the ship, so a promotion lands as the hull it replaces showed.
   * The new hull takes the root and the triangle count before the old one is let go, and nothing
   * after that is thrown: the ship has either the hull it had (false) or the new one (true).
   * @param {ShipEntry} entry @param {HullEntry} hull @param {HullAsset} asset
   */
  function swapHull(scene, state, entry, hull, asset, ship) {
    const built = buildHull(scene, state, hull, asset, ship);
    if (!built) return false;
    try {
      built.correction.parent = entry.root;
    } catch (error) {
      unbuilt(hull, error, built, null);
      return false;
    }
    const old = { hull: entry.hull, correction: entry.correction, own: entry.own };
    state.triangles += asset.record.triangles - entry.asset.record.triangles;
    Object.assign(entry, { correction: built.correction, own: built.own, hull, asset, ship });
    discard('Replaced hull ' + old.hull.id, old.correction, old.own);
    // The ship flies the new hull by now: what cannot be written of it is logged, not thrown.
    const { root, fallback } = entry;
    guarded('Hull ' + hull.id, [
      [' could not show its provider evidence', () => { root.material = built.evidence; }],
      [' could not be named on its root', () => {
        root.metadata = { ...(root.metadata || {}), ...hullMetadata(hull, asset, ship) };
      }],
      [' could not be named on its dart', () => {
        if (fallback && fallback.metadata) fallback.metadata = { ...fallback.metadata, upgradedHullId: hull.id };
      }],
    ]);
    return true;
  }

  /** @type {ShipAssetsHulls} */
  const hulls = { lookOf, createShipEntry, swapHull, forget };
  Object.assign(core, hulls);
})();

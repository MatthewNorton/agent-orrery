// @ts-check
// ship-assets-hulls.js — builds a ship's hull from a loaded model: provider livery materials,
// instances of a per-provider template on the universe map or clones in the system and planet
// views, and in-place swaps on promotion.
'use strict';

/**
 * @import { HullAsset, HullEntry, SceneState, ShipAssetsCore, ShipEntry } from './ship-assets.js'
 * @typedef {object} ShipAssetsHulls added to AUR.shipAssets by ship-assets-hulls.js
 * @property {(hull: HullEntry, ship: any) => string} lookOf
 * @property {(scene: any, state: SceneState, hull: HullEntry, asset: HullAsset, ship: any) => ShipEntry | null} createShipEntry
 * @property {(scene: any, state: SceneState, entry: ShipEntry, hull: HullEntry, asset: HullAsset, ship: any) => boolean} swapHull
 */

(function () {
  const AUR = window.AUR;
  /** @type {ShipAssetsCore} */
  const core = AUR.shipAssets;
  const { logOnce, viewLod } = core;
  // The universe map has no lights, so far hulls carry a faint tint of their
  // own; without it they read as black cut-outs behind their accent lights.
  const FAR_SELF_LIGHT = 0.1;

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

  /** A ship's color identity: its provider, or 'local' when it runs a local model. */
  function paletteKey(ship) {
    return ship && ship.local === true ? 'local' : AUR.providerKey(ship && ship.provider);
  }

  /** What refresh() compares: the rank's hull and the colors it wears. */
  function lookOf(hull, ship) {
    return hull.id + '|' + paletteKey(ship);
  }

  // Livery: graphite hull and armor, the structure parts in the ship color, and
  // accents emitting exactly the ship color (the scenes' provider evidence).
  function fleetMaterial(scene, state, file, selfLight, ship, baseMaterial) {
    const palette = paletteKey(ship);
    const sourceName = String(baseMaterial && baseMaterial.name || 'material');
    const key = file + ':' + palette + ':' + sourceName;
    let material = state.materials.get(key);
    if (material) return material;
    const id = 'ship_fleet_' + file + '_' + palette + '_' + sourceName;
    material = baseMaterial && typeof baseMaterial.clone === 'function'
      ? baseMaterial.clone(id)
      : new BABYLON.StandardMaterial(id, scene);
    const tint = AUR.color3(AUR.shipColor(ship));
    const name = sourceName.toLowerCase();
    let surface = paletteTone(tint, 0.10, 0.06);
    let emissive = null;

    if (/armor_secondary|hull_textured/.test(name)) surface = paletteTone(tint, 0.14, 0.07);
    if (/structure|ivory/.test(name)) {
      surface = paletteTone(tint, 0.85, 0.0);
      emissive = tint.scale(0.12);
    }
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
    const key = asset.file + '|' + paletteKey(ship);
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
      providerTint: AUR.shipColor(ship),
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
      look: lookOf(hull, ship), wanted: lookOf(hull, ship), fallback: null,
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
    entry.look = lookOf(hull, ship);
    entry.root.material = built.evidence;
    entry.root.metadata = { ...(entry.root.metadata || {}), ...hullMetadata(hull, asset, ship) };
    if (entry.fallback && entry.fallback.metadata) {
      entry.fallback.metadata = { ...entry.fallback.metadata, upgradedHullId: hull.id };
    }
    return true;
  }

  /** @type {ShipAssetsHulls} */
  const hulls = { lookOf, createShipEntry, swapHull };
  Object.assign(core, hulls);
})();

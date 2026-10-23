// @ts-check
// Builds a ship's hull from a loaded model: provider livery materials,
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
  const ENV_SIZE = 64;
  const SUN_LENGTH = Math.hypot(0.45, 0.72, 0.5);
  const SUN = [0.45 / SUN_LENGTH, 0.72 / SUN_LENGTH, -0.5 / SUN_LENGTH]; // the warm spot's direction
  // A cube face texel (u, v) to its direction, in Babylon's face order (+x, -x, +y, -y, +z, -z).
  const FACE_DIRECTION = [
    (u, v) => [1, -v, -u], (u, v) => [-1, -v, u], (u, v) => [u, 1, v],
    (u, v) => [u, -1, -v], (u, v) => [u, -v, 1], (u, v) => [-u, -v, -1],
  ];
  let studioFaces = null; // the six float faces, computed once for the app
  const environments = new WeakMap();

  // A procedural studio sky for the hulls' reflections: cool light from above, a warm sun spot, dark
  // below. Built from arrays (no asset, no network); each scene prefilters its own copy for roughness.
  function studioFace(face) {
    const data = new Float32Array(ENV_SIZE * ENV_SIZE * 4);
    const direction = FACE_DIRECTION[face];
    for (let j = 0; j < ENV_SIZE; j++) {
      for (let i = 0; i < ENV_SIZE; i++) {
        const d = direction((i + 0.5) / ENV_SIZE * 2 - 1, (j + 0.5) / ENV_SIZE * 2 - 1);
        const len = Math.hypot(d[0], d[1], d[2]);
        const up = d[1] / len;
        const sky = AUR.clamp((up + 0.1) / 0.7, 0, 1);
        const ground = AUR.clamp((-up - 0.05) / 0.5, 0, 1);
        let r = 0.40 + 0.28 * sky - 0.33 * ground;
        let g = 0.39 + 0.32 * sky - 0.33 * ground;
        let b = 0.38 + 0.44 * sky - 0.32 * ground;
        const spot = Math.pow(Math.max(0, (d[0] * SUN[0] + d[1] * SUN[1] + d[2] * SUN[2]) / len), 36);
        r += spot * 2.4; g += spot * 2.0; b += spot * 1.5;
        const o = (j * ENV_SIZE + i) * 4;
        data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 1;
      }
    }
    return data;
  }

  function shipEnvironment(scene) {
    let texture = environments.get(scene);
    if (texture) return texture;
    studioFaces = studioFaces || FACE_DIRECTION.map((_, face) => studioFace(face));
    texture = new BABYLON.RawCubeTexture(scene, studioFaces, ENV_SIZE,
      BABYLON.Constants.TEXTUREFORMAT_RGBA, BABYLON.Constants.TEXTURETYPE_FLOAT, true, false,
      BABYLON.Constants.TEXTURE_TRILINEAR_SAMPLINGMODE);
    texture.name = 'ship-studio-env';
    texture.gammaSpace = false;
    environments.set(scene, texture);
    const unfiltered = () => logOnce('env:prefilter', 'Ship environment left unfiltered.');
    try {
      const filtering = new BABYLON.HDRFiltering(scene.getEngine(), { quality: BABYLON.Constants.TEXTURE_FILTERING_QUALITY_LOW });
      const done = filtering.prefilter(texture);
      if (done && typeof done.catch === 'function') done.catch(unfiltered);
    } catch (error) {
      unfiltered();
    }
    return texture;
  }

  // What every fleet material gets in Babylon: the studio reflections, its normal map boosted
  // (1.6x, so baked seams read at hero distance), and specular anti-aliasing against edge sparkle.
  function finishFleetMaterial(scene, material, intensity) {
    if (typeof material.environmentIntensity !== 'number') return;
    material.reflectionTexture = shipEnvironment(scene);
    material.environmentIntensity = intensity;
    material.enableSpecularAntiAliasing = true;
    if (material.bumpTexture) material.bumpTexture.level = 1.6;
  }

  // ---------- materials ----------

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

  // Every material name Blender gives a fleet hull falls into one role; the legacy vocabulary of
  // the shared fleet maps onto the same roles. The livery roles alone wear the provider color.
  /** @type {Array<[string, RegExp]>} */
  const ROLE_PATTERNS = [
    ['window', /window/], ['glow', /engine|glow/], ['accent', /accent|energy|metalred|orange/],
    ['glass', /canopy|glass/], ['structure', /structure|ivory/], ['mechanical', /mechanical|gunmetal/],
    ['recess', /recess/], ['solar', /solar/], ['armor', /armor_secondary|hull_textured/],
  ];
  const LIVERY_ROLES = new Set(['accent', 'glow']);
  function materialRole(name) {
    const lower = String(name || '').toLowerCase();
    const match = ROLE_PATTERNS.find(([, pattern]) => pattern.test(lower));
    return match ? match[0] : 'hull';
  }

  // The surface and emission a role wears for a ship tint (null emission: unlit).
  function roleLook(role, tint) {
    switch (role) {
      case 'accent': return [paletteTone(tint, 0.76, 0.10), tint.clone()];
      // A nozzle is all glow: a dark surface so the lights add no white, the tint as its emission.
      case 'glow': return [paletteTone(tint, 0.25, 0.0), tint.clone()];
      // Lit windows glow the same cool white on every provider; the livery carries the color.
      case 'window': return [new BABYLON.Color3(0.05, 0.06, 0.08), new BABYLON.Color3(0.62, 0.8, 1.0)];
      case 'glass': return [paletteTone(tint, 0.16, 0.015), tint.scale(0.07)];
      case 'structure': return [paletteTone(tint, 0.85, 0.0), tint.scale(0.12)];
      case 'mechanical': return [paletteTone(tint, 0.06, 0.045), null];
      case 'recess': return [paletteTone(tint, 0.03, 0.02), null];
      case 'solar': return [paletteTone(tint, 0.12, 0.03), null];
      case 'armor': return [paletteTone(tint, 0.14, 0.07), null];
      default: return [paletteTone(tint, 0.10, 0.06), null];
    }
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

  // Livery: an authored hull map keeps its own colors; every other material wears its role's look
  // in the ship color, the livery roles emitting exactly it (the scenes' provider evidence).
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
    const role = materialRole(sourceName);
    const authored = material.albedoTexture || material.diffuseTexture;
    if (authored && !LIVERY_ROLES.has(role)) {
      // On the lightless map the hull map lights itself.
      material.emissiveTexture = selfLight ? authored : null;
      material.emissiveColor = selfLight ? new BABYLON.Color3(0.6, 0.6, 0.6) : new BABYLON.Color3(0, 0, 0);
      finishFleetMaterial(scene, material, selfLight ? 0.6 : 1.3);
    } else {
      const [surface, emissive] = roleLook(role, AUR.color3(AUR.shipColor(ship)));
      if (material.albedoColor) material.albedoColor = surface;
      if (material.diffuseColor) material.diffuseColor = surface;
      material.emissiveColor = emissive || (selfLight ? surface.scale(FAR_SELF_LIGHT) : new BABYLON.Color3(0, 0, 0));
      if (LIVERY_ROLES.has(role)) {
        if (typeof material.metallic === 'number') material.metallic = 0.42;
        if (typeof material.roughness === 'number') material.roughness = 0.22;
      }
      finishFleetMaterial(scene, material, selfLight ? 0.5 : 1.0);
    }
    state.materials.set(key, material);
    return material;
  }

  // ---------- building a hull ----------

  /** One tinted, hidden copy of a hull per provider; universe ships (lightless, self-lit) draw as its instances. */
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
      mesh.material = fleetMaterial(scene, state, asset.file, true, ship, mesh.material);
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

  function placeClones(scene, state, asset, ship, pivot, selfLight) {
    const entries = asset.record.container.instantiateModelsToScene(
      (sourceName) => 'ship_' + String(ship.id) + '_' + sourceName,
      false,
      { doNotInstantiate: true }
    );
    for (const node of entries.rootNodes) node.parent = pivot;
    const meshes = childMeshes(entries.rootNodes);
    for (const mesh of meshes) {
      mesh.material = fleetMaterial(scene, state, asset.file, selfLight, ship, mesh.material);
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
        : placeClones(scene, state, asset, ship, pivot, asset.lod === 'far'); // a stepped-down far file lights itself
    } catch (error) {
      correction.dispose();
      logOnce('instance:' + hull.id, 'Hull ' + hull.id + ' could not be instantiated; using procedural hulls.');
      return null;
    }
    let evidence = null;
    for (const mesh of meshes) {
      mesh.isPickable = false;
      mesh.layerMask |= AUR.SHIP_LAYER;
      if (!evidence || LIVERY_ROLES.has(materialRole(mesh.material && mesh.material.name))) evidence = mesh.material;
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

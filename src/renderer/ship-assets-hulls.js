// @ts-check
// Builds a ship's hull from a loaded model: provider livery materials, instances of a template
// per hull file and palette in every view, and in-place swaps on promotion, each built as focus
// mode's fade shows the ship.
'use strict';

/**
 * @import { HullAsset, HullEntry, HullTemplate, SceneState, ShipAssetsCore, ShipEntry } from './ship-assets.js'
 * @typedef {object} ShipAssetsHulls added to AUR.shipAssets by ship-assets-hulls.js
 * @property {(hull: HullEntry, ship: any) => string} lookOf
 * @property {(scene: any, state: SceneState, hull: HullEntry, asset: HullAsset, ship: any) => ShipEntry | null} createShipEntry
 * @property {(scene: any, state: SceneState, entry: ShipEntry, hull: HullEntry, asset: HullAsset, ship: any) => boolean} swapHull
 */

(function () {
  const AUR = window.AUR;
  /** @type {ShipAssetsCore} */
  const core = AUR.shipAssets;
  const { logFailure, viewLod, apartVisibility, ownVisibility } = core;
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
    const unfiltered = (error) => logFailure('Ship environment could not be prefiltered', error, 'it is used unfiltered.');
    try {
      const filtering = new BABYLON.HDRFiltering(scene.getEngine(), { quality: BABYLON.Constants.TEXTURE_FILTERING_QUALITY_LOW });
      const done = filtering.prefilter(texture);
      if (done && typeof done.catch === 'function') done.catch(unfiltered);
    } catch (error) {
      unfiltered(error);
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
    AUR.fadeWithMesh(material);
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
  // the shared fleet maps onto the same roles. The livery roles (the stripes and the nozzles) are
  // the ship's trim lights.
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

  // The surface and emission (null: unlit) a role outside the livery wears for a ship tint, sRGB
  // like every AUR color.
  function roleLook(role, tint) {
    switch (role) {
      // Lit windows: the same cool pane on every provider, lit, not blown out.
      case 'window': return [new BABYLON.Color3(0.25, 0.33, 0.42), new BABYLON.Color3(0.26, 0.4, 0.6)];
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

  // A hull file's material in a palette's livery, copied once per scene and kept once dressed.
  function fleetMaterial(scene, state, file, selfLight, ship, baseMaterial) {
    const palette = paletteKey(ship);
    const sourceName = String(baseMaterial && baseMaterial.name || 'material');
    const key = file + ':' + palette + ':' + sourceName;
    let material = state.materials.get(key);
    if (material) return material;
    const id = 'ship_fleet_' + file + '_' + palette + '_' + sourceName;
    material = AUR.dressed(
      baseMaterial && typeof baseMaterial.clone === 'function' ? baseMaterial.clone(id) : new BABYLON.StandardMaterial(id, scene),
      (copy) => dressFleetMaterial(scene, copy, materialRole(sourceName), selfLight, ship));
    state.materials.set(key, material);
    return material;
  }

  // Livery: an authored hull map keeps its own colors; the glass keeps its authored smoke; every
  // other material wears its role's look in the ship color, the livery roles as its trim lights.
  function dressFleetMaterial(scene, material, role, selfLight, ship) {
    const authored = material.albedoTexture || material.diffuseTexture;
    if (role === 'glass') {
      material.emissiveColor = new BABYLON.Color3(0, 0, 0);
      finishFleetMaterial(scene, material, 1.8); // smoked glass is its reflections
    } else if (authored && !LIVERY_ROLES.has(role)) {
      // On the lightless map the hull map lights itself.
      material.emissiveTexture = selfLight ? authored : null;
      material.emissiveColor = selfLight ? new BABYLON.Color3(0.6, 0.6, 0.6) : new BABYLON.Color3(0, 0, 0);
      finishFleetMaterial(scene, material, selfLight ? 0.6 : 1.3);
    } else if (LIVERY_ROLES.has(role)) {
      AUR.shipModels.trimLight(material, AUR.color3(AUR.shipColor(ship)));
      finishFleetMaterial(scene, material, selfLight ? 0.5 : 1.0);
    } else {
      const [surface, emissive] = roleLook(role, AUR.color3(AUR.shipColor(ship)));
      if (material.albedoColor) material.albedoColor = surface.toLinearSpace();
      if (material.diffuseColor) material.diffuseColor = surface;
      material.emissiveColor = emissive || (selfLight ? surface.scale(FAR_SELF_LIGHT) : new BABYLON.Color3(0, 0, 0));
      finishFleetMaterial(scene, material, selfLight ? 0.5 : 1.0);
    }
    material.metadata = { ...(material.metadata || {}), role }; // what the exhaust part asks
  }

  // What one mesh of a hull wears: a model keeps its own finishes and takes the ship color on its
  // trim (ships/models.js); a manifest hull gets its livery here.
  /** @param {HullAsset} asset */
  function hullMaterial(scene, state, asset, selfLight, ship, baseMaterial) {
    return asset.model
      ? AUR.shipModels.material(state.materials, asset.model, paletteKey(ship), AUR.shipColor(ship), baseMaterial)
      : fleetMaterial(scene, state, asset.file, selfLight, ship, baseMaterial);
  }

  // What the root wears as provider evidence (the scenes read its emission as the exact hex): an
  // unlit material in the ship color, one per palette.
  function evidenceMaterial(scene, state, ship) {
    const key = 'evidence:' + paletteKey(ship);
    return AUR.memo(state.materials, key, () => AUR.unlitMaterial(scene, 'ship_' + key, AUR.color3(AUR.shipColor(ship))));
  }

  // ---------- building a hull ----------

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
      disposeTemplate({ roots }); // the parts not reached yet would draw, in the file's materials
      throw error;
    }
  }

  // The template a ship's hull is built on: its look's, one per hull file and palette at the
  // fleet's visibility, or one of its own while focus mode shows it apart (`own`).
  function templateFor(scene, state, asset, ship, own) {
    const key = asset.file + '|' + paletteKey(ship);
    if (own !== null) return makeTemplate(scene, state, asset, ship, 'ship_template_' + key + '|' + ship.id, own);
    return AUR.memo(state.templates, key, () => makeTemplate(scene, state, asset, ship, 'ship_template_' + key, state.visibility));
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
      logFailure('Hull ' + hull.id + ' could not be built', error, 'the ship keeps the hull or dart it has.');
      const made = template && own !== null ? template : null; // the fleet's template stays
      discard('Unbuilt hull ' + hull.id, correction, made);
      return null;
    }
  }

  // Lets go of a hull no ship holds: drawn by nothing before it is disposed, and what cannot be
  // disposed is logged, not thrown, so the rest still goes and the caller's outcome stands.
  /** @param {string} name @param {BABYLON.TransformNode} correction @param {HullTemplate | null} own */
  function discard(name, correction, own) {
    const steps = [() => correction.setEnabled(false), () => correction.dispose(false, false), () => own && disposeTemplate(own)];
    for (const step of steps) {
      try {
        step();
      } catch (error) {
        logFailure(name + ' could not be disposed', error, 'it is hidden.');
      }
    }
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
    const entry = { root, correction: built.correction, own: built.own, hull, asset, ship, request: 0, fallback: null };
    const shipId = String(ship.id);
    state.triangles += asset.record.triangles;
    state.ships.set(shipId, entry);
    root.onDisposeObservable.addOnce(() => {
      state.triangles = Math.max(0, state.triangles - entry.asset.record.triangles);
      if (entry.own) disposeTemplate(entry.own); // a template of its own leaves with its ship
      if (state.ships.get(shipId) === entry) state.ships.delete(shipId);
    });
    return entry;
  }

  /**
   * Builds a hull in place of the entry's own, under the same root, on the template and in the
   * state focus mode's fade gives the ship, so a promotion lands as the hull it replaces showed.
   * The new hull takes the root and the triangle count before the old one is let go, off its
   * ship, so a dispose that throws leaves the ship the one hull that replaced it.
   * @param {ShipEntry} entry @param {HullEntry} hull @param {HullAsset} asset
   */
  function swapHull(scene, state, entry, hull, asset, ship) {
    const built = buildHull(scene, state, hull, asset, ship);
    if (!built) return false;
    const old = { hull: entry.hull, correction: entry.correction, own: entry.own };
    built.correction.parent = entry.root;
    state.triangles += asset.record.triangles - entry.asset.record.triangles;
    Object.assign(entry, { correction: built.correction, own: built.own, hull, asset, ship });
    old.correction.parent = null;
    discard('Replaced hull ' + old.hull.id, old.correction, old.own);
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

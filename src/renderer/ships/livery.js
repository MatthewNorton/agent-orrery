// @ts-check
// What a ship's hull wears: the studio sky its reflections show, a hull file's materials in the
// livery of a palette, and the root's provider evidence. ship-assets-hulls.js builds hulls in them.
'use strict';

/**
 * @import { HullAsset, SceneState, ShipAssetsCore } from '../ship-assets.js'
 * @typedef {object} ShipAssetsLivery added to AUR.shipAssets by ships/livery.js
 * @property {(ship: any) => string} paletteKey
 * @property {(scene: any, state: SceneState, asset: HullAsset, selfLight: boolean, ship: any,
 *   baseMaterial: any) => any} hullMaterial
 * @property {(scene: any, state: SceneState, ship: any) => any} evidenceMaterial
 */

(function () {
  const AUR = window.AUR;
  /** @type {ShipAssetsCore} */
  const core = AUR.shipAssets;
  const { logFailure } = core;
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

  /** @type {ShipAssetsLivery} */
  const livery = { paletteKey, hullMaterial, evidenceMaterial };
  Object.assign(core, livery);
})();

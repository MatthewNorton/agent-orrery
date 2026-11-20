// @ts-check
// Ship models built in code. A model flies the rank of one manifest hull: ship-assets.js asks here
// for the hull to fly and for its container (the ship built once per scene, as one mesh that every
// ship of the model instances), ships/livery.js for what a ship's hull wears, the
// views for the lights and the nozzles. A model keeps the finishes it was authored with, so it
// brings its own reflections, tone curve and lights, and no other light of the view reaches it.
'use strict';

/**
 * @import { HullEntry } from '../ship-assets.js'
 * @typedef {object} ShipModel one ship, built by its converted modules under ships/<id>/source/
 * @property {string} id also the id of the hull it flies as
 * @property {string} replaces the manifest hull whose rank it takes
 * @property {{ scale: number, offset: number[] }} correction to the fleet's frame: one unit long,
 *   centred, nose on +Z (the offset is in the model's own units)
 * @property {(scene: BABYLON.Scene) => BABYLON.TransformNode} build one ship with its materials
 * @property {(scene: BABYLON.Scene) => BABYLON.BaseTexture} probe the reflections its finishes were tuned under
 * @property {Record<string, number | { lamps: string }>} trim by material name: a surface that
 *   becomes a trim light in the ship color (the number is how hot it emits;
 *   AUR.shipModels.TRIM_LIGHT is a light, less is a lit panel), or one whose emissive map (its
 *   lamps, painted in the one color named) shows that color instead
 * @property {() => Array<{ position: number[], radius: number }>} nozzles in the model's own units
 */

(function () {
  const AUR = window.AUR;
  // Outside the cameras' default mask like AUR.SHIP_LAYER, and apart from it: the model lights
  // reach only meshes with this bit and every other light skips them (the fleet's key and rim
  // reach only AUR.SHIP_LAYER).
  const LAYER = 0x20000000;
  // The inspection lights the models' finishes were tuned under.
  const LIGHTS = [
    { name: 'model-sun', direction: [0.55, -0.95, -0.74], hex: '#fff1e3', intensity: 2.55, radius: 0.065 },
    { name: 'model-rim', direction: [-0.82, -0.23, 0.75], hex: '#ecdbce', intensity: 0.82, radius: 0.13 },
    { name: 'model-fill', direction: [-0.13, 0.94, -0.31], hex: '#f1e6dc', intensity: 1.78, radius: 0.27 },
  ];
  const EXPOSURE = 1.02;
  // Trim lights emit hotter than the key light leaves the hull, so a line reads as a light, not
  // paint: its core runs toward white and the glow pass blooms the ship color around it.
  const TRIM_LIGHT = 1.5;
  const TEXTURE_SLOTS = ['albedoTexture', 'bumpTexture', 'metallicTexture', 'emissiveTexture', 'reflectionTexture'];
  // The scene lists a build adds to.
  const BUILT = ['meshes', 'transformNodes', 'materials', 'multiMaterials', 'textures'];

  /** @type {Map<string, ShipModel>} */
  const models = new Map();
  /** @type {Map<string, HullEntry>} */
  const hulls = new Map(); // replaced hull id -> the hull entry the model flies as

  /** @param {ShipModel} model */
  function register(model) {
    models.set(model.id, model);
  }

  /**
   * The hull to fly for a manifest hull: the model that replaces it, in its rank, else itself.
   * @param {HullEntry} hull @returns {HullEntry}
   */
  function inPlaceOf(hull) {
    const model = [...models.values()].find((candidate) => candidate.replaces === hull.id);
    if (!model) return hull;
    // The file names no file: it keys the model's container, templates and materials in a scene.
    return AUR.memo(hulls, hull.id, () => ({
      id: model.id, file: 'model:' + model.id, family: hull.family, role: hull.role,
      minBuilds: hull.minBuilds, correction: model.correction, model,
    }));
  }

  /**
   * One built ship, dressed, held out of the scene as one mesh with a sub-mesh per finish. It owns
   * the materials and textures it was built with, so disposing it releases them as a file's
   * container does; they stay in the scene, which marks its materials dirty when it changes.
   */
  function container(scene, model) {
    const counts = Object.fromEntries(BUILT.map((list) => [list, scene[list].length]));
    // What the build added to a scene list, less the BRDF lookup texture a scene's first PBR
    // material makes: that is the scene's, and every later PBR material uses it.
    const made = (list) => scene[list].slice(counts[list]).filter((item) => item !== scene.environmentBRDFTexture);
    let held;
    try {
      held = dressed(scene, model);
    } catch (error) {
      // A build that fails part-way leaves nothing of itself in the scene.
      for (const list of BUILT) for (const item of made(list)) item.dispose();
      throw error;
    }
    held.materials.push(...made('materials'));
    held.multiMaterials.push(...made('multiMaterials'));
    held.textures.push(...made('textures'));
    return held;
  }

  function dressed(scene, model) {
    const root = model.build(scene);
    const probe = model.probe(scene);
    // The model's own tone curve, on its materials only: the scene keeps its own.
    const image = new BABYLON.ImageProcessingConfiguration();
    image.toneMappingEnabled = true;
    image.toneMappingType = BABYLON.ImageProcessingConfiguration.TONEMAPPING_ACES;
    image.exposure = EXPOSURE;
    const parts = /** @type {BABYLON.Mesh[]} */ (root.getChildMeshes(false));
    for (const material of new Set(parts.map((part) => /** @type {BABYLON.PBRMaterial} */ (part.material)))) {
      if (!material) continue;
      material.reflectionTexture = probe;
      material.imageProcessingConfiguration = image;
      AUR.fadeWithMesh(material);
    }
    // Every mesh of a hull is placed and culled once per ship, so the thirty-odd parts become one
    // mesh, grouped by finish: one draw per finish for all the ships of a template.
    const hull = BABYLON.Mesh.MergeMeshes(parts, true, true, undefined, false, true);
    root.dispose();
    hull.name = model.id;
    hull.material.name = model.id + ' finishes';
    const held = new BABYLON.AssetContainer(scene);
    held.meshes.push(hull);
    held.removeAllFromScene();
    return held;
  }

  // Material.clone() would clone each texture too (and give a painted one a blank canvas): a copy
  // shares the model's. The model's finish gets its maps back whether or not the clone is made,
  // and a copy that cannot take them is not left in the scene.
  /** @param {BABYLON.PBRMaterial} material @param {string} name */
  function copyMaterial(material, name) {
    const scene = material.getScene();
    const count = scene.materials.length;
    const textures = TEXTURE_SLOTS.map((slot) => material[slot]);
    let copy;
    try {
      for (const slot of TEXTURE_SLOTS) material[slot] = null;
      copy = material.clone(name);
    } catch (error) {
      // A clone that failed once made: its copy is not left in the scene.
      for (const partial of scene.materials.slice(count)) AUR.disposeLogged(partial, 'A failed copy of ' + material.name);
      throw error;
    } finally {
      TEXTURE_SLOTS.forEach((slot, i) => { material[slot] = textures[i]; });
    }
    return AUR.dressed(copy, (made) => {
      TEXTURE_SLOTS.forEach((slot, i) => { made[slot] = textures[i]; });
      made.imageProcessingConfiguration = material.imageProcessingConfiguration;
    });
  }

  /**
   * A trim light in the ship color: a dark surface, so the light adds no white, and the color as
   * the emission (the PBR emissive slot is linear: linearized, the frame shows the exact hex).
   * @param {BABYLON.PBRMaterial | BABYLON.StandardMaterial} material standard when a hull file's own could not be cloned
   * @param {BABYLON.Color3} tint
   */
  function trimLight(material, tint, intensity = TRIM_LIGHT) {
    const surface = tint.scale(0.25);
    if ('albedoColor' in material) {
      material.albedoColor = surface.toLinearSpace();
      material.emissiveIntensity = intensity;
    } else {
      material.diffuseColor = surface;
    }
    material.emissiveColor = tint.toLinearSpace();
  }

  /**
   * What a ship's hull wears: the model's own finishes, except its trim, which is copied once per
   * palette into `materials` (the scene's hull materials, released with them).
   * @param {Map<string, any>} materials @param {ShipModel} model @param {string} palette
   * @param {string} hex the ship color
   * @param {BABYLON.PBRMaterial | BABYLON.MultiMaterial} base the hull's material, or one of its finishes
   * @returns {BABYLON.PBRMaterial | BABYLON.MultiMaterial}
   */
  function material(materials, model, palette, hex, base) {
    const whole = base instanceof BABYLON.MultiMaterial;
    const role = model.trim[base.name];
    if (!role && !whole) return base;
    return AUR.memo(materials, model.id + ':' + palette + ':' + base.name, () => {
      if (base instanceof BABYLON.MultiMaterial) {
        return AUR.dressed(new BABYLON.MultiMaterial(base.name + ' ' + palette, base.getScene()), (worn) => {
          worn.subMaterials = base.subMaterials.map((finish) =>
            material(materials, model, palette, hex, /** @type {BABYLON.PBRMaterial} */ (finish)));
        });
      }
      return AUR.dressed(copyMaterial(base, base.name + ' ' + palette), (copy) => {
        /** @type {BABYLON.Color3} */
        const tint = AUR.color3(hex);
        if (typeof role !== 'number') {
          // The map times the emissive color is what shows: with the painted color divided out,
          // that is the ship color, at the level the model lights its lamps to. (The glow pass
          // reads the map without linearizing it, so a lamp's halo is a paler tint; on Petrel's
          // hairline lamps no halo shows, even with the chase camera at its closest.)
          const painted = AUR.color3(role.lamps).toLinearSpace();
          const shown = tint.toLinearSpace();
          copy.emissiveColor = base.emissiveColor.multiply(new BABYLON.Color3(
            shown.r / Math.max(painted.r, 0.01), shown.g / Math.max(painted.g, 0.01), shown.b / Math.max(painted.b, 0.01)));
          return;
        }
        copy.albedoTexture = null;
        copy.emissiveTexture = null;
        trimLight(copy, tint, role);
      });
    });
  }

  /**
   * The model lights of a view that lights its ships; they stay where the finishes expect them.
   * They are all that lights a model hull: a material draws four lights at most, so the view's
   * own lights, the ones it has and the ones it adds later, are kept off it.
   */
  function lights(scene) {
    const own = new Set();
    const keepOff = (light) => { if (!own.has(light)) light.excludeWithLayerMask |= LAYER; };
    for (const { name, direction, hex, intensity, radius } of LIGHTS) {
      const light = new BABYLON.DirectionalLight(name, BABYLON.Vector3.FromArray(direction), scene);
      light.radius = radius;
      own.add(AUR.layerLight(light, intensity, AUR.color3(hex).toLinearSpace(), LAYER));
    }
    scene.lights.forEach(keepOff);
    scene.onNewLightAddedObservable.add(keepOff);
  }

  /**
   * A model hull's stern nozzles in the ship root's frame (the root carries the display scale),
   * or null when the hull is not a model.
   * @param {string} hullId
   */
  function nozzles(hullId) {
    const model = models.get(hullId);
    if (!model) return null;
    const { scale, offset } = model.correction;
    const shift = BABYLON.Vector3.FromArray(offset);
    return model.nozzles().map(({ position, radius }) => ({
      position: BABYLON.Vector3.FromArray(position).addInPlace(shift).scaleInPlace(scale),
      radius: radius * scale,
    }));
  }

  AUR.shipModels = { LAYER, TRIM_LIGHT, register, inPlaceOf, container, material, trimLight, lights, nozzles };
})();

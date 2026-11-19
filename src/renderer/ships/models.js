// @ts-check
// Ship models built in code. A model flies the rank of one manifest hull: ship-assets.js asks here
// for the hull to fly and for its container (the ship built once per scene, as one mesh that every
// ship of the model copies or instances), ship-assets-hulls.js for what a ship's hull wears, the
// views for the lights and the nozzles. A model keeps the finishes it was authored with, so it
// brings its own reflections, tone curve and lights, and no other light of the view reaches it.
'use strict';

/**
 * @typedef {object} ShipModel one ship, built by its converted modules under ships/<id>/source/
 * @property {string} id also the id of the hull it flies as
 * @property {string} replaces the manifest hull whose rank it takes
 * @property {{ scale: number, offset: number[] }} correction to the fleet's frame: one unit long,
 *   centred, nose on +Z (the offset is in the model's own units)
 * @property {(scene: BABYLON.Scene) => BABYLON.TransformNode} build one ship with its materials
 * @property {(scene: BABYLON.Scene) => BABYLON.BaseTexture} probe the reflections its finishes were tuned under
 * @property {Record<string, number | 'lamps'>} trim by material name: a surface that becomes a
 *   trim light in the ship color (the number is how hot it emits; AUR.shipModels.TRIM_LIGHT is a
 *   light, less is a lit panel), or one whose emissive map (its lamps) takes that color
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
  /** @type {Map<string, any>} */
  const hulls = new Map(); // replaced hull id -> the hull entry the model flies as

  /** @param {ShipModel} model */
  function register(model) {
    models.set(model.id, model);
  }

  /** The hull to fly for a manifest hull: the model that replaces it, in its rank, else itself. */
  function inPlaceOf(hull) {
    const model = [...models.values()].find((candidate) => candidate.replaces === hull.id);
    if (!model) return hull;
    // The file names no file: it keys the model's container, templates and materials in a scene.
    return AUR.memo(hulls, hull.id, () => ({
      id: model.id, file: 'model:' + model.id, family: hull.family, role: hull.role,
      minBuilds: hull.minBuilds, correction: model.correction, model,
    }));
  }

  /** One built ship, dressed, held out of the scene as one mesh with a sub-mesh per finish. */
  function container(scene, model) {
    const before = BUILT.map((list) => scene[list].length);
    try {
      return dressed(scene, model);
    } catch (error) {
      // A build that fails part-way leaves nothing of itself in the scene.
      BUILT.forEach((list, i) => { for (const made of scene[list].slice(before[i])) made.dispose(); });
      throw error;
    }
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
    for (const material of new Set(parts.map((part) => /** @type {any} */ (part.material)))) {
      if (!material) continue;
      material.reflectionTexture = probe;
      material.imageProcessingConfiguration = image;
      AUR.fadeWithMesh(material);
    }
    // A hull's cost is its mesh count: thirty-odd parts per ship more than doubled a crowded
    // system's frame time, so the parts become one mesh, grouped by finish.
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
  // shares the model's.
  function copyMaterial(material, name) {
    const textures = TEXTURE_SLOTS.map((slot) => material[slot]);
    for (const slot of TEXTURE_SLOTS) material[slot] = null;
    const copy = material.clone(name);
    TEXTURE_SLOTS.forEach((slot, i) => { material[slot] = copy[slot] = textures[i]; });
    copy.imageProcessingConfiguration = material.imageProcessingConfiguration;
    return copy;
  }

  /**
   * A trim light in the ship color: a dark surface, so the light adds no white, and the color as
   * the emission (the PBR emissive slot is linear: linearized, the frame shows the exact hex).
   */
  function trimLight(material, tint, intensity = TRIM_LIGHT) {
    const surface = tint.scale(0.25);
    if (material.albedoColor) material.albedoColor = surface.toLinearSpace();
    if (material.diffuseColor) material.diffuseColor = surface;
    material.emissiveColor = tint.toLinearSpace();
    material.emissiveIntensity = intensity;
  }

  /**
   * What a ship's hull wears: the model's own finishes, except its trim, which is copied once per
   * palette into `materials` (the scene's hull materials, released with them).
   * @param {Map<string, any>} materials @param {ShipModel} model @param {string} palette
   * @param {string} hex the ship color @param {any} base the hull's material, or one of its finishes
   */
  function material(materials, model, palette, hex, base) {
    const role = model.trim[base.name];
    if (!role && !base.subMaterials) return base;
    return AUR.memo(materials, model.id + ':' + palette + ':' + base.name, () => {
      if (base.subMaterials) {
        const worn = new BABYLON.MultiMaterial(base.name + ' ' + palette, base.getScene());
        worn.subMaterials = base.subMaterials.map((finish) => material(materials, model, palette, hex, finish));
        return worn;
      }
      const tint = AUR.color3(hex);
      const copy = copyMaterial(base, base.name + ' ' + palette);
      if (role === 'lamps') {
        const { r, g, b } = base.emissiveColor; // the level the lamp map is authored at
        copy.emissiveColor = tint.toLinearSpace().scale(Math.max(r, g, b));
        return copy;
      }
      copy.albedoTexture = null;
      copy.emissiveTexture = null;
      trimLight(copy, tint, role);
      return copy;
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

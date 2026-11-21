// @ts-check
// Ship models built in code. A model flies the rank of a manifest hull, or the ranks of several:
// ship-assets.js asks here for the hull to fly and for its container (the ship built once per
// scene, as one mesh that every ship of the model instances), ships/livery.js for what a ship's
// hull wears, the views for the lights and the nozzles. A model keeps the finishes it was
// authored with, so it brings its own reflections, tone curve and lights, and no other light of
// the view reaches it.
'use strict';

/**
 * @import { HullEntry } from '../ship-assets.js'
 * @typedef {object} ShipModel one ship, built by its converted modules under ships/<id>/source/
 * @property {string} id also the id of the hull it flies as; in a later one of its own ranks,
 *   `<id>-<n>`, n counting those ranks from 1 (the ringed Petrel's Capital is `petrel-ring-2`)
 * @property {Array<{ hull: string, size?: number }>} replaces the ranks it takes, lowest first: the
 *   manifest hull whose rank it takes, and its longest side there in the fleet's units (the Scout
 *   is one unit long), one unit when not given
 * @property {{ scale: number, offset: number[] }} correction to the fleet's frame: its longest
 *   side one unit, centred along its length and across its span, nose on +Z (the offset is in the
 *   model's own units)
 * @property {(scene: BABYLON.Scene) => BABYLON.TransformNode} build one ship with its materials
 * @property {(scene: BABYLON.Scene) => BABYLON.BaseTexture} probe the reflections its finishes were tuned under
 * @property {Record<string, number | { lamps: string, halos?: boolean }>} trim by material name: a
 *   surface that becomes a trim light in the ship color (the number is how hot it emits;
 *   AUR.shipModels.TRIM_LIGHT is a light, less is a lit panel), or one whose emissive map (its
 *   lamps, painted in the color named) shows that color instead; `halos` when the map paints other
 *   colors around them as well, which it then shows in the ship color too
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
  // How a texture is sampled, which a grey copy of a painted map keeps.
  const SAMPLED = /** @type {const} */ (['wrapU', 'wrapV', 'anisotropicFilteringLevel', 'gammaSpace', 'coordinatesIndex', 'level', 'uScale', 'vScale', 'uOffset', 'vOffset']);

  /** @type {Map<string, { model: ShipModel, rank: number, size: number }>} */
  const ranks = new Map(); // replaced hull id -> the model that takes its rank, which of its ranks, its size
  /** @type {Map<string, HullEntry>} */
  const hulls = new Map(); // replaced hull id -> the hull entry the model flies as
  /** @type {Map<string, HullEntry>} */
  const flown = new Map(); // the id a model hull flies under -> its hull entry

  /** @param {ShipModel} model */
  function register(model) {
    model.replaces.forEach(({ hull, size = 1 }, rank) => ranks.set(hull, { model, rank, size }));
  }

  /**
   * The hull to fly for a manifest hull: the model that replaces it, in its rank and at its size
   * there, else itself.
   * @param {HullEntry} hull @returns {HullEntry}
   */
  function inPlaceOf(hull) {
    const taken = ranks.get(hull.id);
    if (!taken) return hull;
    const { model, rank, size } = taken;
    // The file names no file: it keys the model's container, templates and materials in a scene,
    // one for every rank it flies. The id names the rank, so a promotion between two of them
    // rebuilds the hull at its new size.
    return AUR.memo(hulls, hull.id, () => {
      const entry = {
        id: rank ? model.id + '-' + (rank + 1) : model.id, file: 'model:' + model.id, family: hull.family,
        role: hull.role, minBuilds: hull.minBuilds, correction: { ...model.correction, scale: model.correction.scale * size }, model,
      };
      flown.set(entry.id, entry);
      return entry;
    });
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
      // A build that fails part-way disposes what it made, and throws its own cause.
      for (const list of BUILT) {
        for (const item of made(list)) AUR.disposeLogged(item, item.name + ' from a failed build of ' + model.id);
      }
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
   * Each pixel in grey, in place: its luminance, linearized as the frame reads the map and encoded
   * back as the map was painted.
   * @param {Uint8ClampedArray} data RGBA
   */
  function greyPixels(data) {
    const color = new BABYLON.Color3();
    const greys = new Map(); // each color the map paints -> its grey, worked out once
    for (let i = 0; i < data.length; i += 4) {
      const painted = data[i] << 16 | data[i + 1] << 8 | data[i + 2];
      let grey = greys.get(painted);
      if (grey === undefined) {
        const light = color.set(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255).toLinearSpaceToRef(color).toLuminance();
        grey = color.set(light, light, light).toGammaSpaceToRef(color).r * 255;
        greys.set(painted, grey);
      }
      data[i] = data[i + 1] = data[i + 2] = grey;
    }
  }

  /** A painted map read in grey, sampled as the map is. @param {BABYLON.DynamicTexture} map @param {string} name */
  function greyMap(map, name) {
    const { width, height } = map.getSize();
    const grey = new BABYLON.DynamicTexture(name, { width, height }, map.getScene(), true, map.samplingMode);
    Object.assign(grey, Object.fromEntries(SAMPLED.map((key) => [key, map[key]])));
    const image = map.getContext().getImageData(0, 0, width, height);
    greyPixels(image.data);
    grey.getContext().putImageData(image, 0, 0);
    grey.update();
    return grey;
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
   * palette into `materials` (the scene's hull materials and the grey maps they share, released
   * with them).
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
          // The map times the emissive color is what shows, and the level the model lights its
          // lamps to is its emissive color's brightest channel (a tinted one loses its tint).
          const painted = AUR.color3(role.lamps).toLinearSpace();
          const shown = tint.toLinearSpace();
          const { r, g, b } = base.emissiveColor;
          const level = Math.max(r, g, b);
          if (role.halos) {
            // The frame linearizes the map and the glow pass does not, so only a map without a hue
            // of its own shows the ship color in both: read in grey, its lamps show it at that
            // level and the rest of it as much dimmer as it is. One grey map serves every palette.
            copy.emissiveTexture = AUR.memo(materials, model.id + ':grey:' + base.name,
              () => greyMap(/** @type {BABYLON.DynamicTexture} */ (base.emissiveTexture), base.name + ' in grey'));
            copy.emissiveColor = shown.scale(level / painted.toLuminance());
            return;
          }
          // With the painted color divided out, the frame shows the ship color. The glow pass
          // reads the map without linearizing it, so lamps painted in a warm color bloom bluer
          // than the ship color: on a Codex Scout, a faint blue bloom around the hull's hairline
          // guide lamps with the chase camera at its closest.
          copy.emissiveColor = new BABYLON.Color3(
            shown.r / Math.max(painted.r, 0.01), shown.g / Math.max(painted.g, 0.01), shown.b / Math.max(painted.b, 0.01)).scale(level);
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
   * A model hull's stern nozzles in the ship root's frame (the root carries the display scale,
   * the hull's correction its rank's size), or null when the hull is not a model's.
   * @param {string} hullId the id of a hull `inPlaceOf` returned
   */
  function nozzles(hullId) {
    const hull = flown.get(hullId);
    if (!hull) return null;
    const { scale, offset } = hull.correction;
    const shift = BABYLON.Vector3.FromArray(offset);
    return hull.model.nozzles().map(({ position, radius }) => ({
      position: BABYLON.Vector3.FromArray(position).addInPlace(shift).scaleInPlace(scale),
      radius: radius * scale,
    }));
  }

  AUR.shipModels = { LAYER, TRIM_LIGHT, register, inPlaceOf, container, material, trimLight, lights, nozzles };
})();

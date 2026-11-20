'use strict';

// AUR.shipModels and the Petrel model on the real Babylon build (a NullEngine and a stand-in canvas).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const BABYLON = require('babylonjs');
const { withCanvas, onNullScene, loadShipModules } = require('../scripts/lib/ship-fingerprint.js');
const { loadUtilLayer, readRenderer, runRenderer } = require('./support/renderer-source');
const { SHIP_ASSET_FILES, ship, hullOf, sameItems } = require('./support/ship-assets');

const ROOT = path.join(__dirname, '..');
const SHIPS = path.join(ROOT, 'src', 'renderer', 'ships');
const SOURCE = path.join(SHIPS, 'petrel', 'source');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'ships', 'manifest.json'), 'utf8'));
const SCOUT = manifest.hulls.find((hull) => hull.id === 'aur-lance-interceptor-v3');

// The registry and Petrel on the renderer's own helpers, as the page loads them.
function load() {
  const AUR = loadUtilLayer({}, BABYLON);
  const sources = fs.readdirSync(SOURCE).filter((name) => name.endsWith('.js')).map((name) => path.join(SOURCE, name));
  loadShipModules(BABYLON, path.join(SHIPS, 'modules.js'),
    [...sources, path.join(SHIPS, 'models.js'), path.join(SHIPS, 'petrel', 'model.js')], AUR);
  // A NullEngine cannot make the raw cube texture the probe is, so the model reflects a stand-in here.
  AUR.shipModule('petrel/light-probe', () => ({ createInspectionProbe: (scene) => new BABYLON.Texture(null, scene) }));
  return AUR;
}

// Runs `work(scene, models, petrel, AUR)` on a fresh scene.
function onScene(work) {
  return withCanvas(() => onNullScene(BABYLON, (scene) => {
    const AUR = load();
    return work(scene, AUR.shipModels, AUR.shipModels.inPlaceOf(SCOUT).model, AUR);
  }));
}

const trianglesOf = (mesh) => mesh.getTotalIndices() / 3;

test('Petrel flies the Scout rank: the first rank of the family both providers fly', () => {
  const models = load().shipModels;
  assert.equal(SCOUT.minBuilds, 0);
  assert.equal(SCOUT.family, manifest.providerFamilies.claude);
  assert.equal(SCOUT.family, manifest.providerFamilies.codex);

  const hull = models.inPlaceOf(SCOUT);
  assert.deepEqual({ id: hull.id, file: hull.file, family: hull.family, role: hull.role, minBuilds: hull.minBuilds },
    { id: 'petrel', file: 'model:petrel', family: SCOUT.family, role: SCOUT.role, minBuilds: 0 });
  assert.deepEqual([hull.model.id, hull.model.replaces, hull.correction], ['petrel', SCOUT.id, hull.model.correction]);
  assert.equal(models.inPlaceOf(SCOUT), hull, 'one hull entry, so a refresh compares like with like');
  const workhorse = manifest.hulls.find((entry) => entry.family === SCOUT.family && entry.minBuilds === 5);
  assert.equal(models.inPlaceOf(workhorse), workhorse, 'a rank no model has taken keeps its manifest hull');
});

test('a model container holds the dressed ship out of the scene, as one mesh with a sub-mesh per finish', () => {
  onScene((scene, models, petrel) => {
    const built = petrel.build(scene);
    const parts = built.getChildMeshes(false);
    const triangles = parts.reduce((sum, part) => sum + trianglesOf(part), 0);
    const finishes = new Set(parts.map((part) => part.material.name));
    built.dispose(false, true);

    const held = models.container(scene, petrel);
    const [hull] = held.meshes;
    assert.equal(held.meshes.length, 1);
    assert.deepEqual([scene.meshes.length, scene.transformNodes.length], [0, 0], 'the built ship is not drawn, and its parts are gone');
    assert.equal(trianglesOf(hull), triangles);
    assert.deepEqual(new Set(hull.material.subMaterials.map((finish) => finish.name)), finishes);
    assert.equal(hull.subMeshes.length, finishes.size);
    for (const finish of hull.material.subMaterials) {
      assert.ok(finish.reflectionTexture, finish.name + ' reflects the model probe');
      assert.equal(finish.imageProcessingConfiguration.toneMappingType, BABYLON.ImageProcessingConfiguration.TONEMAPPING_ACES, finish.name);
      assert.notEqual(finish.imageProcessingConfiguration, scene.imageProcessingConfiguration, 'the scene keeps its own tone curve');
      // Focus mode fades a ship by its meshes' visibility: a hull material blends then, and only then.
      assert.equal(finish.needAlphaBlendingForMesh(Object.assign(hull, { visibility: 1 })), false, finish.name);
      assert.equal(finish.needAlphaBlendingForMesh(Object.assign(hull, { visibility: 0.16 })), true, finish.name + ' fades');
    }
    hull.visibility = 1;
    assert.equal(new Set(hull.material.subMaterials.map((finish) => finish.reflectionTexture)).size, 1, 'one probe');
  });
});

// Runs `work(scene, AUR, fly)` on a system view's scene, with AUR.ships on the real Babylon build
// and Petrel flying the Scout rank of the manifest on disk; `fly(id)` resolves to a ship's hull.
function onSystem(work) {
  return withCanvas(() => onNullScene(BABYLON, async (scene) => {
    const AUR = load();
    const fetch = async () => ({ ok: true, status: 200, json: async () => manifest });
    for (const file of SHIP_ASSET_FILES) runRenderer(file, { window: { AUR }, BABYLON, fetch });
    scene.metadata = { view: 'system' };
    const fly = (id) => AUR.ships.upgrade(scene, ship(id, 0), new BABYLON.Mesh('dart ' + id, scene));
    return work(scene, AUR, fly);
  }));
}

test('in a system every Petrel of a provider is an instance of one template, lit by the model lights, and a faded one blends', () =>
  onSystem(async (scene, AUR, fly) => {
    AUR.shipModels.lights(scene);
    const a = await fly('a'), b = await fly('b');
    assert.equal(a.metadata.assetHullId, 'petrel');
    const template = hullOf(a).sourceMesh;
    assert.equal(hullOf(b).sourceMesh, template, 'one template for the provider');
    assert.deepEqual([template.isVisible, hullOf(a).isVisible], [false, true], 'a hidden template, drawn as its instances');
    const lights = (mesh) => mesh.lightSources.map((light) => light.name).sort();
    assert.ok((template.layerMask & AUR.shipModels.LAYER) && hullOf(a).layerMask === 0x0FFFFFFF, 'the layer is the template\'s');
    assert.deepEqual(lights(hullOf(a)), ['model-fill', 'model-rim', 'model-sun'], 'an instance is lit as its template is');
    const blends = (mesh) => mesh.material.subMaterials.map((finish) => finish.needAlphaBlendingForMesh(mesh));
    assert.ok(!blends(hullOf(a)).some(Boolean), 'no finish blends in full');

    AUR.ships.fade(scene, 0.16, { shipId: 'a', visibility: 1 });
    assert.deepEqual([hullOf(b).sourceMesh, hullOf(b).visibility], [template, 0.16], 'the fleet fades on its template');
    assert.ok(blends(hullOf(b)).every(Boolean), 'every finish of a faded ship blends');
    const own = hullOf(a).sourceMesh;
    assert.ok(own !== template && hullOf(a).visibility === 1 && !blends(hullOf(a)).some(Boolean), 'the followed ship, apart and in full');
    assert.deepEqual(lights(hullOf(a)), ['model-fill', 'model-rim', 'model-sun'], 'and lit as the fleet is');
    AUR.ships.fade(scene, 0.16, { shipId: 'a', visibility: 0 });
    assert.ok(!hullOf(a).isEnabled() && hullOf(b).isEnabled(), 'hidden from inside: a disabled mesh is never drawn');
    AUR.ships.fade(scene, 1);
    assert.deepEqual([hullOf(a).sourceMesh, template.visibility, own.isDisposed()], [template, 1, true], 'restored');
    assert.ok(hullOf(a).isEnabled());
  }));

// Babylon sorts a frame's blended sub-meshes by alphaIndex, then back to front; an instance batch
// is sorted as its template's sub-mesh, at the template's place (the origin, like the sun's glow).
test('a faded fleet draws after every other blended mesh, from either side of the sun', () =>
  onSystem(async (scene, AUR, fly) => {
    const a = await fly('a');
    AUR.ships.fade(scene, 0.16);
    const template = hullOf(a).sourceMesh;
    const glow = Object.assign(BABYLON.MeshBuilder.CreatePlane('sun-glow', { size: 40 }, scene), { material: new BABYLON.StandardMaterial('glow', scene) });
    const camera = new BABYLON.UniversalCamera('camera', BABYLON.Vector3.Zero(), scene);
    const drawn = (z) => {
      camera.position.set(3, 2, z);
      camera.getViewMatrix(true);
      for (const mesh of [template, glow]) mesh.computeWorldMatrix(true);
      const queue = new BABYLON.SmartArray(64);
      for (const subMesh of [...template.subMeshes, ...glow.subMeshes]) queue.push(subMesh);
      const names = [];
      const render = BABYLON.SubMesh.prototype.render;
      BABYLON.SubMesh.prototype.render = function () { names.push(this.getMesh().name); };
      try {
        BABYLON.RenderingGroup._RenderSorted(queue, BABYLON.RenderingGroup.defaultTransparentSortCompare, camera, true);
      } finally {
        BABYLON.SubMesh.prototype.render = render;
      }
      return names;
    };
    for (const z of [-30, 30]) {
      const names = drawn(z);
      assert.equal(names.length, template.subMeshes.length + 1);
      assert.equal(names[0], 'sun-glow', `the glow first, the faded finishes after it, with the camera at z ${z}`);
    }
    assert.equal(glow.alphaIndex, Number.MAX_VALUE, 'every other mesh keeps Babylon\'s default');
  }));

test('the model sits in the fleet frame its correction claims: one unit long, centred', () => {
  onScene((scene, models, petrel) => {
    const { scale, offset } = petrel.correction;
    const root = petrel.build(scene);
    root.computeWorldMatrix(true);
    const { min, max } = root.getHierarchyBoundingVectors(true);
    assert.ok(Math.abs((max.z - min.z) * scale - 1) < 0.005, `the hull is ${(max.z - min.z) * scale} units long`);
    assert.ok(Math.abs((max.z + min.z) / 2 + offset[2]) * scale < 0.005, 'centred along its length');
    assert.ok(Math.abs(max.x + min.x) * scale < 0.005 && offset[0] === 0, 'centred across its span');
    // The nozzles the plumes trail from are inside the stern the build made.
    for (const { position } of petrel.nozzles()) assert.ok(position[2] > min.z && position[2] < min.z + 0.5, 'a nozzle at the stern');
  });
});

// A scene's first PBR material makes the BRDF lookup texture that every later one uses: the scene's.
const leavesOnlyTheScenes = (scene) => {
  assert.deepEqual(['meshes', 'transformNodes', 'materials', 'multiMaterials'].map((list) => scene[list].length), [0, 0, 0, 0]);
  assert.ok(sameItems(scene.textures, [scene.environmentBRDFTexture]), 'no texture but the scene\'s BRDF lookup, kept');
};

test('a build that fails part-way leaves nothing of its own in the scene', () => {
  onScene((scene, models, petrel) => {
    const failing = { ...petrel, probe() { throw new Error('no probe'); } };
    assert.throws(() => models.container(scene, failing), /no probe/);
    leavesOnlyTheScenes(scene);
    assert.equal(models.container(scene, petrel).meshes.length, 1, 'and the scene can still build the model');
  });
});

test('a model container owns the materials and textures it was built with: disposing it releases them', () => {
  onScene((scene, models, petrel) => {
    models.container(scene, petrel).dispose();
    leavesOnlyTheScenes(scene);
  });
});

test('a ship wears the model finishes, with its trim copied once per palette in the ship color', () => {
  onScene((scene, models, petrel) => {
    const whole = models.container(scene, petrel).meshes[0].material;
    const base = (name) => whole.subMaterials.find((finish) => finish.name === name);
    const materials = new Map();
    const wear = (name, palette, hex) => models.material(materials, petrel, palette, hex, base(name));
    const claude = BABYLON.Color3.FromHexString('#d97757').toLinearSpace();
    const textures = scene.textures.length;

    assert.equal(wear('opaque smoked canopy', 'claude', '#d97757'), base('opaque smoked canopy'), 'finishes are shared');

    const lamp = wear('port position lamp', 'claude', '#d97757');
    assert.notEqual(lamp, base('port position lamp'));
    assert.ok(lamp.emissiveColor.equalsWithEpsilon(claude, 1e-6), 'the trim emits the ship color, linearized');
    assert.equal(lamp.emissiveIntensity, models.TRIM_LIGHT);
    assert.equal(wear('port position lamp', 'claude', '#d97757'), lamp, 'one copy per palette');
    assert.notEqual(wear('port position lamp', 'codex', '#f2f0ea'), lamp);

    const inlet = wear('burnt orange bay liner', 'claude', '#d97757');
    assert.equal(inlet.albedoTexture, null, 'a trim surface drops its painted color');
    assert.ok(inlet.emissiveIntensity < models.TRIM_LIGHT, 'a wide surface glows as a lit panel, not a light');
    assert.ok(base('burnt orange bay liner').albedoTexture, 'and the model keeps its own');

    // The hull's lamps show the ship color: its lamp map, painted in one color, times the emissive
    // color. Its painted maps stay the model's own (a clone alone would blank them).
    const { lamps } = petrel.trim['pearl pressure hull'];
    assert.ok(readRenderer('ships/petrel/source/plating.js').includes(`'${lamps}'`), 'the color Petrel paints its lamps in');
    const hull = wear('pearl pressure hull', 'claude', '#d97757');
    const shown = (worn) => BABYLON.Color3.FromHexString(lamps).toLinearSpace().multiply(worn.emissiveColor);
    assert.ok(shown(hull).equalsWithEpsilon(claude.scale(2.5), 1e-6), 'at the level the lamp map was authored at');
    assert.ok(shown(wear('pearl pressure hull', 'codex', '#f2f0ea'))
      .equalsWithEpsilon(BABYLON.Color3.FromHexString('#f2f0ea').toLinearSpace().scale(2.5), 1e-6), 'pearl on a Codex ship, not amber');
    for (const slot of ['albedoTexture', 'bumpTexture', 'metallicTexture', 'emissiveTexture', 'reflectionTexture']) {
      assert.ok(hull[slot], slot);
      assert.equal(hull[slot], base('pearl pressure hull')[slot], slot);
    }
    assert.equal(hull.imageProcessingConfiguration, base('pearl pressure hull').imageProcessingConfiguration);
    assert.equal(base('pearl pressure hull').emissiveColor.r, 2.5, 'the model material is untouched');
    for (const name of Object.keys(petrel.trim)) assert.ok(base(name), name + ' is a material Petrel builds');

    // The whole hull's material for a palette: each finish in its place, the trim swapped for its copy.
    const worn = models.material(materials, petrel, 'claude', '#d97757', whole);
    assert.equal(models.material(materials, petrel, 'claude', '#d97757', whole), worn, 'one per palette');
    assert.ok(sameItems(worn.subMaterials, whole.subMaterials.map((finish) => wear(finish.name, 'claude', '#d97757'))));
    assert.equal(worn.subMaterials.filter((finish, i) => finish !== whole.subMaterials[i]).length, Object.keys(petrel.trim).length);
    assert.equal(scene.textures.length, textures, 'a copy makes no texture of its own');
  });
});

test('a model hull is lit by the three model lights and nothing else; they light nothing else', () => onNullScene(BABYLON, async (scene) => {
  const AUR = load();
  const models = AUR.shipModels;
  const lit = (mesh) => { mesh._resyncLightSources(); return mesh.lightSources.map((light) => light.name).sort(); };
  new BABYLON.HemisphericLight('view-sky', BABYLON.Vector3.Up(), scene);
  const key = new BABYLON.DirectionalLight('ship-key', BABYLON.Vector3.Down(), scene);
  key.includeOnlyWithLayerMask = AUR.SHIP_LAYER;
  models.lights(scene);
  new BABYLON.PointLight('view-sun', BABYLON.Vector3.Zero(), scene); // a view may add its sun later
  await new Promise((resolve) => setTimeout(resolve, 20)); // Babylon announces a new light on the next tick
  const hull = new BABYLON.Mesh('model hull', scene), fleet = new BABYLON.Mesh('fleet hull', scene), planet = new BABYLON.Mesh('planet', scene);
  hull.layerMask |= models.LAYER;
  fleet.layerMask |= AUR.SHIP_LAYER;
  assert.deepEqual(lit(hull), ['model-fill', 'model-rim', 'model-sun'], 'within the four lights a material draws');
  assert.deepEqual(lit(fleet), ['ship-key', 'view-sky', 'view-sun']);
  assert.deepEqual(lit(planet), ['view-sky', 'view-sun']);
  assert.equal(models.LAYER & AUR.SHIP_LAYER, 0, 'apart from the fleet layer');
  assert.equal(models.LAYER & 0x0fffffff, 0, 'outside the cameras\' default mask');
}));

test('the nozzles sit at the stern in the fleet frame', () => {
  const models = load().shipModels;
  assert.equal(models.nozzles('aur-bastion-corvette-v3'), null, 'a manifest hull finds its own');
  const [port, starboard] = models.nozzles('petrel');
  assert.ok(Math.abs(port.position.x + starboard.position.x) < 1e-9 && starboard.position.x > 0, 'mirrored');
  assert.ok(port.position.z < -0.4 && port.position.z > -0.5, 'at the stern of a hull one unit long, centred');
  assert.ok(port.radius > 0.02 && port.radius < 0.05);
});

test('an opaque material fades with its mesh once it gives its transparency mode up; a cut-out keeps its own', () => onNullScene(BABYLON, (scene) => {
  const AUR = load();
  const mesh = new BABYLON.Mesh('hull', scene);
  const made = (name, mode) => Object.assign(new BABYLON.PBRMaterial(name, scene), { transparencyMode: mode });
  const opaque = made('opaque', BABYLON.Material.MATERIAL_OPAQUE), glass = made('glass', BABYLON.Material.MATERIAL_ALPHABLEND);
  const cutOut = made('cut-out', BABYLON.Material.MATERIAL_ALPHATEST);
  cutOut.albedoTexture = Object.assign(new BABYLON.Texture(null, scene), { hasAlpha: true });
  mesh.visibility = 0.16;
  assert.equal(opaque.needAlphaBlendingForMesh(mesh), false, 'set opaque, Babylon ignores visibility');
  for (const material of [opaque, cutOut, glass]) AUR.fadeWithMesh(material);
  assert.equal(opaque.needAlphaBlendingForMesh(mesh), true, 'it fades');
  mesh.visibility = 1;
  assert.equal(opaque.needAlphaBlendingForMesh(mesh), false, 'and is solid at full visibility');
  assert.equal(glass.transparencyMode, BABYLON.Material.MATERIAL_ALPHABLEND, 'a blended material keeps its mode');
  assert.equal(glass.needAlphaBlendingForMesh(mesh), true, 'and blends as it is, so it fades with its mesh');
  // Without its mode a faded cut-out would blend and no longer be tested: its holes would fill.
  assert.equal(cutOut.transparencyMode, BABYLON.Material.MATERIAL_ALPHATEST);
  mesh.visibility = 0.16;
  assert.deepEqual([cutOut.needAlphaBlendingForMesh(mesh), cutOut.needAlphaTestingForMesh(mesh)], [false, true],
    'with its mode kept a cut-out does not fade');
  cutOut.transparencyMode = null;
  assert.deepEqual([cutOut.needAlphaBlendingForMesh(mesh), cutOut.needAlphaTestingForMesh(mesh)], [true, false]);
}));

test('a trim copy that cannot be dressed is not left in the scene, and the next one is made whole', () => onNullScene(BABYLON, (scene) => {
  const models = load().shipModels;
  const lamp = new BABYLON.PBRMaterial('lamp', scene);
  const hull = new BABYLON.MultiMaterial('hull', scene);
  hull.subMaterials = [lamp];
  const model = { id: 'probe', trim: { lamp: { lamps: '#ffb24a' } } };
  const materials = new Map();
  const made = () => [scene.materials.length, scene.multiMaterials.length];
  const before = made();

  const emissive = lamp.emissiveColor;
  lamp.emissiveColor = null; // what a lamp's dressing reads
  lamp.clone('a copy can still be made').dispose();
  assert.throws(() => models.material(materials, model, 'claude', '#ff7a1a', hull), TypeError);
  assert.deepEqual(made(), before, 'neither the lamp copy nor the hull material that was to hold it stays');
  assert.equal(materials.size, 0, 'and nothing half dressed is kept for the next ship');

  lamp.emissiveColor = emissive;
  const worn = models.material(materials, model, 'claude', '#ff7a1a', hull);
  assert.deepEqual(made(), [before[0] + 1, before[1] + 1]);
  assert.notEqual(worn.subMaterials[0], lamp, 'the hull wears the lamp in the ship color');
}));

test('a trim copy that cannot be made leaves the model finish every map it had, and the next copy is whole', () => {
  onScene((scene, models, petrel) => {
    const finish = models.container(scene, petrel).meshes[0].material.subMaterials.find((made) => made.name === 'pearl pressure hull');
    const slots = ['albedoTexture', 'bumpTexture', 'metallicTexture', 'emissiveTexture', 'reflectionTexture'];
    const maps = slots.map((slot) => finish[slot]);
    const mapsOf = (material) => slots.map((slot) => material[slot]);
    const materials = new Map();
    const count = scene.materials.length;
    const wear = () => models.material(materials, petrel, 'claude', '#d97757', finish);
    const clone = finish.clone;

    finish.clone = () => { throw new Error('no clone'); };
    assert.throws(wear, /no clone/);
    assert.ok(sameItems(mapsOf(finish), maps), 'the finish keeps its maps when the clone fails');
    finish.clone = function (name) { // a copy made that cannot take the model's tone curve
      return Object.defineProperty(clone.call(this, name), 'imageProcessingConfiguration', { set() { throw new Error('no tone curve'); } });
    };
    assert.throws(wear, /no tone curve/);
    assert.ok(sameItems(mapsOf(finish), maps), 'and when the copy cannot take them');
    assert.deepEqual([scene.materials.length, materials.size], [count, 0], 'no copy is left in the scene or kept');

    delete finish.clone;
    assert.ok(maps.every(Boolean) && sameItems(mapsOf(wear()), maps), 'the next copy shares every map');
  });
});

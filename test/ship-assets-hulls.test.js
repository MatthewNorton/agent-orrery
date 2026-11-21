'use strict';

// A hull template writes its ships' matrices once a frame (ship-assets-hulls.js), on the real
// Babylon build: a system view's Petrels are instances of one template of 24 parts, and each part
// draws in the view's glow pass and the camera's. Babylon on its own writes before every draw.
const test = require('node:test');
const assert = require('node:assert/strict');
const BABYLON = require('babylonjs');
const { hullOf, ship } = require('./support/ship-assets');
const { onSystem } = require('./support/ships-models');

// Runs `work(fleet)` on a system view with the Claude Petrels `ids` side by side before a camera,
// and the view's glow layer. A NullEngine says it cannot draw instances and never uploads a
// texture, so it is told it can and the finishes' textures say they are ready. `fleet.frame()`
// renders a frame and returns the writes into the template's instance buffer (the ships written,
// or 'made' for a new buffer) and, for each of the template's draws, the ships the buffer held.
function onFleet(ids, work) {
  return onSystem(async (scene, AUR, fly) => {
    const engine = scene.getEngine();
    engine.getCaps().instancedArrays = true;
    AUR.shipModels.lights(scene);
    new BABYLON.UniversalCamera('camera', new BABYLON.Vector3(0, 0, -10), scene);
    new BABYLON.GlowLayer('glow', scene);
    const roots = new Map(), hulls = new Map();
    const add = async (id) => {
      const root = await fly(id);
      root.position.x = roots.size * 0.01;
      roots.set(id, root);
      hulls.set(id, hullOf(root));
    };
    for (const id of ids) await add(id);
    const template = hulls.get(ids[0]).sourceMesh;
    for (const finish of template.material.subMaterials) {
      for (const texture of finish.getActiveTextures()) texture.isReady = () => true;
    }

    // What the GPU would hold in each dynamic vertex buffer: a NullEngine keeps nothing.
    const held = new Map();
    let writes = [], draws = [];
    const create = engine.createDynamicVertexBuffer, update = engine.updateDynamicVertexBuffer;
    engine.createDynamicVertexBuffer = function (data, ...rest) {
      const buffer = create.call(this, data, ...rest);
      held.set(buffer, Float32Array.from(data));
      writes.push({ buffer, ships: 'made' });
      return buffer;
    };
    engine.updateDynamicVertexBuffer = function (buffer, data, byteOffset = 0, byteLength = data.byteLength - byteOffset) {
      if (held.has(buffer)) held.get(buffer).set(data.subarray(byteOffset / 4, (byteOffset + byteLength) / 4));
      writes.push({ buffer, ships: byteLength / 64 });
      return update.apply(this, arguments);
    };
    const shipAt = (matrices, i) => {
      const drawn = matrices.subarray(16 * i, 16 * i + 16);
      for (const [id, hull] of hulls) if (hull.getWorldMatrix().asArray().every((value, k) => value === drawn[k])) return id;
      return 'stale';
    };
    const draw = template._draw;
    template._draw = function (subMesh, fillMode, count) {
      const buffer = template._instanceDataStorage.dataStorageRenderPass.instancesBuffer.getBuffer();
      const ships = Array.from({ length: count }, (_, i) => shipAt(held.get(buffer), i));
      draws.push({ buffer, ships: ships.sort().join(' ') });
      return draw.apply(this, arguments);
    };
    const frame = () => {
      writes = [];
      draws = [];
      scene.render();
      const read = new Set(draws.map((entry) => entry.buffer));
      return { writes: writes.filter((entry) => read.has(entry.buffer)).map((entry) => entry.ships), draws: draws.map((entry) => entry.ships) };
    };
    const settle = async () => {
      for (let tries = 0; !scene.isReady() && tries < 100; tries++) {
        scene.render();
        await new Promise((resolve) => setTimeout(resolve, 2)); // Babylon compiles its shaders between frames
      }
      assert.ok(scene.isReady(), 'every finish compiles');
      frame(); // the first frame after a change makes the buffer
    };
    await settle();
    return work({ scene, AUR, template, roots, hulls, parts: template.subMeshes.length, add, frame, settle });
  });
}

const times = (count, ships) => Array(count).fill(ships);

test('a template writes its ships once a frame, though each of its parts draws in two passes', () =>
  onFleet(['a', 'b'], ({ template, parts, frame }) => {
    assert.equal(parts, 24);
    assert.ok(Object.hasOwn(template, '_updateInstancedBuffers'), 'the template writes through writeInstancesOnce');
    for (let i = 0; i < 3; i++) {
      const { writes, draws } = frame();
      assert.deepEqual(writes, [2], 'one write a frame, of both ships');
      assert.deepEqual(draws, times(parts * 2, 'a b'), 'and every draw of both passes reads both');
    }
    // Babylon's own update, which writes for every draw: what the write-once rule saves.
    delete template._updateInstancedBuffers;
    const { writes, draws } = frame();
    assert.deepEqual(writes, times(parts * 2, 2));
    assert.deepEqual(draws, times(parts * 2, 'a b'));
  }));

test('a pass that draws other ships than the frame\'s last write writes its own', () =>
  onFleet(['a', 'b'], async ({ scene, hulls, parts, frame, settle }) => {
    for (const id of ['a', 'b']) {
      const pass = new BABYLON.RenderTargetTexture('only ' + id, 64, scene);
      pass.renderList = [hulls.get(id)];
      scene.customRenderTargets.push(pass);
    }
    await settle();
    const { writes, draws } = frame();
    assert.deepEqual(writes, [1, 1, 2], 'one ship, then the other, then both for the glow, which the camera reuses');
    assert.deepEqual(draws, [...times(parts, 'a'), ...times(parts, 'b'), ...times(parts * 2, 'a b')]);
  }));

test('a template that draws itself writes for each of its draws, and the next pass does not draw it as a ship', () =>
  onFleet(['a', 'b'], async ({ scene, template, hulls, frame, settle }) => {
    // Shown, and far to one side: a wide camera draws it with its ships, a narrow one the ships alone.
    Object.assign(template, { isVisible: true }).position.x = 400;
    hulls.set('T', template);
    const wide = new BABYLON.FreeCamera('wide', new BABYLON.Vector3(200, 0, -2000), scene);
    wide.setTarget(new BABYLON.Vector3(200, 0, 0));
    wide.maxZ = 4000;
    const narrow = scene.activeCamera;
    // The third order draws the ships alone, then the template too, then the ships alone again.
    for (const cameras of [[wide, narrow], [narrow, wide], [narrow, wide, narrow]]) {
      scene.activeCameras = cameras;
      await settle();
      const { writes, draws } = frame();
      const withTemplate = draws.filter((ships) => ships === 'T a b').length;
      assert.ok(withTemplate > 0 && draws.includes('a b'), 'one camera draws the template, the other does not');
      assert.deepEqual(draws.filter((ships) => ships !== 'T a b' && ships !== 'a b'), [], 'and no draw reads another layout');
      assert.equal(writes.filter((ships) => ships === 3).length, withTemplate, 'a draw of the template itself always writes');
    }
  }));

test('a frozen template stays frozen, and one whose passes each keep a buffer is left to Babylon', () =>
  onFleet(['a', 'b'], async ({ scene, AUR, template, frame }) => {
    template._instanceDataStorage.isFrozen = true;
    assert.deepEqual(frame().writes, [], 'Babylon writes nothing for a frozen mesh');
    assert.equal(template._instanceDataStorage.isFrozen, true);
    // WebGPU keeps an instance buffer a pass, where one write a frame would leave the others stale.
    const engine = scene.getEngine();
    Object.defineProperty(engine, 'isWebGPU', { value: true, configurable: true });
    const codex = await AUR.ships.upgrade(scene, ship('c', 0, { provider: 'codex' }), new BABYLON.Mesh('dart c', scene));
    delete engine.isWebGPU;
    const other = hullOf(codex).sourceMesh;
    assert.notEqual(other, template, 'another palette, another template');
    assert.equal(Object.hasOwn(other, '_updateInstancedBuffers'), false);
  }));

test('a new frame writes again: a ship that moved draws where it is, and a hidden one is gone', () =>
  onFleet(['a', 'b'], ({ roots, parts, frame }) => {
    roots.get('b').position.y = 0.5;
    let { writes, draws } = frame();
    assert.deepEqual(writes, [2]);
    assert.deepEqual(draws, times(parts * 2, 'a b'), 'no draw reads where b was');
    roots.get('b').setEnabled(false);
    ({ writes, draws } = frame());
    assert.deepEqual(writes, [1]);
    assert.deepEqual(draws, times(parts * 2, 'a'));
  }));

test('a fleet that outgrows the instance buffer gets a new one, made once with every ship', () =>
  onFleet(['a', 'b'], async ({ template, hulls, parts, add, frame }) => {
    const storage = template._instanceDataStorage.dataStorageRenderPass;
    const size = storage.instancesBufferSize;
    for (let i = 0; hulls.size * 16 * 4 < size; i++) await add('s' + i);
    const every = [...hulls.keys()].sort().join(' ');
    let { writes, draws } = frame();
    assert.equal(storage.instancesBufferSize, size * 2);
    assert.deepEqual(writes, ['made'], 'the new buffer holds every ship, so nothing writes into it after');
    assert.deepEqual(draws, times(parts * 2, every));
    ({ writes, draws } = frame());
    assert.deepEqual(writes, [hulls.size]);
    assert.deepEqual(draws, times(parts * 2, every));
  }));

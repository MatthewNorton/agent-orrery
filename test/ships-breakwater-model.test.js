'use strict';

// Breakwater's adapter (src/renderer/ships/breakwater/model.js) on the real Babylon build (a
// NullEngine and a stand-in canvas): the drydock flies the Flagship rank, four Petrels parked on it.
const test = require('node:test');
const assert = require('node:assert/strict');
const BABYLON = require('babylonjs');
const { readRenderer } = require('./support/renderer-source');
const { shownLength } = require('./support/glb');
const { ship } = require('./support/ship-assets');
const {
  rank, loadShipModels: load, onModelScene: onScene, onSystem, near, trianglesOf, palettes, built,
} = require('./support/ships-models');

const record = JSON.parse(readRenderer('ships/breakwater/source/source.json'));
const [SCOUT, CAPITAL, FLAGSHIP] = [0, 20, 60].map(rank);

test('Breakwater flies the Flagship rank, as wide as the fleet shows its Flagship long', () => {
  const hull = load().shipModels.inPlaceOf(FLAGSHIP);
  assert.deepEqual({ id: hull.id, file: hull.file, role: hull.role, minBuilds: hull.minBuilds },
    { id: 'breakwater', file: 'model:breakwater', role: FLAGSHIP.role, minBuilds: 60 });
  const shown = shownLength(FLAGSHIP);
  assert.ok(near(hull.correction.scale / hull.model.correction.scale, shown, 0.01), `shown ${shown} long`);
});

// The yard builds one quadrant and one Petrel and instances each three times; a merge takes no
// instance, and it builds a finish from many parts.
test('the yard sits in the fleet frame its correction claims, and its container holds all of it as one mesh, a sub-mesh per finish', () => {
  onScene((scene, models) => {
    const { model } = models.inPlaceOf(FLAGSHIP);
    const { scale, offset } = model.correction;
    const { root, min, max, size } = built(scene, model);
    assert.ok(near(size.x, size.z, 0.01) && size.x > size.y, 'as wide as it is long, and wider than it is tall');
    assert.ok(near(size.x * scale, 1, 0.005), `it is ${size.x * scale} across`);
    assert.ok(near((max.x + min.x) * scale, 0, 0.005) && near((max.z + min.z) * scale, 0, 0.005), 'centred on its axis');
    assert.deepEqual(offset, [0, 0, 0]);
    assert.ok(max.y > 0 && min.y < -max.y, 'its bridge above the decks and its keel, the longer, below');
    const parts = root.getChildMeshes(false);
    assert.ok(parts.some((part) => part.isAnInstance), 'the build instances its repeated parts');
    const finishes = new Set(parts.map((part) => part.material.name));
    root.dispose(false, true);

    const held = models.container(scene, model);
    const [hull] = held.meshes;
    assert.equal(held.meshes.length, 1);
    assert.deepEqual([scene.meshes.length, scene.transformNodes.length], [0, 0], 'the built yard is not drawn, and its parts are gone');
    assert.equal(trianglesOf(hull), record.geometry.triangles, 'the build source.json records');
    assert.deepEqual(new Set(hull.material.subMaterials.map((finish) => finish.name)), finishes);
    assert.equal(hull.subMeshes.length, finishes.size, 'one draw per finish');
    hull.refreshBoundingInfo();
    const { minimum, maximum } = hull.getBoundingInfo().boundingBox;
    assert.ok(minimum.equalsWithEpsilon(min, 1e-3) && maximum.equalsWithEpsilon(max, 1e-3), 'nothing moved in the merge');
    // The four Petrels' tires, alone in their finish, stand on the four berths.
    const tires = hull.subMeshes[hull.material.subMaterials.findIndex((finish) => finish.name === 'Landing tires')];
    tires.refreshBoundingInfo(hull.getVerticesData('position'));
    const reach = tires.getBoundingInfo().boundingBox;
    for (const side of [reach.minimum.x, reach.maximum.x, reach.minimum.z, reach.maximum.z]) {
      assert.ok(Math.abs(side) > 20 && Math.abs(side) < 25, `a berth ${side} from the axis`);
    }
    // A tire has a vertex at its foot, the point the yard sets on the deck at y 0.
    assert.ok(Math.abs(reach.minimum.y) < 1e-4, `the tires reach ${reach.minimum.y}, not the deck`);
  });
});

// One berth as the yard builds it (the master quadrant the other three instance), and the hub: each
// a mesh per finish.
function onBerth(work) {
  onScene((scene, models, AUR) => {
    const { root } = built(scene, models.inPlaceOf(FLAGSHIP).model);
    const berth = root.getChildTransformNodes(true).find((node) => node.name === 'North quadrant');
    const finishOf = (node) => (name) => node.getChildMeshes(true).find((mesh) => mesh.material.name === name);
    work(finishOf(berth), finishOf(root), AUR);
    root.dispose(false, true);
  });
}
const pointsOf = (mesh) => {
  const p = mesh.getVerticesData('position');
  return Array.from({ length: p.length / 3 }, (_, i) => BABYLON.Vector3.FromArray(p, 3 * i));
};

test('the rail around a berth\'s apron stands on a post at every corner, the two beside the corridor included', () => {
  onBerth((finish, hub, AUR) => {
    const { APRON } = AUR.useShipModule('breakwater/layout');
    const pipes = pointsOf(finish('Distribution lines'));
    for (const [x, z] of APRON) {
      // A post rises from the deck to the top rail; the lower rail's end, also a pipe, is only a ring.
      const ys = pipes.filter((p) => Math.hypot(p.x - x, p.z - z) < 0.2 && p.y > 0 && p.y < 1).map((p) => p.y);
      const height = ys.length ? Math.max(...ys) - Math.min(...ys) : 0;
      assert.ok(height > 0.5, `no post at the corner (${x}, ${z})`);
    }
  });
});

test('no work light on a berth is shut inside a freight container', () => {
  onBerth((finish) => {
    // Every crate and lamp is a box of six faces, 24 vertices.
    const boxes = (mesh) => {
      const positions = mesh.getVerticesData('position');
      assert.equal(positions.length % 72, 0, mesh.name);
      return Array.from({ length: positions.length / 72 }, (_, i) => {
        const { minimum, maximum } = BABYLON.extractMinAndMax(positions, 24 * i, 24);
        return new BABYLON.BoundingBox(minimum, maximum);
      });
    };
    const crates = boxes(finish('Freight containers'));
    assert.equal(crates.length, 4, 'the four crates of a berth');
    for (const lamp of boxes(finish('Work lights'))) {
      const { x, y, z } = lamp.center;
      assert.ok(!crates.some((crate) => BABYLON.BoundingBox.Intersects(lamp, crate)),
        `the lamp at (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}) is inside a crate`);
    }
  });
});

const radius = (p) => Math.hypot(p.x, p.z);

test('the service box under the rim stands on the band below it', () => {
  onBerth((finish) => {
    // The box's walls are at radius 19.27 and 22.28, over a band from 19.2 to 22.9.
    const ys = (keep) => pointsOf(finish('Graphite machinery')).filter(keep).map((p) => p.y);
    const bandTop = Math.max(...ys((p) => near(radius(p), 19.2, 1e-3)));
    const wallFoot = Math.min(...ys((p) => near(radius(p), 19.27, 1e-3) || near(radius(p), 22.28, 1e-3)));
    assert.ok(near(wallFoot, bandTop, 1e-6), `the box's walls end at ${wallFoot}, the band's top is at ${bandTop}`);
  });
});

test('every mast on the hub\'s roof stands on one level: none across the wall of the communications cap or of the collar around it, none sunk into the cap', () => {
  onBerth((finish, hub) => {
    // Above the roof at 5.63 the cap's flat top, 0.84 up, ends at radius 1.31. Its wall comes down to
    // the collar at 1.48, past a steel ring of its own at 1.45, and the collar's own wall is at 1.79.
    const above = (p) => p.y - 5.63;
    const steel = pointsOf(hub('Load-bearing steel')).filter((p) => above(p) > -0.01 && above(p) < 0.84 + 0.25);
    const misplaced = [
      // A mast's base is steel: none of it over either wall, on the cap's level or the roof's, and none inside the cap.
      ...steel.filter((p) => radius(p) > 1.311 && radius(p) < 1.78 && !near(radius(p), 1.45, 1e-3)),
      ...steel.filter((p) => radius(p) < 1.309 && above(p) < 0.84 - 1e-6),
      // Its can is armor and its stays are dark: none of them between the two walls.
      ...['Weathered porcelain armor', 'Graphite machinery'].flatMap((name) => pointsOf(hub(name)))
        .filter((p) => above(p) > -0.01 && above(p) < 0.84 && radius(p) > 1.49 && radius(p) < 1.78),
    ];
    const [one] = misplaced;
    assert.equal(misplaced.length, 0, one && `${misplaced.length} points of a mast out of place, one at (${one.x.toFixed(2)}, ${one.y.toFixed(2)}, ${one.z.toFixed(2)})`);
  });
});

test('each painted map is drawn to the size of the canvas it is given', () => {
  onScene((scene, models, AUR) => {
    const Blank = globalThis.OffscreenCanvas;
    const layouts = [];
    // A canvas that notes, from the scale its painter sets, the size the painter lays its map out at.
    // The engine here makes no canvas wider or higher than 512, so every painter has to scale, the rooms' in width.
    globalThis.OffscreenCanvas = class extends Blank {
      getContext() {
        const scale = (x, y) => layouts.push([this.width / x, this.height / y]);
        return new Proxy(super.getContext(), { get: (context, key) => (key === 'canvas' ? this : key === 'scale' ? scale : context[key]) });
      }
    };
    try {
      AUR.useShipModule('breakwater/finishes').createFinishes(scene);
    } finally {
      globalThis.OffscreenCanvas = Blank;
    }
    // The plates and their relief, the rooms by day and lit (eight of 128 side by side), and the deck.
    assert.deepEqual(layouts, [[1024, 1024], [1024, 1024], [1024, 128], [1024, 128], [1024, 1024]]);
  });
});

test('a bar of no length, a girder facing along itself and an apron width asked for off the apron are refused, not built wrong', () => {
  onScene((scene, models, AUR) => {
    const { Fabrication, v } = AUR.useShipModule('breakwater/fabrication');
    const { APRON, apronHalfWidthAtRim } = AUR.useShipModule('breakwater/layout');
    const frame = new Fabrication(scene, new BABYLON.TransformNode('frame', scene));
    const steel = new BABYLON.PBRMaterial('steel', scene);
    steel.metadata = { tile: 5 };
    assert.throws(() => frame.bar(steel, v(0, 0, 0), v(0, 0, 0), 0.1, 0.1), /two ends apart/);
    assert.throws(() => frame.girder(steel, v(0, 0, 0), v(0, 1, 0), 0.3, 0.3), /face along its own axis/);
    // Hinted along itself, a bar takes an axis it is not along for its side, along X too.
    frame.bar(steel, v(0, 0, 0), v(0, 1, 0), 0.1, 0.1);
    frame.bar(steel, v(0, 0, 0), v(1, 0, 0), 0.1, 0.1, v(1, 0, 0));
    // A hint along the bar is one whatever its length: half a unit, and none.
    frame.bar(steel, v(0, 0, 0), v(0, 1, 0), 0.1, 0.1, v(0, 0.5, 0));
    frame.bar(steel, v(0, 0, 0), v(0, 1, 0), 0.1, 0.1, v(0, 0, 0));
    // A short hint across the bar is as good as a long one.
    frame.bar(steel, v(0, 0, 0), v(0, 1, 0), 0.1, 0.1, v(1e-7, 0, 0));
    assert.equal(frame.surfaces.get(steel).positions.length / 3, 120, 'five bars of six faces');

    // The width follows the apron's side, corner to corner, from its first station to its last.
    const side = APRON.slice(1, 6);
    for (const [x, z] of side) assert.ok(near(apronHalfWidthAtRim(z), x), `at ${z}`);
    const [[x1, z1], [x2, z2]] = side;
    assert.ok(near(apronHalfWidthAtRim((z1 + z2) / 2), (x1 + x2) / 2), 'midway along its first edge');
    assert.throws(() => apronHalfWidthAtRim(side[0][1] - 0.01), /no width/);
    assert.throws(() => apronHalfWidthAtRim(side[4][1] + 0.01), /no width/);
  });
});

test('its work lights are lamps in the ship color, its parked Petrels wear the trim they fly in, its windows stay lit as painted', () => {
  onScene((scene, models, AUR) => {
    const { model } = models.inPlaceOf(FLAGSHIP);
    const petrel = models.inPlaceOf(SCOUT).model;
    for (const [name, role] of Object.entries(petrel.trim)) assert.deepEqual(model.trim[name], role, name);
    assert.equal(model.trim['Work lights'], models.TRIM_LIGHT);
    assert.equal(model.probe, petrel.probe, 'finished under the probe its Petrels reflect');

    const finishes = models.container(scene, model).meshes[0].material.subMaterials;
    const named = (name) => finishes.find((finish) => finish.name === name);
    for (const name of Object.keys(model.trim)) assert.ok(named(name), name + ' is a finish of the yard');
    const materials = new Map();
    for (const [palette, hex] of palettes(AUR)) {
      const lamp = models.material(materials, model, palette, hex, named('Work lights'));
      assert.notEqual(lamp, named('Work lights'), palette);
      assert.ok(lamp.emissiveColor.equalsWithEpsilon(BABYLON.Color3.FromHexString(hex).toLinearSpace(), 1e-6), `${palette}: lit in the ship color`);
      assert.equal(lamp.emissiveIntensity, models.TRIM_LIGHT);
      const windows = named('Inhabited pressure windows');
      assert.equal(models.material(materials, model, palette, hex, windows), windows, `${palette}: the windows are the art's`);
    }
    assert.ok(named('Inhabited pressure windows').emissiveTexture, 'the rooms the art lights');
  });
});

test('a yard has no drive: it names no nozzle, where a hull that is no model\'s has none to name', () => {
  const models = load().shipModels;
  const nozzles = models.nozzles(models.inPlaceOf(FLAGSHIP).id);
  assert.ok(Array.isArray(nozzles) && nozzles.length === 0, 'the system view trails nothing from it');
  assert.equal(models.nozzles(FLAGSHIP.id), null);
});

test('in a system a ship of sixty builds flies the yard, and a Capital is promoted onto it', () =>
  onSystem(async (scene, AUR, fly) => {
    AUR.shipModels.lights(scene);
    const [f, c] = [await fly('f', 60), await fly('c', 20)];
    assert.deepEqual([f, c].map((root) => root.metadata.assetHullId), ['breakwater', AUR.shipModels.inPlaceOf(CAPITAL).id]);
    assert.equal(await AUR.ships.refresh(scene, ship('c', 60)), c);
    assert.equal(c.metadata.assetHullId, 'breakwater');
    const { ships } = AUR.shipAssets.sceneStates.get(scene);
    assert.ok(near(ships.get('c').correction.scaling.x, ships.get('f').correction.scaling.x), 'at the Flagship size');
  }));

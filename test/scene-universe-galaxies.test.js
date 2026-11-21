'use strict';

// The universe map's camera framing (src/renderer/scene/universe/galaxies.js) on Babylon's own
// ArcRotateCamera: the fit clears the panels at their default sizes whatever they are doing now,
// gives the same camera however often it runs, still follows the window, and grows the sky dome so
// the camera never leaves it.

const assert = require('node:assert/strict');
const test = require('node:test');
const BABYLON = require('babylonjs');
const LAYOUT = require('../src/renderer/galaxy-layout.js');
const { fakeDocument } = require('./support/fake-dom');
const { readRenderer, runRenderer } = require('./support/renderer-source');

BABYLON.Logger.LogLevels = BABYLON.Logger.NoneLogLevel;

const SKY_RADIUS = 800; // scene/universe/view.js: a dome 1600 across
// AUR.app.defaultPanelRoom at text size 100% (app/panels/resize.js): the tokens' --space-3 12px
// margin, plus --rail-l 296px, --rail-r 312px and --dock-h 52px.
const ROOM = { left: 12 + 296, right: 12 + 312, bottom: 12 + 52 };
const GAP = 8; // what AUR.chromeBounds keeps clear of the chrome

// The page's chrome as boxes: the top bar, the two rails and the timeline, on a canvas of the
// window's size. `layout` changes them; a rail 0 wide or `timeline: false` is off screen.
function page(width = 1666, height = 944) {
  const document = fakeDocument(['topbar', 'rail-left', 'sidebar', 'history-bar']);
  const canvas = { clientWidth: width, clientHeight: height };
  const box = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top });
  const layout = ({ left = 0, right = 312, timeline = true } = {}) => {
    const { clientWidth: w, clientHeight: h } = canvas;
    const set = (id, rect, shown) => {
      const el = document.getElementById(id);
      el.getBoundingClientRect = () => rect;
      el.classList.toggle('hidden', !shown);
    };
    set('topbar', box(0, 0, w, 48), true);
    set('rail-left', box(12, 60, 12 + left, h - 76), left > 0);
    set('sidebar', box(w - 12 - right, 60, w - 12, h - 76), right > 0);
    set('history-bar', box(12, h - 64, w - 12, h - 12), timeline);
  };
  layout();
  return { document, canvas, layout };
}

// Three galaxies spread like a small profile's, `spread` times as far apart.
const SMALL = [['work', 0, 0, 0, 44, 0.12, -0.08], ['personal', 96, 6, 30, 34, -0.1, 0.14], ['open-source', 20, -5, -86, 30, 0.2, 0.05]];
const small = (spread = 1) => SMALL.map(([key, x, y, z, radius, tiltX, tiltZ]) => ({ key, x: x * spread, y, z: z * spread, radius, tiltX, tiltZ }));

// A universe view's camera as scene/universe/view.js makes it, over `specs` (galaxy-layout.js
// galaxies), with the galaxies part's framing.
function universe({ document, canvas }, specs = small()) {
  const window = {};
  runRenderer('util.js', { window, document, getComputedStyle: () => ({ display: 'block' }) });
  runRenderer('scene/common.js', { window, document, BABYLON });
  runRenderer('scene/universe/galaxies.js', { window, document, BABYLON });
  // The engine draws at the canvas's size, so the camera's aspect is the page's.
  const engine = new BABYLON.NullEngine({ renderWidth: canvas.clientWidth, renderHeight: Math.max(1, canvas.clientHeight),
    textureSize: 512, deterministicLockstep: false, lockstepMaxSteps: 1 });
  const scene = new BABYLON.Scene(engine);
  const camera = new BABYLON.ArcRotateCamera('ucam', -Math.PI / 2, 0.82, 175, BABYLON.Vector3.Zero(), scene);
  Object.assign(camera, { minZ: 0.1, maxZ: 6000, lowerRadiusLimit: 60, upperRadiusLimit: 320,
    lowerBetaLimit: 0.15, upperBetaLimit: 1.35, mapPanning: true });
  const galaxies = new Map();
  for (const spec of specs) {
    const pivot = new BABYLON.TransformNode('galaxy:' + spec.key, scene);
    pivot.position.set(spec.x, spec.y, spec.z);
    pivot.rotation.set(spec.tiltX, 0, spec.tiltZ);
    galaxies.set(spec.key, { key: spec.key, pivot, radius: spec.radius });
  }
  const sky = new BABYLON.TransformNode('sky_0', scene);
  const view = { scene, camera, canvas, gui: null, store: { projects: new Map() }, glyphs: new Map(), galaxies,
    sky, skyRadius: SKY_RADIUS, defaultPanelRoom: () => ({ ...ROOM }) };
  const part = window.AUR.sceneParts.universe.galaxies(view);
  // The view's resize hook, then a frame: the camera's position follows its angles and radius.
  const resize = () => { part.reframeCamera(); scene.render(); };
  const state = () => ({ alpha: camera.alpha, beta: camera.beta, radius: camera.radius, target: camera.target.asArray() });
  // Where a world point lands on the canvas, in CSS px.
  const onScreen = (point) => {
    scene.render();
    const { clientWidth: w, clientHeight: h } = canvas;
    return BABYLON.Vector3.Project(point, BABYLON.Matrix.Identity(), scene.getTransformMatrix(), new BABYLON.Viewport(0, 0, w, h));
  };
  return { camera, part, resize, state, scene, sky, galaxies, onScreen };
}

// The clear area the panels leave at their default sizes, as the fit should take it.
function defaultClearArea({ clientWidth: w, clientHeight: h }) {
  const top = 48 + GAP;
  return { left: ROOM.left + GAP, right: w - ROOM.right - GAP, top, bottom: h - ROOM.bottom - GAP };
}

test('galaxies: resizing, folding, hiding or opening a panel never moves or scales the map', () => {
  const chrome = page();
  const map = universe(chrome);
  map.part.frameCamera();
  map.scene.render();
  const framed = map.state();
  for (const layout of [{ right: 819 }, { left: 560, right: 819 }, { right: 0 }, { left: 300, right: 56 }, { timeline: false }, {}]) {
    chrome.layout(layout);
    map.resize();
    assert.deepEqual(map.state(), framed, 'after ' + JSON.stringify(layout));
  }
});

test('galaxies: a view built while other panels show frames as the first one did', () => {
  const first = universe(page());
  first.part.frameCamera();
  first.scene.render();
  // Back from a system: the universe builds while that view's left rail still shows, then the
  // chrome swaps and the observer re-fits.
  const chrome = page();
  chrome.layout({ left: 420, right: 819 });
  const again = universe(chrome);
  again.part.frameCamera();
  again.scene.render();
  chrome.layout();
  again.resize();
  assert.deepEqual(again.state(), first.state());
});

test('galaxies: a canvas with no room yet, once it has its size, frames as a first load does', () => {
  const first = universe(page());
  first.part.frameCamera();
  first.scene.render();
  const chrome = page(1666, 0); // the window still opening
  const map = universe(chrome);
  map.part.frameCamera();
  map.scene.render();
  assert.deepEqual([map.camera.alpha, map.camera.beta], [-Math.PI / 2, 0.82], 'the early fit keeps the angles');
  Object.assign(chrome.canvas, { clientHeight: 944 });
  chrome.layout();
  map.resize();
  assert.deepEqual(map.state(), first.state());
});

test('galaxies: the map centres on the area the default panels leave clear', () => {
  for (const [w, h] of [[1666, 944], [1186, 684]]) {
    const chrome = page(w, h);
    chrome.layout({ left: 560, right: 819, timeline: false }); // what the panels do now does not count
    const map = universe(chrome);
    map.part.frameCamera();
    const box = { min: new BABYLON.Vector3(Infinity, Infinity, Infinity), max: new BABYLON.Vector3(-Infinity, -Infinity, -Infinity) };
    for (const g of map.galaxies.values()) {
      const world = g.pivot.computeWorldMatrix(true);
      for (const [x, z] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const corner = BABYLON.Vector3.TransformCoordinates(new BABYLON.Vector3(x * g.radius, 0, z * g.radius), world);
        box.min.minimizeInPlace(corner);
        box.max.maximizeInPlace(corner);
      }
    }
    const centre = map.onScreen(new BABYLON.Vector3((box.min.x + box.max.x) / 2, 0, (box.min.z + box.max.z) / 2));
    const clear = defaultClearArea(chrome.canvas);
    // Within a little: the shift is worked out at the target's depth, and the centre sits nearer.
    const off = [centre.x - (clear.left + clear.right) / 2, centre.y - (clear.top + clear.bottom) / 2];
    assert.ok(Math.abs(off[0]) < 4 && Math.abs(off[1]) < 4, `${w}x${h}: the centre is ${off.map((v) => v.toFixed(1))} px off`);
  }
});

test('galaxies: at the smallest canvas no sun starts under either default rail or the timeline', () => {
  for (const count of [10, 30, 60]) {
    const projects = Array.from({ length: count }, (_, i) => ({ id: 'p' + i, galaxy: { key: 'g' + i, label: 'G' + i } }));
    const layout = LAYOUT.layoutGalaxyProjects(projects);
    const chrome = page(1186, 684); // the 1200 × 720 minimum window, less its frame
    const map = universe(chrome, layout.galaxies);
    map.part.frameCamera();
    const clear = defaultClearArea(chrome.canvas);
    for (const p of layout.projects) {
      const world = map.galaxies.get(p.galaxyKey).pivot.computeWorldMatrix(true);
      const sun = map.onScreen(BABYLON.Vector3.TransformCoordinates(new BABYLON.Vector3(p.localX, p.localY, p.localZ), world));
      assert.ok(sun.x > clear.left && sun.x < clear.right && sun.y > clear.top && sun.y < clear.bottom,
        `${count} galaxies: ${p.id} at ${sun.x.toFixed(0)}, ${sun.y.toFixed(0)} is outside ${JSON.stringify(clear)}`);
    }
  }
});

test('galaxies: a window resize re-fits, and the first size frames as before', () => {
  const chrome = page();
  const map = universe(chrome);
  map.part.frameCamera();
  map.scene.render();
  const framed = map.state();
  Object.assign(chrome.canvas, { clientWidth: 900, clientHeight: 700 });
  chrome.layout();
  map.resize();
  assert.ok(map.state().radius > framed.radius, 'a narrower window pulls the camera back');
  Object.assign(chrome.canvas, { clientWidth: 1666, clientHeight: 944 });
  chrome.layout();
  map.resize();
  assert.deepEqual(map.state(), framed);
});

test('galaxies: zoomed all the way out and panned to the edge, the camera stays inside the sky dome', () => {
  for (const [spread, grows] of [[1, false], [4, true], [8, true]]) {
    for (const right of [312, 1100]) {
      const chrome = page();
      chrome.layout({ right });
      const { camera, part, sky } = universe(chrome, small(spread));
      part.frameCamera();
      const reach = camera.panningOriginTarget.length() + camera.panningDistanceLimit + camera.upperRadiusLimit;
      const scale = sky.scaling.x;
      assert.ok(reach < SKY_RADIUS * scale, `spread ${spread}, rail ${right}: the camera can reach ${reach.toFixed(1)}, the dome is ${SKY_RADIUS * scale}`);
      assert.deepEqual(sky.scaling.asArray(), [scale, scale, scale]);
      assert.equal(scale > 1, grows, `spread ${spread}: the dome ${grows ? 'grows' : 'keeps its size'}`);
      assert.ok(reach + SKY_RADIUS * scale < camera.maxZ, `spread ${spread}: this layout's dome stays within the camera's far plane`);
    }
  }
});

test('galaxies: the view hands the framing its sky dome, the dome\'s size and the default panel room', () => {
  const source = readRenderer('scene/universe/view.js');
  assert.match(source, /const UNIVERSE_SKY_SIZE = 1600;/);
  assert.match(source, /const sky = AUR\.addSkybox\(scene, 0, UNIVERSE_SKY_SIZE,/);
  assert.match(source, /\bsky, skyRadius: UNIVERSE_SKY_SIZE \/ 2, defaultPanelRoom: ctx\.defaultPanelRoom/);
  assert.match(readRenderer('app/boot.js'), /defaultPanelRoom: A\.defaultPanelRoom/);
});

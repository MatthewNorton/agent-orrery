'use strict';

// The universe map's camera framing (src/renderer/scene/universe/galaxies.js) on Babylon's own
// ArcRotateCamera: the fit ignores the side rails and the timeline, gives the same camera however
// often it runs, still follows the window, and grows the sky dome so the camera never leaves it.

const assert = require('node:assert/strict');
const test = require('node:test');
const BABYLON = require('babylonjs');
const { fakeDocument } = require('./support/fake-dom');
const { readRenderer, runRenderer } = require('./support/renderer-source');

BABYLON.Logger.LogLevels = BABYLON.Logger.NoneLogLevel;

const SKY_RADIUS = 800; // scene/universe/view.js: a dome 1600 across

// The page's chrome as boxes: the top bar, the two rails and the timeline, on a canvas of the
// window's size. `layout` changes them; a rail or the timeline with `hidden: true` is off screen.
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

// A universe view's camera as scene/universe/view.js makes it, over three galaxies spread like a
// small profile's (or `spread` times as far apart), with the galaxies part's framing.
function universe({ document, canvas }, spread = 1) {
  const window = {};
  runRenderer('util.js', { window, document, getComputedStyle: () => ({ display: 'block' }) });
  runRenderer('scene/common.js', { window, document, BABYLON });
  runRenderer('scene/universe/galaxies.js', { window, document, BABYLON });
  const scene = new BABYLON.Scene(new BABYLON.NullEngine());
  const camera = new BABYLON.ArcRotateCamera('ucam', -Math.PI / 2, 0.82, 175, BABYLON.Vector3.Zero(), scene);
  Object.assign(camera, { minZ: 0.1, maxZ: 6000, lowerRadiusLimit: 60, upperRadiusLimit: 320,
    lowerBetaLimit: 0.15, upperBetaLimit: 1.35, mapPanning: true });
  const galaxies = new Map();
  for (const [key, x, y, z, radius, tiltX, tiltZ] of [
    ['work', 0, 0, 0, 44, 0.12, -0.08], ['personal', 96, 6, 30, 34, -0.1, 0.14], ['open-source', 20, -5, -86, 30, 0.2, 0.05],
  ]) {
    const pivot = new BABYLON.TransformNode('galaxy:' + key, scene);
    pivot.position.set(x * spread, y, z * spread);
    pivot.rotation.set(tiltX, 0, tiltZ);
    galaxies.set(key, { key, pivot, radius });
  }
  const sky = new BABYLON.TransformNode('sky_0', scene);
  const view = { scene, camera, canvas, gui: null, store: { projects: new Map() }, glyphs: new Map(), galaxies, sky, skyRadius: SKY_RADIUS };
  const part = window.AUR.sceneParts.universe.galaxies(view);
  // The view's resize hook, then a frame: the camera's position follows its angles and radius.
  const resize = () => { part.reframeCamera(); scene.render(); };
  const state = () => ({ alpha: camera.alpha, beta: camera.beta, radius: camera.radius, target: camera.target.asArray() });
  return { camera, part, resize, state, scene, sky };
}

test('galaxies: the side rails and the timeline never move or scale the map', () => {
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
      const { camera, part, sky } = universe(chrome, spread);
      part.frameCamera();
      const reach = camera.panningOriginTarget.length() + camera.panningDistanceLimit + camera.upperRadiusLimit;
      const scale = sky.scaling.x;
      assert.ok(reach < SKY_RADIUS * scale, `spread ${spread}, rail ${right}: the camera can reach ${reach.toFixed(1)}, the dome is ${SKY_RADIUS * scale}`);
      assert.deepEqual(sky.scaling.asArray(), [scale, scale, scale]);
      assert.equal(scale > 1, grows, `spread ${spread}: the dome ${grows ? 'grows' : 'keeps its size'}`);
      assert.ok(reach + SKY_RADIUS * scale < camera.maxZ, 'the far side of the dome is drawn');
    }
  }
});

test('galaxies: the view hands the framing its sky dome and the dome\'s size', () => {
  const source = readRenderer('scene/universe/view.js');
  assert.match(source, /const UNIVERSE_SKY_SIZE = 1600;/);
  assert.match(source, /const sky = AUR\.addSkybox\(scene, 0, UNIVERSE_SKY_SIZE,/);
  assert.match(source, /\bsky, skyRadius: UNIVERSE_SKY_SIZE \/ 2/);
});

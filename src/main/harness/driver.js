// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createDriver(ctx) {
  const pointerInputEvents = [];

  async function rendererEval(source) {
    return ctx.win.webContents.executeJavaScript(source, true);
  }

  async function readViewState() {
    return rendererEval(`(() => {
      const scene = BABYLON.EngineStore.LastCreatedScene;
      const camera = scene && scene.activeCamera;
      const cameraName = camera ? camera.name : null;
      const byCamera = { ucam: 'universe', scam: 'system', pcam: 'planet' };
      const shown = (id) => {
        const el = document.getElementById(id);
        return Boolean(el && !el.classList.contains('hidden') && getComputedStyle(el).display !== 'none');
      };
      const engines = BABYLON.EngineStore.Instances || [];
      let liveScenes = 0;
      for (const engine of engines) {
        for (const item of engine.scenes || []) if (!item.isDisposed) liveScenes++;
      }
      return {
        view: (scene && scene.metadata && scene.metadata.view) || byCamera[cameraName] || null,
        camera: cameraName,
        summary: document.querySelector('#summary-card .mod-title')?.textContent || '',
        projectCard: document.getElementById('project-card')?.textContent || '',
        planetCard: document.getElementById('planet-card')?.textContent || '',
        backText: document.getElementById('back-btn')?.textContent || '',
        backVisible: shown('back-btn'),
        tabbarVisible: shown('tabbar'),
        liveScenes,
      };
    })()`);
  }

  async function waitForView(expected, timeoutMs = 10_000) {
    const until = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < until) {
      try { last = await readViewState(); } catch { /* renderer is still booting */ }
      if (last && last.view === expected && last.liveScenes === 1) return last;
      await wait(100);
    }
    throw new Error(`timed out waiting for ${expected}; last=${JSON.stringify(last)}`);
  }

  async function readPolishStats() {
    return rendererEval(`(() => {
      const scene = BABYLON.EngineStore.LastCreatedScene;
      if (!scene || !scene.metadata || typeof scene.metadata.polishStats !== 'function') return null;
      return scene.metadata.polishStats();
    })()`);
  }

  async function findCanvasTarget(kind, preferHidden, requiredId) {
    return rendererEval(`(() => {
      const kind = ${JSON.stringify(kind)};
      const preferHidden = ${preferHidden ? 'true' : 'false'};
      const requiredId = ${JSON.stringify(requiredId || null)};
      const scene = BABYLON.EngineStore.LastCreatedScene;
      if (!scene || !scene.activeCamera) return null;
      const engine = scene.getEngine();
      const canvas = engine.getRenderingCanvas();
      const rect = canvas.getBoundingClientRect();
      const viewport = scene.activeCamera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight());
      const stats = scene.metadata && typeof scene.metadata.polishStats === 'function'
        ? scene.metadata.polishStats() : null;
      const labelById = new Map(((stats && stats.labels) || []).map((item) => [item.id, item]));
      const matches = scene.meshes.filter((mesh) => mesh.metadata &&
        (kind === 'sun' ? mesh.metadata.isSun : mesh.metadata.isPlanet));
      const choices = [];
      for (const mesh of matches) {
        mesh.computeWorldMatrix(true);
        const center = mesh.getBoundingInfo().boundingSphere.centerWorld;
        const p = BABYLON.Vector3.Project(center, BABYLON.Matrix.IdentityReadOnly,
          scene.getTransformMatrix(), viewport);
        const x = Math.round(rect.left + p.x * rect.width / engine.getRenderWidth());
        const y = Math.round(rect.top + p.y * rect.height / engine.getRenderHeight());
        if (p.z < 0 || p.z > 1 || x < rect.left || y < rect.top || x >= rect.right || y >= rect.bottom) continue;
        if (document.elementFromPoint(x, y) !== canvas) continue;
        const id = kind === 'sun' ? mesh.metadata.projectId : mesh.metadata.planetName;
        if (requiredId != null && id !== requiredId) continue;
        const label = labelById.get(id);
        choices.push({
          id, meshName: mesh.name, x, y,
          available: kind !== 'sun' || mesh.metadata.projectExists !== false,
          hiddenLabel: Boolean(label && !label.visible),
          centerDistance: Math.hypot(x - rect.width * 0.52, y - rect.height * 0.48),
        });
      }
      choices.sort((a, b) => {
        if (a.available !== b.available) return a.available ? -1 : 1;
        if (preferHidden && a.hiddenLabel !== b.hiddenLabel) return a.hiddenLabel ? -1 : 1;
        return a.centerDistance - b.centerDistance || String(a.id).localeCompare(String(b.id));
      });
      return choices[0] || null;
    })()`);
  }

  async function validatePointerPick(target, kind) {
    sendTestInput({ type: 'mouseMove', x: target.x, y: target.y });
    await wait(90);
    return rendererEval(`(() => {
      const scene = BABYLON.EngineStore.LastCreatedScene;
      // Match the production POINTERPICK path exactly: no predicate may see
      // through an occluding pickable mesh.
      const pick = scene && scene.pick(scene.pointerX, scene.pointerY);
      if (!pick || !pick.hit || !pick.pickedMesh) return null;
      const metadata = pick.pickedMesh.metadata;
      if (!metadata || !(${JSON.stringify(kind)} === 'sun' ? metadata.isSun : metadata.isPlanet)) return null;
      return {
        meshName: pick.pickedMesh.name,
        id: ${JSON.stringify(kind)} === 'sun' ? metadata.projectId : metadata.planetName,
      };
    })()`);
  }

  async function acquirePointerTarget(kind, preferHidden, requiredId) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const target = await findCanvasTarget(kind, preferHidden, requiredId);
      if (target) {
        const picked = await validatePointerPick(target, kind);
        if (picked && picked.id === target.id) return { ...target, picked };
      }
      await wait(80);
    }
    throw new Error(`could not validate a ${kind} pointer target`);
  }

  function sendTestInput(event) {
    if (!ctx.flags.polishTest && !ctx.flags.historyTest && !ctx.flags.controlTest) {
      throw new Error('test input attempted outside an input test mode');
    }
    pointerInputEvents.push({
      type: event.type,
      x: event.x,
      y: event.y,
      button: event.button || null,
      clickCount: event.clickCount || null,
      deltaX: event.deltaX || null,
      deltaY: event.deltaY || null,
    });
    ctx.win.webContents.sendInputEvent(event);
  }

  function clickPoint(point) {
    const start = pointerInputEvents.length;
    sendTestInput({ type: 'mouseMove', x: point.x, y: point.y });
    sendTestInput({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    sendTestInput({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    return { start, end: pointerInputEvents.length, x: point.x, y: point.y };
  }

  // Screenshot-capture path: real input events, but outside the proof-recording
  // test modes, so it must not go through sendTestInput (which throws there).
  async function screenshotClick(selector) {
    const point = await elementCenter(selector);
    if (!point) return false;
    ctx.win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
    ctx.win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    ctx.win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    return true;
  }

  async function elementCenter(selector) {
    return rendererEval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el || getComputedStyle(el).display === 'none') return null;
      const rect = el.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), text: el.textContent };
    })()`);
  }

  async function capture(outDir, name) {
    await wait(350);
    const image = await ctx.win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, `${name}.png`), image.toPNG());
    return image;
  }

  function percentile(sorted, fraction) {
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
  }

  function backdropLuma(image) {
    const size = image.getSize();
    const bitmap = image.toBitmap();
    const values = [];
    const x0 = Math.floor(size.width * 0.22);
    const x1 = Math.floor(size.width * 0.72);
    const y0 = Math.floor(size.height * 0.09);
    const y1 = Math.floor(size.height * 0.82);
    for (let y = y0; y < y1; y += 5) {
      for (let x = x0; x < x1; x += 5) {
        const offset = (y * size.width + x) * 4;
        const b = bitmap[offset];
        const g = bitmap[offset + 1];
        const r = bitmap[offset + 2];
        values.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
      }
    }
    values.sort((a, b) => a - b);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    const round = (value) => Math.round(value * 10) / 10;
    return {
      mean: round(mean), median: round(percentile(values, 0.5)),
      p90: round(percentile(values, 0.9)), p99: round(percentile(values, 0.99)),
      stddev: round(Math.sqrt(variance)), samples: values.length,
    };
  }

  async function exerciseCamera() {
    const point = await rendererEval(`(() => {
      const canvas = document.getElementById('renderCanvas');
      const rect = canvas.getBoundingClientRect();
      const options = [[0.42, 0.2], [0.5, 0.18], [0.36, 0.28]];
      for (const [fx, fy] of options) {
        const x = Math.round(rect.left + rect.width * fx);
        const y = Math.round(rect.top + rect.height * fy);
        if (document.elementFromPoint(x, y) === canvas) return { x, y };
      }
      return null;
    })()`);
    if (!point) throw new Error('no clear canvas point for camera input');
    sendTestInput({ type: 'mouseMove', x: point.x, y: point.y });
    sendTestInput({ type: 'mouseWheel', x: point.x, y: point.y, deltaY: 120, deltaX: 0, canScroll: true });
    sendTestInput({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    sendTestInput({ type: 'mouseMove', x: point.x + 70, y: point.y + 24, movementX: 70, movementY: 24 });
    sendTestInput({ type: 'mouseUp', x: point.x + 70, y: point.y + 24, button: 'left', clickCount: 1 });
    await wait(900);
  }

  return {
    rendererEval,
    readViewState,
    waitForView,
    readPolishStats,
    findCanvasTarget,
    validatePointerPick,
    acquirePointerTarget,
    sendTestInput,
    clickPoint,
    screenshotClick,
    elementCenter,
    capture,
    percentile,
    backdropLuma,
    exerciseCamera,
    pointerInputEvents,
  };
}

module.exports = { createDriver, wait };

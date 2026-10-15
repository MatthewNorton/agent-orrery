// @ts-check
'use strict';

const { app, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

// --shots: cycle the three views, capture each to .shots/, then exit.
// Used for automated visual verification.
async function runShotMode(ctx, driver) {
  const { rendererEval, screenshotClick } = driver;
  const outDir = path.join(__dirname, '..', '..', '..', '..', '.shots');
  fs.mkdirSync(outDir, { recursive: true });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(4000);
  let leftRailState = null;
  for (const view of ['universe', 'system', 'planet']) {
    const ready = new Promise((resolve) => ipcMain.once('au:debug-ready', resolve));
    ctx.win.webContents.send('au:debug-view', view);
    await ready;
    await wait(1800);
    const img = await ctx.win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, `shot-${view}.png`), img.toPNG());
    console.log(`captured ${view}`);
    if (view === 'planet') {
      // Every left-rail module folds to its header from its chevron, and unfolds again.
      const folded = await rendererEval(`(() => {
        const sections = Array.from(document.querySelectorAll('.rail--l .mod[data-module]:not(.hidden)'));
        for (const section of sections) section.querySelector('.mod-h .mod-x')?.click();
        const headerH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-h'));
        return {
          modules: sections.map((section) => section.dataset.module),
          folded: sections.length > 0 && sections.every((section) => section.classList.contains('is-collapsed') &&
            Math.abs(section.getBoundingClientRect().height - headerH) <= 3),
        };
      })()`);
      await wait(350);
      const foldedImage = await ctx.win.webContents.capturePage();
      fs.writeFileSync(path.join(outDir, 'shot-left-rail-folded.png'), foldedImage.toPNG());
      console.log('captured left rail folded');
      const unfolded = await rendererEval(`(() => {
        for (const section of document.querySelectorAll('.rail--l .mod.is-collapsed')) {
          section.querySelector('.mod-h .mod-x')?.click();
        }
        return document.querySelectorAll('.rail--l .mod.is-collapsed').length === 0;
      })()`);
      leftRailState = { ...folded, unfolded };
    }
    if (view === 'system') {
      const asteroidPreview = await rendererEval(`(() => {
        const scene = BABYLON.EngineStore.LastCreatedScene;
        const camera = scene && scene.activeCamera;
        if (!scene || !camera || !window.AUR) return false;
        for (const mesh of scene.meshes) mesh.setEnabled(false);
        const asteroid = AUR.createAsteroidMesh(scene, 'asteroid-visual-proof', 0xa57e10d, 1);
        const material = new BABYLON.StandardMaterial('asteroid-visual-proof-material', scene);
        AUR.applyAsteroidSurface(scene, material, 1);
        asteroid.material = material;
        asteroid.rotation.set(0.34, -0.62, 0.18);
        asteroid.setEnabled(true);
        const proofLight = new BABYLON.DirectionalLight(
          'asteroid-visual-proof-light', new BABYLON.Vector3(0.6, -0.45, 0.8), scene);
        proofLight.intensity = 2.4;
        camera.setTarget(BABYLON.Vector3.Zero());
        camera.lowerRadiusLimit = 1.8;
        camera.radius = 2.65;
        return true;
      })()`);
      if (asteroidPreview) {
        await wait(650);
        const asteroidImage = await ctx.win.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, 'shot-asteroid.png'), asteroidImage.toPNG());
        console.log('captured asteroid close-up');
      }
    }
  }

  const directoryReady = new Promise((resolve) => ipcMain.once('au:debug-ready', resolve));
  ctx.win.webContents.send('au:debug-view', 'universe');
  await directoryReady;
  await wait(500);
  await screenshotClick('#command-rail-toggle');
  await wait(200);
  const compactRailState = await rendererEval(`(() => {
    const rail = document.getElementById('sidebar');
    return {
      compact: Boolean(rail && rail.classList.contains('compact')),
      compactButtons: document.querySelectorAll('.compact-rail-button').length,
    };
  })()`);
  await wait(350);
  const compactRailImage = await ctx.win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, 'shot-command-rail-compact.png'), compactRailImage.toPNG());
  console.log('captured command rail compact');
  const railStillCompact = await rendererEval(`(() => {
    const rail = document.getElementById('sidebar');
    return Boolean(rail && rail.classList.contains('compact'));
  })()`);
  if (railStillCompact) await screenshotClick('#command-rail-toggle');
  await wait(350);

  await screenshotClick('#project-directory-button');
  await wait(200);
  const directoryState = await rendererEval(`(() => {
    const panel = document.getElementById('project-directory');
    return {
      open: Boolean(panel && !panel.classList.contains('hidden')),
      projectCount: document.querySelectorAll('.project-directory-row').length,
      selectedCount: document.querySelectorAll('.project-directory-row.selected').length,
    };
  })()`);
  await wait(350);
  const directoryImage = await ctx.win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, 'shot-projects.png'), directoryImage.toPNG());
  console.log('captured projects');
  await rendererEval(`(() => {
    const input = document.getElementById('project-directory-input');
    if (!input) return;
    input.value = 'agent-universe';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await wait(250);
  const directorySearchState = await rendererEval(`(() => ({
    query: document.getElementById('project-directory-input')?.value || '',
    resultCount: document.querySelectorAll('.project-directory-row').length,
    resultNames: Array.from(document.querySelectorAll('.project-directory-name'))
      .map((element) => element.textContent),
  }))()`);
  await screenshotClick('#project-directory-close');
  fs.writeFileSync(
    path.join(outDir, 'ux-state.json'),
    JSON.stringify({
      directory: directoryState,
      directorySearch: directorySearchState,
      commandRail: compactRailState,
      leftRail: leftRailState,
    }, null, 2)
  );
  fs.writeFileSync(path.join(outDir, 'state.json'), JSON.stringify(ctx.tracker.snapshot(), null, 2));
  app.quit();
}

module.exports = { run: runShotMode };

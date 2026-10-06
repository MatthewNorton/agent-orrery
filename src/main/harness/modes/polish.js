'use strict';

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { wait } = require('../driver');

async function runPolishMode(ctx, driver) {
  const {
    waitForView, readPolishStats, acquirePointerTarget, clickPoint, elementCenter, capture,
    backdropLuma, exerciseCamera,
  } = driver;
  fs.mkdirSync(ctx.flags.outputs.polish, { recursive: true });
  const result = {
    schemaVersion: 1,
    passed: false,
    views: [],
    steps: [],
    projectId: null,
    planetName: null,
    openedProjectId: null,
    labelMetrics: null,
    galaxyMetrics: null,
    backdropMetrics: null,
  };
  try {
    const universe = await waitForView('universe');
    if (universe.camera !== 'ucam' || universe.backVisible || universe.summary !== 'UNIVERSE SUMMARY') {
      throw new Error(`bad universe chrome: ${JSON.stringify(universe)}`);
    }
    result.views.push('universe');
    await wait(1200);
    const initialLabels = await readPolishStats();
    result.galaxyMetrics = initialLabels && initialLabels.galaxyMetrics
      ? initialLabels.galaxyMetrics : null;
    const universeImage = await capture(ctx.flags.outputs.polish, 'universe');
    result.backdropMetrics = backdropLuma(universeImage);

    const hoverTarget = await acquirePointerTarget('sun', true);
    const initiallyHidden = initialLabels.labels.some((label) => label.id === hoverTarget.id && !label.visible);
    await wait(180);
    const hoveredLabels = await readPolishStats();
    const hoverVisible = hoveredLabels.labels.some((label) => label.id === hoverTarget.id && label.visible);
    await capture(ctx.flags.outputs.polish, 'hover');
    await exerciseCamera();
    const cameraLabels = await readPolishStats();
    await capture(ctx.flags.outputs.polish, 'camera');
    result.labelMetrics = {
      glyphCount: initialLabels.glyphCount,
      totalLabels: initialLabels.totalLabels,
      pickableSunCount: initialLabels.pickableSunCount,
      labelControlCount: initialLabels.labelControlCount,
      visibleLabels: initialLabels.visibleLabels,
      hiddenLabels: initialLabels.hiddenLabels,
      overlaps: initialLabels.overlaps,
      afterHoverOverlaps: hoveredLabels.overlaps,
      afterCameraOverlaps: cameraLabels.overlaps,
      measuredLabelCount: initialLabels.measuredLabelCount,
      measuredOverlaps: initialLabels.measuredOverlaps,
      measuredChromeOcclusions: initialLabels.measuredChromeOcclusions,
      afterHoverMeasuredOverlaps: hoveredLabels.measuredOverlaps,
      afterHoverChromeOcclusions: hoveredLabels.measuredChromeOcclusions,
      afterCameraMeasuredOverlaps: cameraLabels.measuredOverlaps,
      afterCameraChromeOcclusions: cameraLabels.measuredChromeOcclusions,
      hoverReveal: initiallyHidden && hoverVisible,
      hoverProjectId: hoverTarget.id,
      finiteProjections: initialLabels.finiteProjections,
    };

    const sunTarget = await acquirePointerTarget('sun', false, hoverTarget.id);
    result.projectId = sunTarget.id;
    const sunInput = clickPoint(sunTarget);
    const system = await waitForView('system');
    if (system.camera !== 'scam' || !system.backVisible || system.backText !== '← Universe' ||
        system.summary !== 'PROJECT SUMMARY' || !system.projectCard.includes('PROJECT:')) {
      throw new Error(`bad system chrome: ${JSON.stringify(system)}`);
    }
    result.views.push('system');
    result.steps.push({ action: 'canvas-sun-click', input: sunInput, pickValidated: true, from: 'universe', to: 'system', id: sunTarget.id });
    result.systemColorMetrics = await readPolishStats();
    await capture(ctx.flags.outputs.polish, 'system');

    const openFolder = await elementCenter('#project-card .pc-btn');
    if (!openFolder) throw new Error('Open Folder button missing');
    result.openFolderInput = clickPoint(openFolder);
    const openUntil = Date.now() + 2000;
    while (Date.now() < openUntil && ctx.harness.openedProjects[ctx.harness.openedProjects.length - 1] !== result.projectId) await wait(40);
    result.openedProjectId = ctx.harness.openedProjects[ctx.harness.openedProjects.length - 1] || null;

    const planetTarget = await acquirePointerTarget('planet', false);
    result.planetName = planetTarget.id;
    const planetInput = clickPoint(planetTarget);
    const planet = await waitForView('planet');
    if (planet.camera !== 'pcam' || !planet.backVisible || !planet.tabbarVisible ||
        planet.summary !== 'PLANET SUMMARY' || !planet.planetCard.includes('PLANET:')) {
      throw new Error(`bad planet chrome: ${JSON.stringify(planet)}`);
    }
    result.views.push('planet');
    result.steps.push({ action: 'canvas-planet-click', input: planetInput, pickValidated: true, from: 'system', to: 'planet', id: planetTarget.id });
    await capture(ctx.flags.outputs.polish, 'planet');

    const backToSystem = await elementCenter('#back-btn');
    if (!backToSystem) throw new Error('planet Back button missing');
    const backSystemInput = clickPoint(backToSystem);
    const systemAgain = await waitForView('system');
    if (systemAgain.summary !== 'PROJECT SUMMARY' || systemAgain.backText !== '← Universe') {
      throw new Error(`bad returned system chrome: ${JSON.stringify(systemAgain)}`);
    }
    result.views.push('system');
    result.steps.push({ action: 'back-button-click', input: backSystemInput, from: 'planet', to: 'system' });
    await capture(ctx.flags.outputs.polish, 'back-system');

    const backToUniverse = await elementCenter('#back-btn');
    if (!backToUniverse) throw new Error('system Back button missing');
    const backUniverseInput = clickPoint(backToUniverse);
    const universeAgain = await waitForView('universe');
    if (universeAgain.backVisible || universeAgain.summary !== 'UNIVERSE SUMMARY') {
      throw new Error(`bad returned universe chrome: ${JSON.stringify(universeAgain)}`);
    }
    result.views.push('universe');
    result.steps.push({ action: 'back-button-click', input: backUniverseInput, from: 'system', to: 'universe' });
    await capture(ctx.flags.outputs.polish, 'back-universe');

    if (ctx.harness.rendererTestErrors.length) throw new Error(`renderer errors: ${ctx.harness.rendererTestErrors.join(' | ')}`);
    if (result.openedProjectId !== result.projectId) throw new Error('Open Folder project id mismatch');
    result.passed = true;
  } catch (error) {
    result.error = error && error.stack ? error.stack : String(error);
    console.error(`[polish-test] ${result.error}`);
  } finally {
    result.rendererErrors = ctx.harness.rendererTestErrors;
    result.inputEvents = driver.pointerInputEvents;
    fs.writeFileSync(path.join(ctx.flags.outputs.polish, 'result.json'), JSON.stringify(result, null, 2));
    if (result.passed) app.quit();
    else app.exit(1);
  }
}

module.exports = { run: runPolishMode };

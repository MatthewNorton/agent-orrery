// @ts-check
'use strict';

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { wait } = require('../driver');

// Every provider the fixture shows: three hull providers and the Signal marker.
const HULL_PROVIDERS = ['claude', 'codex', 'local'];
const PROVIDERS = [...HULL_PROVIDERS, 'generic'];
const TAGS = ['CLAUDE', 'CODEX', 'LOCAL', 'SIGNAL'];

async function runProviderMode(ctx, driver) {
  const { rendererEval, waitForView, capture } = driver;
  fs.mkdirSync(ctx.flags.outputs.provider, { recursive: true });
  const result = { schemaVersion: 1, passed: false, rendererErrors: ctx.harness.rendererTestErrors };
  try {
    await waitForView('universe');
    let dom = null;
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      dom = await rendererEval(`(() => ({
        badgeText: document.querySelector('.brand-badge')?.textContent?.trim() || '',
        tags: Array.from(document.querySelectorAll('.agent-provider-tag')).map((el) => el.textContent.trim()),
        modelTags: Array.from(document.querySelectorAll('.agent-model-tag')).map((el) => el.textContent.trim()),
        attentionTagCount: document.querySelectorAll('.agent-row.has-attention .agent-provider-tag').length,
        rows: Array.from(document.querySelectorAll('.agent-row')).map((el) => ({
          shipId: el.dataset.shipId || '', provider: el.dataset.provider || ''
        })),
        stats: (() => {
          const scene = BABYLON.EngineStore.LastCreatedScene;
          return scene?.metadata?.providerStats ? scene.metadata.providerStats() : null;
        })(),
        visuals: (() => {
          const scene = BABYLON.EngineStore.LastCreatedScene;
          return (scene?.meshes || []).filter((mesh) => mesh.metadata?.isShip === true).map((mesh) => ({
            shipId: mesh.metadata.shipId || '',
            providerKey: mesh.metadata.providerKey || '',
            assetHullId: mesh.metadata.assetHullId || null,
            visualKind: mesh.metadata.visualKind || null,
          }));
        })()
      }))()`);
      const physicalReady = HULL_PROVIDERS.every((key) =>
        dom?.visuals?.some((visual) => visual.providerKey === key && visual.assetHullId));
      const signalReady = dom?.visuals?.some((visual) =>
        visual.providerKey === 'generic' && visual.visualKind === 'signal-marker' && !visual.assetHullId);
      if (dom && dom.tags.length >= PROVIDERS.length && dom.stats && dom.stats.shipMeshCount >= PROVIDERS.length &&
          physicalReady && signalReady) break;
      await wait(100);
    }
    const snapshot = ctx.tracker.snapshot();
    const publicProviderCounts = Object.fromEntries(PROVIDERS.map((key) => [key, 0]));
    for (const ship of snapshot.ships) {
      if (Object.hasOwn(publicProviderCounts, ship.provider)) publicProviderCounts[ship.provider]++;
    }
    const meshProviderCounts = dom?.stats?.providerCounts || {};
    result.badgeText = dom?.badgeText || '';
    result.sidebarProviderTags = dom?.tags || [];
    result.providerMetrics = {
      publicProviderCounts,
      meshProviderCounts,
      distinctProviderColors: dom?.stats?.distinctColorCount || 0,
      sidebarProviderTags: result.sidebarProviderTags,
      rows: dom?.rows || [],
      visuals: dom?.visuals || [],
      modelTags: dom?.modelTags || [],
      attentionProviderTagCount: dom?.attentionTagCount || 0,
      scene: dom?.stats || null,
    };
    await capture(ctx.flags.outputs.provider, 'universe');
    const rowCounts = Object.fromEntries(PROVIDERS.map((key) => [key, 0]));
    for (const row of dom?.rows || []) {
      if (Object.hasOwn(rowCounts, row.provider)) rowCounts[row.provider]++;
    }
    result.providerMetrics.rowProviderCounts = rowCounts;
    const physicalModelsReady = HULL_PROVIDERS.every((key) =>
      result.providerMetrics.visuals.some((visual) => visual.providerKey === key && visual.assetHullId));
    const signalMarkerReady = result.providerMetrics.visuals.some((visual) =>
      visual.providerKey === 'generic' && visual.visualKind === 'signal-marker' && !visual.assetHullId);
    result.passed = result.badgeText === 'MULTI-PROVIDER' &&
      PROVIDERS.every((key) =>
        publicProviderCounts[key] >= 1 && meshProviderCounts[key] >= 1 && rowCounts[key] >= 1) &&
      TAGS.every((label) => result.sidebarProviderTags.includes(label)) &&
      result.providerMetrics.modelTags.includes('fixture-local:7b') &&
      result.providerMetrics.attentionProviderTagCount >= 1 &&
      result.providerMetrics.distinctProviderColors >= PROVIDERS.length &&
      physicalModelsReady && signalMarkerReady &&
      dom?.stats?.colorMismatchCount === 0 && ctx.harness.rendererTestErrors.length === 0;
    if (!result.passed) throw new Error('provider fixture metrics did not satisfy the rendered contract');
  } catch (error) {
    result.error = error && error.stack ? error.stack : String(error);
    console.error(`[provider-test] ${result.error}`);
  } finally {
    result.rendererErrors = ctx.harness.rendererTestErrors.slice();
    fs.writeFileSync(path.join(ctx.flags.outputs.provider, 'result.json'), JSON.stringify(result, null, 2));
    if (result.passed) app.quit();
    else {
      ctx.cleanup();
      app.exit(1);
    }
  }
}

module.exports = { run: runProviderMode };

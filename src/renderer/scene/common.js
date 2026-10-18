// scene/common.js — helpers shared by the views, and the AUR.sceneParts
// registry the split-off scene/<view>/*.js parts add their builders to.
'use strict';

(function () {
  const AUR = window.AUR;

  AUR.sceneParts = { universe: {}, system: {} };

  // The part of the canvas not covered by the fixed chrome: below the top bar, between the rails,
  // above the timeline. Labels and the chrome-occlusion stats both lay out inside it.
  AUR.chromeBounds = function (canvas) {
    const edge = (id, side, fallback) => {
      const el = document.getElementById(id);
      if (!el || el.classList.contains('hidden') || getComputedStyle(el).display === 'none') return fallback;
      return el.getBoundingClientRect()[side];
    };
    const width = canvas.clientWidth, height = canvas.clientHeight;
    const top = edge('topbar', 'bottom', 0) + 8;
    const left = edge('rail-left', 'right', 0) + 8;
    const right = edge('sidebar', 'left', width) - 8;
    const bottom = edge('history-bar', 'top', height) - 8;
    return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
  };

  // Hull materials are shared per scene and released by AUR.ships.dispose.
  AUR.disposeMeshAndMaterial = function (mesh) {
    if (!mesh) return;
    const material = mesh.material;
    const sharedAssetMaterial = Boolean(mesh.metadata && mesh.metadata.assetHullId);
    mesh.dispose();
    if (material && !sharedAssetMaterial) material.dispose();
  };
})();

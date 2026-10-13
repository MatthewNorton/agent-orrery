// scene-common.js — helpers shared by the views, and the AUR.sceneParts
// registry the split-off scene-<view>-*.js files add their builders to.
'use strict';

(function () {
  const AUR = window.AUR;

  AUR.sceneParts = { universe: {}, system: {} };

  // Hull materials are shared per scene and released by AUR.ships.dispose.
  AUR.disposeMeshAndMaterial = function (mesh) {
    if (!mesh) return;
    const material = mesh.material;
    const sharedAssetMaterial = Boolean(mesh.metadata && mesh.metadata.assetHullId);
    mesh.dispose();
    if (material && !sharedAssetMaterial) material.dispose();
  };
})();

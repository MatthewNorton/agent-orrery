// @ts-check
// The sky behind the system and planet views: six cube faces baked offline by scripts/bake-sky.js from the
// author's Sidereal Deep Field shader (assets/skies), in the look picked in Settings and at the face size of
// the graphics tier. A new look or size loads beside the one shown and replaces it once ready. If no faces
// have loaded and they fail, the view gets the runtime starfield instead, so its sky is never black.
'use strict';

(function () {
  const AUR = window.AUR;
  const FACES = ['px', 'py', 'pz', 'nx', 'ny', 'nz'];

  /**
   * @param {BABYLON.Scene} scene  the view's scene, with its glow layer already added: the sky stays out of it
   * @param {string} look  a key of AUR.app.const.SKY_LOOKS
   * @param {number} size  the graphics tier's face size (AUR.app.const.RENDER_QUALITIES[].sky)
   */
  AUR.addSky = function addSky(scene, look, size) {
    const box = BABYLON.MeshBuilder.CreateBox('sky', { size: 1600, sideOrientation: BABYLON.Mesh.BACKSIDE }, scene);
    const mat = new BABYLON.StandardMaterial('skyMat', scene);
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    mat.diffuseColor = new BABYLON.Color3(0, 0, 0);
    mat.specularColor = new BABYLON.Color3(0, 0, 0);
    box.material = mat;
    box.infiniteDistance = true;
    box.isPickable = false;
    box.isVisible = false; // until its first faces are in
    for (const layer of scene.effectLayers) if (layer instanceof BABYLON.GlowLayer) layer.addExcludedMesh(box);

    // `current` is the look/size on screen, `pending` the one loading; a request for either is a no-op.
    const state = { look, size, current: '', pending: '' };
    /** @type {any} */
    let starfield = null;

    function load() {
      const key = state.look + '/' + state.size;
      if (key === state.pending) return;
      if (key === state.current) { state.pending = ''; return; }
      state.pending = key;
      const root = '../../assets/skies/' + key + '/';
      const texture = new BABYLON.CubeTexture(root, scene, null, false, FACES.map((face) => root + face + '.webp'),
        () => {
          if (scene.isDisposed) return;
          if (state.pending !== key) { texture.dispose(); return; } // a later look or size was asked for
          state.pending = '';
          state.current = key;
          const old = mat.reflectionTexture;
          mat.reflectionTexture = texture;
          box.isVisible = true;
          if (old) old.dispose();
          if (starfield) { starfield.dispose(); starfield = null; }
        },
        (message) => {
          if (scene.isDisposed) return;
          AUR.log('sky faces failed to load:', key, message);
          texture.dispose();
          if (state.pending === key) state.pending = '';
          if (!state.current && !starfield) starfield = AUR.addStarfield(scene, 3000, 760);
        });
      texture.coordinatesMode = BABYLON.Texture.SKYBOX_MODE;
    }
    load();

    return {
      /** @param {string} next */
      setLook(next) { state.look = next; load(); },
      /** @param {number} next */
      setSize(next) { state.size = next; load(); },
    };
  };
})();

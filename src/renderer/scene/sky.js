// @ts-check
// The sky behind the system and planet views: six cube faces baked offline by scripts/bake-sky.js from the
// author's Sidereal Deep Field shader (assets/skies), in the look picked in Settings and at the face size of
// the graphics tier. A new look or size loads beside the one shown and replaces it once ready, one load at a
// time, so a run of clicks costs two loads rather than one per click. If no faces have loaded and they fail,
// the view gets the runtime starfield instead, so its sky is never black.
'use strict';

(function () {
  const AUR = window.AUR;
  const FACES = ['px', 'py', 'pz', 'nx', 'ny', 'nz'];

  /**
   * @param {BABYLON.Scene} scene  the view's scene
   * @param {BABYLON.GlowLayer | null} glow  the view's glow layer, which leaves the sky out
   * @param {string} look  a key of AUR.app.const.SKY_LOOKS
   * @param {number} size  the graphics tier's face size (AUR.app.const.RENDER_QUALITIES[].sky)
   */
  AUR.addSky = function addSky(scene, glow, look, size) {
    const box = BABYLON.MeshBuilder.CreateBox('sky', { size: 1600, sideOrientation: BABYLON.Mesh.BACKSIDE }, scene);
    /** @type {BABYLON.StandardMaterial} */
    const mat = AUR.unlitMaterial(scene, 'skyMat', BABYLON.Color3.Black());
    mat.disableLighting = true;
    box.material = mat;
    box.infiniteDistance = true;
    box.isPickable = false;
    box.isVisible = false; // until its first faces are in
    if (glow) glow.addExcludedMesh(box);

    let shown = ''; // the look/size on screen
    let loading = ''; // the look/size being fetched
    /** @type {{ dispose(): void } | null} */
    let starfield = null;
    const wanted = () => look + '/' + size;

    function load() {
      const key = wanted();
      if (loading || key === shown) return; // the load in flight starts the next one when it ends
      loading = key;
      const root = '../../assets/skies/' + key + '/';
      const texture = new BABYLON.CubeTexture(root, scene, null, false, FACES.map((face) => root + face + '.webp'),
        () => {
          if (scene.isDisposed) return;
          loading = '';
          if (key !== wanted()) { texture.dispose(); load(); return; } // a later look or size was asked for
          shown = key;
          const old = mat.reflectionTexture;
          mat.reflectionTexture = texture;
          box.isVisible = true;
          if (old) old.dispose();
          if (starfield) { starfield.dispose(); starfield = null; }
        },
        (message) => {
          if (scene.isDisposed) return;
          loading = '';
          AUR.log('sky faces failed to load:', key, message);
          texture.dispose();
          if (!shown && !starfield) starfield = AUR.addStarfield(scene, 3000, 760);
          if (key !== wanted()) load(); // never the key that just failed
        });
      texture.coordinatesMode = BABYLON.Texture.SKYBOX_MODE;
    }
    load();

    return {
      /** @param {string} next */
      setLook(next) { look = next; load(); },
      /** @param {number} next */
      setSize(next) { size = next; load(); },
    };
  };
})();

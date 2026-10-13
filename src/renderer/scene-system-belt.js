// scene-system-belt.js — the solar system's asteroid belt: three deformed rock
// forms drawn as thin instances between the middle orbits.
'use strict';

(function () {
  const AUR = window.AUR;

  AUR.sceneParts.system.belt = function (view) {
    const { scene, projectId, sys, orbitR, outer } = view;
    const n = (sys.planets || []).length;
    const beltR = n >= 2 ? (orbitR(Math.floor(n / 2) - 1) + orbitR(Math.floor(n / 2))) / 2 : outer + 4;
    const count = AUR.clamp(Math.max((sys.beltDensity || 0) * 4, 70), 0, 300);
    if (count <= 0) return null;
    const rand = AUR.mulberry32(AUR.fnv1a(projectId + ':belt'));
    const belt = new BABYLON.TransformNode('asteroid-belt', scene);
    const variants = [1, 2, 3];
    const q = BABYLON.Quaternion.Identity();
    for (let variant = 0; variant < variants.length; variant += 1) {
      const rock = AUR.createAsteroidMesh(
        scene, 'asteroid-form-' + variant,
        AUR.fnv1a(projectId + ':asteroid-form:' + variant), 0.19);
      const rmat = new BABYLON.StandardMaterial('asteroid-mat-' + variant, scene);
      AUR.applyAsteroidSurface(scene, rmat, variants[variant]);
      rmat.emissiveColor = new BABYLON.Color3(0.018, 0.016, 0.014);
      rock.material = rmat;
      rock.parent = belt;
      rock.isPickable = false;
      const variantCount = Math.floor((count + (variants.length - 1 - variant)) / variants.length);
      const buf = new Float32Array(variantCount * 16);
      for (let i = 0; i < variantCount; i += 1) {
        const a = rand() * Math.PI * 2;
        const rr = beltR + (rand() - 0.5) * 3.4;
        const y = (rand() - 0.5) * 1.2;
        const s = 0.45 + rand() * 1.18;
        const stretch = 0.68 + rand() * 0.76;
        BABYLON.Quaternion.FromEulerAnglesToRef(rand() * 3, rand() * 3, rand() * 3, q);
        const m = BABYLON.Matrix.Compose(
          new BABYLON.Vector3(s * stretch, s * (0.78 + rand() * 0.42), s / Math.sqrt(stretch)), q,
          new BABYLON.Vector3(Math.cos(a) * rr, y, Math.sin(a) * rr));
        m.copyToArray(buf, i * 16);
      }
      rock.thinInstanceSetBuffer('matrix', buf, 16);
    }
    return belt;
  };
})();

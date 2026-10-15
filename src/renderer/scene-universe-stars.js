// scene-universe-stars.js — the body of a galaxy, in the galaxy's own space so it rides the pivot:
// one point cloud of stars on the spiral arms its systems follow, with the luminous core and the
// dust along the arms as large faint points of the same cloud. A point shader draws each as a soft
// disc of its own size. One draw call per galaxy, outside the glow pass, rebuilt only when the
// galaxy's radius changes.
'use strict';

(function () {
  const AUR = window.AUR;
  const GALAXY = window.AUR_GALAXY;

  const STARS_MAX = 12000;
  const DUST_PER_ARM = 16;
  const SHARE = { field: 0.12, nebula: 0.04 };
  const CORE_HEX = ['#ffe9c4', '#ffd9a0', '#fff3dc', '#ffc98a'];
  const ARM_HEX = ['#dfe8ff', '#ffffff', '#c9d8ff', '#f4f6ff', '#ffe6d0'];
  const NEBULA_HEX = '#ff9fb4';
  // The core: stacked glows, [size as a fraction of the radius, alpha, colour], warm to white-hot.
  const CORE_GLOWS = [[0.36, 0.26, '#ffd9a0'], [0.16, 0.45, '#ffe9c4'], [0.06, 0.7, '#fff3dc']];

  const VERTEX_SHADER = `
    precision highp float;
    attribute vec3 position;
    attribute vec4 color;
    attribute float size;
    uniform mat4 worldViewProjection;
    uniform mat4 worldView;
    uniform float pixelsPerUnit;
    varying vec4 vColor;
    void main() {
      vec4 viewPosition = worldView * vec4(position, 1.0);
      gl_Position = worldViewProjection * vec4(position, 1.0);
      gl_PointSize = clamp(size * pixelsPerUnit / max(1.0, abs(viewPosition.z)), 1.0, 256.0);
      vColor = color;
    }`;
  const FRAGMENT_SHADER = `
    precision highp float;
    varying vec4 vColor;
    void main() {
      float soft = smoothstep(1.0, 0.25, length(gl_PointCoord - vec2(0.5)) * 2.0);
      gl_FragColor = vec4(vColor.rgb, vColor.a * soft);
    }`;

  AUR.sceneParts.universe.stars = function (view) {
    const { scene, camera, glow } = view;
    // Babylon and the colour helper exist only once the renderer runs, so the shader registration
    // and the palettes live here rather than at load.
    BABYLON.Effect.ShadersStore.galaxyStarsVertexShader = VERTEX_SHADER;
    BABYLON.Effect.ShadersStore.galaxyStarsFragmentShader = FRAGMENT_SHADER;
    const CORE_COLORS = CORE_HEX.map(AUR.color3);
    const ARM_COLORS = ARM_HEX.map(AUR.color3);
    const NEBULA_COLOR = AUR.color3(NEBULA_HEX);
    const pick = (rand, list) => list[Math.floor(rand() * list.length)];
    const gaussian = (rand) => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());

    // One point material for every galaxy.
    const starMaterial = new BABYLON.ShaderMaterial('galaxy-stars', scene, 'galaxyStars', {
      attributes: ['position', 'color', 'size'],
      uniforms: ['worldViewProjection', 'worldView', 'pixelsPerUnit'],
      needAlphaBlending: true,
    });
    starMaterial.pointsCloud = true;
    starMaterial.alphaMode = BABYLON.Constants.ALPHA_ADD;
    starMaterial.disableDepthWrite = true;
    starMaterial.backFaceCulling = false;

    // A star's pixel size follows the viewport; one uniform write in the view's frame loop.
    function animateStars() {
      starMaterial.setFloat('pixelsPerUnit',
        scene.getEngine().getRenderHeight() / (2 * Math.tan(camera.fov / 2)));
    }

    function starCloud(record, spiral) {
      const R = spiral.radius;
      const rand = AUR.mulberry32(AUR.fnv1a('stars:' + record.key));
      const fade = record.dim ? 0.35 : 1;
      const stars = Math.min(STARS_MAX, Math.round(600 + R * R * 0.5));
      const dust = DUST_PER_ARM * spiral.arms;
      const count = stars + CORE_GLOWS.length + dust;
      const positions = new Float32Array(count * 3);
      const colors = new Float32Array(count * 4);
      const sizes = new Float32Array(count);
      let k = 0;
      const put = (x, y, z, size, color, alpha) => {
        positions[k * 3] = x;
        positions[k * 3 + 1] = y;
        positions[k * 3 + 2] = z;
        colors[k * 4] = color.r;
        colors[k * 4 + 1] = color.g;
        colors[k * 4 + 2] = color.b;
        colors[k * 4 + 3] = alpha * fade;
        sizes[k] = size;
        k++;
      };
      for (let i = 0; i < stars; i++) {
        // Half the stars crowd the core, half spread evenly over the disc; most trace an arm.
        const u = rand();
        const r = Math.min(R, rand() < 0.5 ? -R * 0.3 * Math.log(1 - u) : R * Math.sqrt(u));
        const angle = rand() < SHARE.field ? rand() * Math.PI * 2
          : GALAXY.armAngle(spiral, i % spiral.arms, r) + gaussian(rand) * (0.04 + 0.14 * (r / R));
        const color = r < spiral.core ? pick(rand, CORE_COLORS)
          : rand() < SHARE.nebula ? NEBULA_COLOR : pick(rand, ARM_COLORS);
        // Mostly small with a bright few, never larger than the smallest sun, so glyphs stay legible.
        put(Math.cos(angle) * r, gaussian(rand) * GALAXY.discThickness(spiral, r) * 0.8, Math.sin(angle) * r,
          0.3 + (AUR.SUN_DIAMETER_MIN - 0.3) * rand() ** 4, color, 0.9 * (0.3 + 0.7 * rand()));
      }
      for (const [fraction, alpha, hex] of CORE_GLOWS) put(0, 0, 0, R * fraction, AUR.color3(hex), alpha);
      for (let i = 0; i < dust; i++) {
        const r = GALAXY.armRadius(spiral, (Math.floor(i / spiral.arms) + 0.5) / DUST_PER_ARM);
        const angle = GALAXY.armAngle(spiral, i % spiral.arms, r) + gaussian(rand) * 0.08;
        put(Math.cos(angle) * r, gaussian(rand) * 0.6, Math.sin(angle) * r, R * (0.1 + rand() * 0.1),
          record.color, 0.12);
      }
      const mesh = new BABYLON.Mesh('galaxy-stars:' + record.key, scene);
      mesh.setVerticesData(BABYLON.VertexBuffer.PositionKind, positions);
      mesh.setVerticesData(BABYLON.VertexBuffer.ColorKind, colors, false, 4);
      mesh.setVerticesData('size', sizes, false, 1);
      mesh.isUnIndexed = true;
      mesh.material = starMaterial;
      mesh.isPickable = false;
      mesh.parent = record.pivot;
      glow.addExcludedMesh(mesh);
      return mesh;
    }

    // The body is a function of the galaxy's radius (which the member count sets), so a pivot
    // that merely moves, or a project that joins without widening the galaxy, keeps its stars.
    function buildGalaxyStars(record, spec) {
      if (record.body && record.bodyRadius === spec.radius) return;
      disposeGalaxyStars(record);
      record.body = starCloud(record, spec.spiral);
      record.bodyRadius = spec.radius;
    }

    function disposeGalaxyStars(record) {
      if (record.body) record.body.dispose();
      record.body = null;
    }

    return { buildGalaxyStars, disposeGalaxyStars, animateStars };
  };
})();

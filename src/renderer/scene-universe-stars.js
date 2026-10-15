// scene-universe-stars.js — the body of a galaxy, in the galaxy's own space so it rides the pivot:
// thousands of stars as a point cloud on the spiral arms its systems follow (a point shader draws
// each as a soft disc of its own size), and a luminous core and dust along the arms as flat soft
// discs in the disc plane. Two draw calls per galaxy, outside the glow pass, rebuilt only when
// the spiral itself changes.
'use strict';

(function () {
  const AUR = window.AUR;
  const GALAXY = window.AUR_GALAXY;

  const STARS = { base: 600, perMember: 400, perUnit: 20, max: 12000 };
  const FIELD_SHARE = 0.12;
  const NEBULA_SHARE = 0.04;
  const BRIGHT_SHARE = 0.08;
  const DUST_PER_ARM = 16;
  const CORE_HEX = ['#ffe9c4', '#ffd9a0', '#fff3dc', '#ffc98a'];
  const ARM_HEX = ['#dfe8ff', '#ffffff', '#c9d8ff', '#f4f6ff', '#ffe6d0'];
  const NEBULA_HEX = '#ff9fb4';
  // The core: stacked glows, [size as a fraction of the radius, alpha, core colour], warm to white-hot.
  const CORE_GLOWS = [[0.7, 0.12, 3], [0.36, 0.26, 1], [0.16, 0.45, 0], [0.06, 0.7, 2]];

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
      float soft = smoothstep(1.0, 0.0, length(gl_PointCoord - vec2(0.5)) * 2.0);
      gl_FragColor = vec4(vColor.rgb, vColor.a * soft * soft);
    }`;

  AUR.sceneParts.universe.stars = function (view) {
    const { scene, engine, camera, glow } = view;
    BABYLON.Effect.ShadersStore.galaxyStarsVertexShader = VERTEX_SHADER;
    BABYLON.Effect.ShadersStore.galaxyStarsFragmentShader = FRAGMENT_SHADER;

    const pick = (rand, list) => list[Math.floor(rand() * list.length)];
    const gaussian = (rand) => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
    const CORE_COLORS = CORE_HEX.map(AUR.color3);
    const ARM_COLORS = ARM_HEX.map(AUR.color3);
    const NEBULA_COLOR = AUR.color3(NEBULA_HEX);

    // One point material for every galaxy; a star's pixel size follows the viewport each frame.
    const starMaterial = new BABYLON.ShaderMaterial('galaxy-stars', scene, 'galaxyStars', {
      attributes: ['position', 'color', 'size'],
      uniforms: ['worldViewProjection', 'worldView', 'pixelsPerUnit'],
      needAlphaBlending: true,
    });
    starMaterial.pointsCloud = true;
    starMaterial.alphaMode = BABYLON.Constants.ALPHA_ADD;
    starMaterial.disableDepthWrite = true;
    starMaterial.backFaceCulling = false;
    scene.onBeforeRenderObservable.add(() => {
      starMaterial.setFloat('pixelsPerUnit', engine.getRenderHeight() / (2 * Math.tan(camera.fov / 2)));
    });

    function starColor(rand, core) {
      if (core) return pick(rand, CORE_COLORS);
      return rand() < NEBULA_SHARE ? NEBULA_COLOR : pick(rand, ARM_COLORS);
    }

    // One point cloud holds the stars, the stacked core glows and the dust along the arms: the
    // glows are just large, faint points of the same shader.
    function starCloud(record, spec) {
      const { spiral } = spec;
      const R = spec.radius;
      const rand = AUR.mulberry32(AUR.fnv1a('stars:' + spec.key));
      const fade = record.dim ? 0.35 : 1;
      const stars = Math.round(Math.min(STARS.max,
        STARS.base + record.memberCount * STARS.perMember + R * STARS.perUnit));
      const dust = DUST_PER_ARM * spiral.arms;
      const count = stars + CORE_GLOWS.length + dust;
      const positions = new Float32Array(count * 3);
      const colors = new Float32Array(count * 4);
      const sizes = new Float32Array(count);
      const indices = new Uint32Array(count);
      let k = 0;
      const put = (x, y, z, size, color, alpha) => {
        positions.set([x, y, z], k * 3);
        colors.set([color.r, color.g, color.b, alpha * fade], k * 4);
        sizes[k] = size;
        indices[k] = k;
        k++;
      };
      for (let i = 0; i < stars; i++) {
        // Half the stars crowd the core, half spread evenly over the disc; most trace an arm.
        const u = rand();
        const r = Math.min(R, rand() < 0.5 ? -R * 0.3 * Math.log(1 - u) : R * Math.sqrt(u));
        const angle = rand() < FIELD_SHARE ? rand() * Math.PI * 2
          : GALAXY.armAngle(spiral, i % spiral.arms, r) + gaussian(rand) * (0.04 + 0.14 * (r / R));
        put(Math.cos(angle) * r, gaussian(rand) * GALAXY.discThickness(spiral, r) * 0.8, Math.sin(angle) * r,
          rand() < BRIGHT_SHARE ? 1.2 + rand() * 1.2 : 0.35 + rand() * rand() * 0.9,
          starColor(rand, r < spiral.core), 0.9 * (0.3 + 0.7 * rand()));
      }
      for (const [fraction, alpha, core] of CORE_GLOWS) put(0, 0, 0, R * fraction, CORE_COLORS[core], alpha);
      for (let i = 0; i < dust; i++) {
        const r = GALAXY.armRadius(spiral, ((i % DUST_PER_ARM) + 0.5) / DUST_PER_ARM);
        const angle = GALAXY.armAngle(spiral, i % spiral.arms, r) + gaussian(rand) * 0.08;
        put(Math.cos(angle) * r, gaussian(rand) * 0.6, Math.sin(angle) * r, R * (0.1 + rand() * 0.1),
          record.color, 0.12);
      }
      const mesh = new BABYLON.Mesh('galaxy-stars:' + spec.key, scene);
      const data = new BABYLON.VertexData();
      data.positions = positions;
      data.colors = colors;
      data.indices = indices;
      data.applyToMesh(mesh);
      mesh.setVerticesData('size', sizes, false, 1);
      mesh.material = starMaterial;
      mesh.isPickable = false;
      mesh.parent = record.pivot;
      glow.addExcludedMesh(mesh);
      return mesh;
    }

    // The body depends only on the spiral, the member count and the radius; a pivot that
    // merely moves keeps its stars.
    function buildGalaxyStars(record, spec) {
      const bodyKey = [spec.spiral.arms, spec.spiral.phase, record.memberCount, spec.radius].join(':');
      if (record.bodyKey === bodyKey) return;
      disposeGalaxyStars(record);
      record.body = starCloud(record, spec);
      record.bodyKey = bodyKey;
    }

    function disposeGalaxyStars(record) {
      if (record.body) record.body.dispose();
      record.body = null;
      record.bodyKey = null;
    }

    return { buildGalaxyStars, disposeGalaxyStars };
  };
})();

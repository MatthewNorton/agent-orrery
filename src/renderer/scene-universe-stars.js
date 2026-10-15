// scene-universe-stars.js — the body of a galaxy: a volume of starlight and dust raymarched
// through the galaxy's emission atlas, and resolved stars drawn from the same atlas, both in the
// galaxy-field.js local frame scaled to the galaxy's radius and riding its pivot. The light is
// added to the scene, so the solar-system glyphs inside stay legible. One volume and one point
// cloud per galaxy, outside the glow pass, rebuilt only when the galaxy's radius changes.
'use strict';

(function () {
  const AUR = window.AUR;
  const FIELD = window.AUR_FIELD;

  const EXPOSURE = 0.65;
  const STARS_MIN = 4000;
  const STARS_MAX = 120000;
  const STARS_PER_AREA = 12;

  const VOLUME_VERTEX = `
    precision highp float;
    attribute vec3 position;
    uniform mat4 worldViewProjection;
    varying vec3 localPosition;
    void main() {
      localPosition = position;
      gl_Position = worldViewProjection * vec4(position, 1.0);
    }`;
  // The exit face of the box integrates emission and extinction along the viewing ray, so the
  // camera may sit inside the volume. Dithering the first step hides the slab banding.
  const VOLUME_FRAGMENT = `
    precision highp float;
    varying vec3 localPosition;
    uniform vec3 cameraLocal;
    uniform sampler2D atlas;
    uniform float exposure;
    uniform vec2 diskHeight;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    void main() {
      if (gl_FrontFacing) discard;
      vec3 ray = normalize(localPosition - cameraLocal);
      vec3 inverseRay = 1.0 / (ray + vec3(0.000001));
      vec3 nearPlane = (vec3(-25.0, -4.0, -25.0) - cameraLocal) * inverseRay;
      vec3 farPlane = (vec3(25.0, 4.0, 25.0) - cameraLocal) * inverseRay;
      vec3 lo = min(nearPlane, farPlane), hi = max(nearPlane, farPlane);
      float entry = max(max(lo.x, lo.y), max(lo.z, 0.0));
      float exit = min(min(hi.x, hi.y), hi.z);
      if (exit <= entry) discard;
      float stepLength = (exit - entry) / 64.0;
      float along = entry + stepLength * hash(gl_FragCoord.xy);
      vec3 radiance = vec3(0.0);
      float transmission = 1.0;
      for (int i = 0; i < 64; i++) {
        vec3 p = cameraLocal + ray * along;
        vec4 field = texture2D(atlas, p.xz / 50.0 + 0.5);
        float height = diskHeight.x + length(p.xz) * diskHeight.y;
        float bulge = exp(-length(p * vec3(0.51, 1.38, 0.51)) * 1.65) * 2.9;
        vec3 emission = field.rgb * exp(-abs(p.y) / height) * 1.75 + vec3(1.0, 0.76, 0.5) * bulge;
        float extinction = field.a * exp(-abs(p.y) / (height * 0.46)) * 5.5 + bulge * 0.055;
        radiance += transmission * emission * stepLength;
        transmission *= exp(-extinction * stepLength);
        along += stepLength;
      }
      vec3 light = pow(1.0 - exp(-radiance * exposure * 1.5), vec3(0.9));
      if (max(light.r, max(light.g, light.b)) < 0.003) discard;
      gl_FragColor = vec4(light, 1.0);
    }`;
  // A star is a soft point sized by its distance, dimmed by the dust between it and the camera.
  const STAR_VERTEX = `
    precision highp float;
    attribute vec3 position;
    attribute vec4 color;
    attribute float size;
    uniform mat4 worldViewProjection;
    uniform mat4 worldView;
    uniform float pixelsPerUnit;
    uniform float exposure;
    uniform vec2 diskHeight;
    uniform vec3 cameraLocal;
    uniform sampler2D atlas;
    varying vec4 vColor;
    void main() {
      vec4 viewPosition = worldView * vec4(position, 1.0);
      gl_Position = worldViewProjection * vec4(position, 1.0);
      gl_PointSize = clamp(size * pixelsPerUnit / max(1.0, abs(viewPosition.z)), 0.8, 12.0);
      vec3 direction = normalize(cameraLocal - position);
      float stepLength = min(24.0, (diskHeight.x * 4.0 + 0.5) / max(0.025, abs(direction.y))) / 8.0;
      float opticalDepth = 0.0;
      for (int i = 0; i < 8; i++) {
        vec3 p = position + direction * (float(i) + 0.5) * stepLength;
        float height = (diskHeight.x + length(p.xz) * diskHeight.y) * 0.46;
        opticalDepth += texture2D(atlas, p.xz / 50.0 + 0.5).a * exp(-abs(p.y) / height) * stepLength * 5.5;
      }
      vColor = vec4(color.rgb * exposure, color.a * exp(-opticalDepth));
    }`;
  const STAR_FRAGMENT = `
    precision highp float;
    varying vec4 vColor;
    void main() {
      vec2 uv = gl_PointCoord * 2.0 - 1.0;
      float r2 = dot(uv, uv);
      if (r2 > 1.0) discard;
      gl_FragColor = vec4(vColor.rgb, vColor.a * exp(-r2 * 5.5) * (1.0 - smoothstep(0.5, 1.0, r2)));
    }`;

  AUR.sceneParts.universe.stars = function (view) {
    const { scene, camera, glow, galaxies } = view;
    const store = BABYLON.Effect.ShadersStore;
    store.galaxyVolumeVertexShader = VOLUME_VERTEX;
    store.galaxyVolumeFragmentShader = VOLUME_FRAGMENT;
    store.galaxyStarsVertexShader = STAR_VERTEX;
    store.galaxyStarsFragmentShader = STAR_FRAGMENT;
    const diskHeight = BABYLON.Vector2.FromArray(FIELD.DISK_HEIGHT);

    function shader(name, key, shaderName, attributes, uniforms, body) {
      const material = new BABYLON.ShaderMaterial(name + ':' + key, scene, shaderName, {
        attributes, uniforms: [...uniforms, 'exposure', 'diskHeight', 'cameraLocal'],
        samplers: ['atlas'], needAlphaBlending: true,
      });
      material.backFaceCulling = false;
      material.disableDepthWrite = true;
      material.alphaMode = BABYLON.Constants.ALPHA_ADD;
      material.setTexture('atlas', body.atlas);
      material.setFloat('exposure', body.exposure);
      material.setVector2('diskHeight', diskHeight);
      material.setVector3('cameraLocal', body.cameraLocal);
      return material;
    }

    function buildBody(record, spiral) {
      const R = spiral.radius;
      const scale = R / FIELD.DISC;
      const size = R < 60 ? 256 : 512;
      const seed = AUR.fnv1a('field:' + record.key);
      const tint = [record.color.r, record.color.g, record.color.b];
      const pixels = FIELD.buildAtlas(spiral, seed, tint, size);
      const body = {
        exposure: EXPOSURE * (record.dim ? 0.35 : 1), cameraLocal: new BABYLON.Vector3(),
        inverse: new BABYLON.Matrix(),
      };
      body.atlas = BABYLON.RawTexture.CreateRGBATexture(pixels, size, size, scene, true, false,
        BABYLON.Texture.TRILINEAR_SAMPLINGMODE);
      body.atlas.wrapU = body.atlas.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;

      body.volume = BABYLON.MeshBuilder.CreateBox('galaxy-region:' + record.key, FIELD.BOX, scene);
      body.volume.metadata = { isGalaxyRegion: true, galaxyKey: record.key };
      body.volume.material = shader('galaxy-volume', record.key, 'galaxyVolume',
        ['position'], ['worldViewProjection'], body);

      const count = Math.round(Math.max(STARS_MIN, Math.min(STARS_MAX, R * R * STARS_PER_AREA)));
      const stars = FIELD.sampleStars(pixels, size, seed, count, record.dim ? 0.5 : 1);
      // Sizes in world units, never larger than the smallest sun, so glyphs stay legible.
      for (let i = 0; i < count; i++) stars.sizes[i] = Math.min(AUR.SUN_DIAMETER_MIN, stars.sizes[i] * scale);
      body.stars = new BABYLON.Mesh('galaxy-stars:' + record.key, scene);
      body.stars.setVerticesData(BABYLON.VertexBuffer.PositionKind, stars.positions);
      body.stars.setVerticesData(BABYLON.VertexBuffer.ColorKind, stars.colors, false, 4);
      body.stars.setVerticesData('size', stars.sizes, false, 1);
      body.stars.isUnIndexed = true;
      body.stars.material = shader('galaxy-stars', record.key, 'galaxyStars',
        ['position', 'color', 'size'], ['worldViewProjection', 'worldView', 'pixelsPerUnit'], body);
      body.stars.material.pointsCloud = true;

      for (const mesh of [body.volume, body.stars]) {
        mesh.parent = record.pivot;
        mesh.scaling.setAll(scale);
        mesh.isPickable = false;
        mesh.alwaysSelectAsActiveMesh = true;
        glow.addExcludedMesh(mesh);
      }
      return body;
    }

    // The body is a function of the galaxy's radius (which the member count sets), so a pivot
    // that merely moves, or a project that joins without widening the galaxy, keeps its stars.
    // Either way the camera-to-local transform follows the pivot.
    function buildGalaxyStars(record, spec) {
      if (!record.body || record.bodyRadius !== spec.radius) {
        disposeGalaxyStars(record);
        record.body = buildBody(record, spec.spiral);
        record.bodyRadius = spec.radius;
      }
      record.body.volume.computeWorldMatrix(true).invertToRef(record.body.inverse);
    }

    function disposeGalaxyStars(record) {
      const body = record.body;
      if (!body) return;
      for (const mesh of [body.volume, body.stars]) { mesh.material.dispose(); mesh.dispose(); }
      body.atlas.dispose();
      record.body = null;
    }

    // Each frame: the camera in every galaxy's local frame, and the pixel size of a unit.
    function animateStars() {
      camera.getViewMatrix();
      const pixelsPerUnit = scene.getEngine().getRenderHeight() / (2 * Math.tan(camera.fov / 2));
      for (const galaxy of galaxies.values()) {
        const body = galaxy.body;
        if (!body) continue;
        BABYLON.Vector3.TransformCoordinatesToRef(camera.position, body.inverse, body.cameraLocal);
        body.stars.material.setFloat('pixelsPerUnit', pixelsPerUnit);
      }
    }

    return { buildGalaxyStars, disposeGalaxyStars, animateStars };
  };
})();

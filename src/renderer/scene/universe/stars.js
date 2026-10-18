// The body of a galaxy: a volume of starlight and dust raymarched
// through the galaxy's emission atlas, and resolved stars drawn from the same atlas, both in the
// galaxy-field.js local frame scaled to the galaxy's radius and riding its pivot. The light is
// added to the scene, so the solar-system glyphs inside stay legible. One volume and one point
// cloud per galaxy, outside the glow pass, rebuilt only when the galaxy's radius changes (the
// graphics quality swaps just its shaders and stars); the atlas pixels are kept across rebuilds
// and view switches.
'use strict';

(function () {
  const AUR = window.AUR;

  const EXPOSURE = 0.65;
  const STARS_MIN = 4000;
  const STARS_MAX = 120000;
  const STARS_PER_AREA = 12;

  // The shaders, written against the field's frame.
  function shaderSources(FIELD) {
    // The frame and the dust law both shaders share: a slab whose density falls off with height,
    // read from the atlas at a point's ground position.
    const frame = `
      uniform sampler2D atlas;
      uniform vec2 diskHeight;
      uniform vec3 cameraLocal;
      uniform float exposure;
      vec4 fieldAt(vec3 p) { return texture2D(atlas, p.xz / ${(2 * FIELD.EXTENT).toFixed(1)} + 0.5); }
      float diskScale(vec3 p) { return diskHeight.x + length(p.xz) * diskHeight.y; }`;
    const volumeVertex = `
      precision highp float;
      attribute vec3 position;
      uniform mat4 worldViewProjection;
      varying vec3 localPosition;
      void main() {
        localPosition = position;
        gl_Position = worldViewProjection * vec4(position, 1.0);
      }`;
    // The exit face of the box integrates emission and extinction along the viewing ray, so the
    // camera may sit inside the volume. Dithering the first step hides the slab banding. STEPS is
    // a define the graphics quality sets.
    const volumeFragment = `
      precision highp float;
      varying vec3 localPosition;
      ${frame}
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main() {
        if (gl_FrontFacing) discard;
        vec3 ray = normalize(localPosition - cameraLocal);
        vec3 inverseRay = 1.0 / (ray + vec3(0.000001));
        vec3 bounds = vec3(${FIELD.EXTENT.toFixed(1)}, ${FIELD.SLAB.toFixed(1)}, ${FIELD.EXTENT.toFixed(1)});
        vec3 nearPlane = (-bounds - cameraLocal) * inverseRay;
        vec3 farPlane = (bounds - cameraLocal) * inverseRay;
        vec3 lo = min(nearPlane, farPlane), hi = max(nearPlane, farPlane);
        float entry = max(max(lo.x, lo.y), max(lo.z, 0.0));
        float exit = min(min(hi.x, hi.y), hi.z);
        if (exit <= entry) discard;
        float stepLength = (exit - entry) / float(STEPS);
        float along = entry + stepLength * hash(gl_FragCoord.xy);
        vec3 radiance = vec3(0.0);
        float transmission = 1.0;
        for (int i = 0; i < STEPS; i++) {
          vec3 p = cameraLocal + ray * along;
          vec4 field = fieldAt(p);
          float height = diskScale(p);
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
    // A star is a soft point sized by its distance, never larger than the smallest sun, dimmed by
    // the dust column between it and the camera: the slab's density integrates in closed form,
    // through the midplane when the ray crosses it.
    const starVertex = `
      precision highp float;
      attribute vec3 position;
      attribute vec4 color;
      attribute float size;
      uniform mat4 worldViewProjection;
      uniform mat4 worldView;
      uniform float pixelsPerUnit;
      uniform float unitScale;
      uniform float sizeMax;
      uniform float pointMax;
      ${frame}
      varying vec4 vColor;
      void main() {
        vec4 viewPosition = worldView * vec4(position, 1.0);
        gl_Position = worldViewProjection * vec4(position, 1.0);
        float world = min(size * unitScale, sizeMax);
        gl_PointSize = clamp(world * pixelsPerUnit / max(1.0, abs(viewPosition.z)), 0.8, pointMax);
        vec3 direction = normalize(cameraLocal - position);
        float dustHeight = diskScale(position) * 0.46;
        float here = exp(-abs(position.y) / dustHeight);
        float column = position.y * direction.y >= 0.0 ? here : 2.0 - here;
        float opticalDepth = fieldAt(position).a * dustHeight * column / max(0.025, abs(direction.y)) * 5.5;
        vColor = vec4(color.rgb * exposure, color.a * exp(-opticalDepth));
      }`;
    const starFragment = `
      precision highp float;
      varying vec4 vColor;
      void main() {
        vec2 uv = gl_PointCoord * 2.0 - 1.0;
        float r2 = dot(uv, uv);
        if (r2 > 1.0) discard;
        gl_FragColor = vec4(vColor.rgb, vColor.a * exp(-r2 * 5.5) * (1.0 - smoothstep(0.5, 1.0, r2)));
      }`;
    return { volumeVertex, volumeFragment, starVertex, starFragment };
  }

  AUR.sceneParts.universe.stars = function (view) {
    const { scene, camera, glow, galaxies, fields } = view;
    const FIELD = window.AUR_FIELD;
    const sources = shaderSources(FIELD);
    const store = BABYLON.Effect.ShadersStore;
    store.galaxyVolumeVertexShader = sources.volumeVertex;
    store.galaxyVolumeFragmentShader = sources.volumeFragment;
    store.galaxyStarsVertexShader = sources.starVertex;
    store.galaxyStarsFragmentShader = sources.starFragment;
    const diskHeight = BABYLON.Vector2.FromArray(FIELD.DISK_HEIGHT);
    const toLocal = new BABYLON.Matrix();

    function shader(shaderName, key, attributes, uniforms, body, defines = []) {
      const material = new BABYLON.ShaderMaterial(shaderName + ':' + key, scene, shaderName, {
        attributes, uniforms: [...uniforms, 'exposure', 'diskHeight', 'cameraLocal'],
        samplers: ['atlas'], needAlphaBlending: true, defines,
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

    // The atlas depends on the spiral's arms and the texture size, not its radius, so its pixels
    // outlive the body and the view.
    function atlasPixels(record, spiral, size) {
      const key = record.key + ':' + spiral.arms + ':' + size;
      let pixels = fields.get(key);
      if (!pixels) {
        const tint = [record.color.r, record.color.g, record.color.b];
        pixels = FIELD.buildAtlas(spiral, AUR.fnv1a('field:' + record.key), tint, size);
        fields.set(key, pixels);
      }
      return pixels;
    }

    const atlasSize = (spiral) => spiral.radius < 60 ? 256 : 512;

    function buildBody(record, spiral) {
      const size = atlasSize(spiral);
      const body = { spiral, exposure: EXPOSURE * (record.dim ? 0.35 : 1), cameraLocal: new BABYLON.Vector3() };
      body.atlas = BABYLON.RawTexture.CreateRGBATexture(atlasPixels(record, spiral, size), size, size, scene,
        true, false, BABYLON.Texture.TRILINEAR_SAMPLINGMODE);
      body.atlas.wrapU = body.atlas.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;
      body.volume = BABYLON.MeshBuilder.CreateBox('galaxy-region:' + record.key, FIELD.BOX, scene);
      body.volume.metadata = { isGalaxyRegion: true, galaxyKey: record.key };
      placeInGalaxy(record, body, body.volume);
      dressBody(record, body);
      return body;
    }

    function placeInGalaxy(record, body, mesh) {
      mesh.parent = record.pivot;
      mesh.scaling.setAll(body.spiral.radius / FIELD.DISC);
      mesh.isPickable = false;
      glow.addExcludedMesh(mesh);
    }

    // What the graphics quality decides: the volume's raymarch steps and the resolved stars.
    function dressBody(record, body) {
      const R = body.spiral.radius;
      const size = atlasSize(body.spiral);
      body.volume.material = shader('galaxyVolume', record.key, ['position'], ['worldViewProjection'], body,
        ['#define STEPS ' + view.quality.steps]);

      const count = Math.round(AUR.clamp(R * R * STARS_PER_AREA, STARS_MIN, STARS_MAX) * view.quality.stars);
      const stars = FIELD.sampleStars(atlasPixels(record, body.spiral, size), size,
        AUR.fnv1a('stars:' + record.key), count);
      body.stars = new BABYLON.Mesh('galaxy-stars:' + record.key, scene);
      body.stars.setVerticesData(BABYLON.VertexBuffer.PositionKind, stars.positions);
      body.stars.setVerticesData(BABYLON.VertexBuffer.ColorKind, stars.colors, false, 4);
      body.stars.setVerticesData('size', stars.sizes, false, 1);
      body.stars.isUnIndexed = true;
      body.stars.material = shader('galaxyStars', record.key, ['position', 'color', 'size'],
        ['worldViewProjection', 'worldView', 'pixelsPerUnit', 'unitScale', 'sizeMax', 'pointMax'], body);
      body.stars.material.pointsCloud = true;
      body.stars.material.setFloat('unitScale', R / FIELD.DISC);
      body.stars.material.setFloat('sizeMax', AUR.SUN_DIAMETER_MIN);
      // 12 display pixels at most, whatever share of them the scene renders.
      body.stars.material.setFloat('pointMax', 12 * view.quality.resolution);
      placeInGalaxy(record, body, body.stars);
    }

    // The materials go, the atlas they share stays.
    function undressBody(body) {
      const starsMaterial = body.stars.material;
      body.stars.dispose();
      starsMaterial.dispose();
      body.volume.material.dispose();
    }

    // The body is a function of the galaxy's radius (which the member count sets), so a pivot
    // that merely moves, or a project that joins without widening the galaxy, keeps its stars.
    function buildGalaxyStars(record, spec) {
      if (record.body && record.body.spiral.radius === spec.spiral.radius) return;
      disposeGalaxyStars(record);
      record.body = buildBody(record, spec.spiral);
    }

    function setStarsQuality(quality) {
      view.quality = quality;
      for (const record of galaxies.values()) {
        if (!record.body) continue;
        undressBody(record.body);
        dressBody(record, record.body);
      }
    }

    function disposeGalaxyStars(record) {
      if (!record.body) return;
      for (const mesh of [record.body.volume, record.body.stars]) mesh.dispose(false, true);
      record.body = null;
    }

    // Each frame: the camera in every galaxy's local frame, and the pixel size of a unit.
    function animateStars() {
      camera.getViewMatrix();
      const pixelsPerUnit = scene.getEngine().getRenderHeight() / (2 * Math.tan(camera.fov / 2));
      for (const galaxy of galaxies.values()) {
        const body = galaxy.body;
        if (!body) continue;
        body.volume.getWorldMatrix().invertToRef(toLocal);
        BABYLON.Vector3.TransformCoordinatesToRef(camera.position, toLocal, body.cameraLocal);
        body.stars.material.setFloat('pixelsPerUnit', pixelsPerUnit);
      }
    }

    return { buildGalaxyStars, disposeGalaxyStars, setStarsQuality, animateStars };
  };
})();

// The page side of scripts/bake-sky.js, loaded through sky-bake.html in a hidden window. The field is the
// author's Sidereal Deep Field shader (MIT) with its region The Veil: a ray-marched cloud medium with dust
// and three star layers, unchanged but for the uniforms it no longer needs. bakeFace() renders one face of
// the system view's sky cube, one texel per fragment, and returns it as base64 WebP.
'use strict';

(function () {
  const VEIL = { seed: 2.4, angle: -0.45, shape: 0, cold: [0.12, 0.48, 0.61], warm: [1.05, 0.57, 0.28], light: [0.1, 0.15, 0.45] };

  const VERTEX = `
precision highp float;
attribute vec3 position;
varying vec2 vUV;
void main() {
  vUV = position.xy * .5 + .5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

  // Babylon's shader preprocessor splits uniform lines at semicolons, so they carry no comments.
  const FIELD = `
precision highp float;
varying vec2 vUV;
uniform sampler2D noiseMap;
uniform float starRes;
uniform float seed;
uniform float angle;
uniform float shape;
uniform float dust;
uniform vec3 cold;
uniform vec3 warm;
uniform vec3 lightPosition;

vec3 hash3(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973));
  q += dot(q, q.yxz + 33.33);
  return fract((q.xxy + q.yxx) * q.zyx);
}

// R and G hold adjacent Z slices, so one bilinear lookup interpolates a 3D cell. The explicit LOD keeps
// the ANGLE D3D compiler from unrolling the march loop below, which never finishes at 256 steps.
float noise(vec3 p) {
  vec3 cell = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  vec2 uv = cell.xy + vec2(37.0, 17.0) * cell.z + f.xy;
  vec2 pair = textureLod(noiseMap, (uv + .5) / 256.0, 0.0).rg;
  return mix(pair.r, pair.g, f.z);
}
float fbm(vec3 p) {
  float n = .54 * noise(p);
  p = p * 2.03 + 13.2;
  n += .27 * noise(p);
  p = p * 2.01 + 7.6;
  n += .135 * noise(p);
  return n + .0675 * noise(p * 2.04 + 4.1);
}
mat2 rotate(float a) { return mat2(cos(a), -sin(a), sin(a), cos(a)); }
float gaussian(float x) { return exp(-x * x); }

vec2 medium(vec3 p) {
  vec3 q = p * .34;
  q.xy = rotate(angle) * q.xy;
  float radius = length(q);
  vec3 direction = q / max(radius, .001);
  float warp = noise(q * .58 + seed) - .5;
  float curve = .28 * sin(direction.x * 4.4 + direction.z * 1.8)
    + .10 * sin(direction.x * 8.0 - direction.z * 3.0);
  float band = gaussian((direction.y - curve + warp * .10) * 5.0);
  if (shape > .5 && shape < 1.5) {
    float ring = length(direction.xy - vec2(-.28, .20));
    band = gaussian((ring - .34 + warp * .08) * 9.0);
  } else if (shape > 1.5) {
    float second = gaussian((direction.y + .50 * direction.x + .24 + warp * .10) * 8.0);
    band = max(band * .8, second);
  }
  // Distant cloud banks surround the observer, with quieter sky between them.
  float front = pow(max(dot(direction, normalize(vec3(.45, .10, 1.0))), 0.0), 7.0);
  float rear = .65 * pow(max(dot(direction, normalize(vec3(-.55, -.18, -1.0))), 0.0), 9.0);
  float side = .40 * pow(max(dot(direction, normalize(vec3(-1.0, .25, .20))), 0.0), 12.0);
  band *= (.08 + front + rear + side) * gaussian((radius - 5.4) * .65);
  vec3 turbulent = q * 1.4 + vec3(warp * 2.4, warp * 1.1, seed);
  float cloud = fbm(turbulent);
  float ridges = fbm(turbulent * 2.2 + vec3(11.3, 5.7, 19.4));
  float gas = smoothstep(.23, .76, cloud) * band;
  gas *= .6 + smoothstep(.25, .7, ridges) * 1.15;
  float dark = smoothstep(.49, .71, ridges + cloud * .12) * band;
  return vec2(gas, dark);
}

vec3 starLayer(vec3 direction, float scale, float offset, float brightness) {
  // A 3D star field on a sphere: no longitude seam or polar stretching. Different lattice
  // orientations keep the layers from reinforcing grid bands.
  direction.xy = rotate(offset * .37) * direction.xy;
  direction.yz = rotate(offset * .71) * direction.yz;
  vec3 grid = direction * scale;
  vec3 cell = floor(grid);
  vec3 h = hash3(cell.xy + vec2(37.0, 17.0) * cell.z + offset);
  vec3 properties = hash3(cell.zy + vec2(13.0, 73.0) * cell.x + offset + 41.3);
  vec3 delta = fract(grid) - (.15 + .7 * h);
  float radius = max(.045, scale / starRes * .58);
  radius *= mix(1.0, 1.9, step(.992, properties.z));
  float core = exp(-dot(delta, delta) / (radius * radius));
  float halo = exp(-length(delta) * 20.0) * .12;
  vec3 tint = mix(vec3(.50, .69, 1.0), vec3(1.0, .79, .52), properties.x);
  float magnitude = pow(properties.z, 14.0) * step(.82, properties.z);
  return tint * (core + halo) * magnitude * brightness;
}
`;

  // tile: column, row from the top, tiles per axis, face size. pitch turns the cube's default view centre
  // onto the field's forward axis. steps is a uniform so that the D3D compiler cannot unroll the march.
  // starScale multiplies the star lattices, starGain their light, gasGain the clouds' light. zoomK pushes
  // the clouds back: a conformal zoom about the view centre, theta' = 2 atan(k tan(theta / 2)), applied to
  // the march direction only, so the banks shrink as if farther away while the stars keep their density.
  const BAKE = `
uniform float face;
uniform vec4 tile;
uniform float pitch;
uniform int steps;
uniform float starScale;
uniform float starGain;
uniform float gasGain;
uniform float zoomK;

vec3 dropBack(vec3 d) {
  float s = length(d.xy);
  if (s < 1e-6) return d;
  float th = 2.0 * atan(zoomK * tan(0.5 * acos(clamp(d.z, -1.0, 1.0))));
  return vec3(d.xy / s * sin(th), cos(th));
}

// The cube face table WebGL samples with, image rows top-down: px py pz nx ny nz.
vec3 faceDir(float s, float t) {
  if (face < .5) return vec3(1.0, -t, -s);
  if (face < 1.5) return vec3(s, 1.0, t);
  if (face < 2.5) return vec3(s, -t, 1.0);
  if (face < 3.5) return vec3(-1.0, -t, s);
  if (face < 4.5) return vec3(s, -1.0, -t);
  return vec3(-s, -t, -1.0);
}
vec3 toField(vec2 st) {
  vec3 d = faceDir(st.x, st.y);
  float c = cos(pitch), s = sin(pitch);
  return normalize(vec3(d.x, d.y * c - d.z * s, d.y * s + d.z * c));
}

void main() {
  vec2 img = vec2(tile.x + vUV.x, tile.y + 1.0 - vUV.y) / tile.z;
  vec2 texel = floor(img * tile.w) + vec2(face * 4099.0, face * 1733.0);
  vec3 view = toField(img * 2.0 - 1.0);
  vec3 ray = dropBack(view);
  vec3 color = vec3(0.0);
  float transmission = 1.0;
  float stepLength = 20.0 / float(steps);
  float distance = 6.0 + hash3(texel).x * stepLength * .35;
  for (int i = 0; i < steps; i++) {
    if (transmission < .018) break;
    vec3 p = ray * distance;
    vec2 cloud = medium(p);
    vec3 lightDelta = normalize(p) - normalize(vec3(lightPosition.xy, 1.0 + lightPosition.z));
    float light = .55 + 2.2 * exp(-dot(lightDelta, lightDelta) * 3.0);
    float hue = smoothstep(-.2, 1.8, p.x * .16 - p.y * .10 + noise(p * .3 + seed) * .4);
    vec3 emission = mix(cold, warm, hue) * light;
    float extinction = cloud.x * .22 + cloud.y * dust * 2.3;
    float attenuate = exp(-extinction * stepLength);
    color += transmission * emission * cloud.x * .24 * stepLength * sqrt(attenuate) * gasGain;
    transmission *= attenuate;
    distance += stepLength;
  }
  vec3 stars = starLayer(view, 80.0 * starScale, 3.2, 1.65) + starLayer(view, 150.0 * starScale, 81.7, .65)
    + starLayer(view, 260.0 * starScale, 17.8, .30);
  color += (vec3(.004, .007, .015) + stars * starGain * 2.3) * transmission;
  // A sparse foreground population stays in front of the absorbing cloud.
  color += starLayer(view, 48.0 * starScale, 129.3, 1.25) * starGain;
  color = 1.0 - exp(-color * 1.75);
  color = pow(max(color, 0.0), vec3(.88));
  color += (hash3(texel + 17.17) - hash3(texel + 91.31)) / 255.0;  // a 1-LSB dither against banding
  gl_FragColor = vec4(color, 1.0);
}`;

  const UNIFORMS = ['starRes', 'seed', 'angle', 'shape', 'dust', 'cold', 'warm', 'lightPosition',
    'face', 'tile', 'pitch', 'steps', 'starScale', 'starGain', 'gasGain', 'zoomK'];

  // The original's 256x256 noise map: two value-noise slices per texel from one LCG.
  function noisePixels() {
    const size = 256, values = new Uint8Array(size * size);
    let seed = 381791;
    for (let i = 0; i < values.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      values[i] = seed >>> 24;
    }
    const pixels = new Uint8Array(values.length * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      pixels[i] = values[y * size + x];
      pixels[i + 1] = values[((y + 17) % size) * size + (x + 37) % size];
      pixels[i + 3] = 255;
    }
    return pixels;
  }

  function setup() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 8;
    const engine = new BABYLON.Engine(canvas, false, { antialias: false, stencil: false });
    if (engine.webGLVersion < 2) throw new Error('the sky bake needs WebGL 2');
    const scene = new BABYLON.Scene(engine);
    const camera = new BABYLON.FreeCamera('bakeCamera', new BABYLON.Vector3(0, 0, -1), scene);
    camera.setTarget(BABYLON.Vector3.Zero());
    const quad = new BABYLON.Mesh('bakeQuad', scene);
    quad.setVerticesData('position', [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
    quad.setIndices([0, 1, 2, 0, 2, 3]);
    quad.alwaysSelectAsActiveMesh = true;
    const mat = new BABYLON.ShaderMaterial('bakeField', scene, { vertexSource: VERTEX, fragmentSource: FIELD + BAKE },
      { attributes: ['position'], uniforms: UNIFORMS, samplers: ['noiseMap'] });
    mat.backFaceCulling = false;
    quad.material = mat;
    const noise = BABYLON.RawTexture.CreateRGBATexture(noisePixels(), 256, 256, scene, false, false,
      BABYLON.Texture.BILINEAR_SAMPLINGMODE);
    noise.wrapU = noise.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
    noise.gammaSpace = false;
    mat.setTexture('noiseMap', noise);
    mat.setFloat('seed', VEIL.seed).setFloat('angle', VEIL.angle).setFloat('shape', VEIL.shape)
      .setColor3('cold', BABYLON.Color3.FromArray(VEIL.cold)).setColor3('warm', BABYLON.Color3.FromArray(VEIL.warm))
      .setVector3('lightPosition', BABYLON.Vector3.FromArray(VEIL.light));
    let error = null;
    mat.onError = (effect, errors) => { error = String(errors || 'unknown'); };
    const ready = (async () => {
      const started = performance.now();
      while (!mat.isReady(quad)) {
        if (error) throw new Error('sky shader: ' + error.slice(0, 600));
        if (performance.now() - started > 60000) throw new Error('sky shader still compiling after 60 s');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await scene.whenReadyAsync();
    })();
    return { scene, camera, quad, mat, ready };
  }

  let gpu = null;

  /**
   * One face, tile by tile, so that no single draw nears the GPU watchdog.
   * @param {{ size: number, face: number, gas: number, zoom: number, dust: number, steps: number,
   *   starRes: number, starScale: number, starGain: number, pitch: number, tiles: number, quality: number }} p
   * @returns {Promise<string>} the face as base64 WebP
   */
  window.bakeFace = async function bakeFace(p) {
    if (!gpu) gpu = setup();
    await gpu.ready;
    gpu.mat.setFloat('dust', p.dust).setFloat('starRes', p.starRes).setFloat('face', p.face)
      .setFloat('pitch', p.pitch).setInt('steps', p.steps).setFloat('starScale', p.starScale)
      .setFloat('starGain', p.starGain).setFloat('gasGain', p.gas).setFloat('zoomK', p.zoom);
    const n = p.size, t = n / p.tiles;
    const rtt = new BABYLON.RenderTargetTexture('bakeTile', { width: t, height: t }, gpu.scene, false, false,
      BABYLON.Constants.TEXTURETYPE_UNSIGNED_BYTE);
    rtt.renderList = [gpu.quad];
    rtt.activeCamera = gpu.camera;
    rtt.clearColor = new BABYLON.Color4(0, 0, 0, 1);
    const image = new ImageData(n, n);
    try {
      for (let ty = 0; ty < p.tiles; ty++) for (let tx = 0; tx < p.tiles; tx++) {
        gpu.mat.setVector4('tile', new BABYLON.Vector4(tx, ty, p.tiles, n));
        gpu.scene.incrementRenderId();
        gpu.scene.resetCachedMaterial();
        rtt.render();
        const px = /** @type {Uint8Array} */ (await rtt.readPixels(0, 0, null, true));
        for (let y = 0; y < t; y++) { // GL rows run bottom-up, the face image's top-down
          const src = (t - 1 - y) * t * 4;
          image.data.set(px.subarray(src, src + t * 4), ((ty * t + y) * n + tx * t) * 4);
        }
      }
    } finally {
      rtt.dispose();
    }
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = n;
    canvas.getContext('2d').putImageData(image, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', p.quality));
    if (!blob || blob.type !== 'image/webp') throw new Error('this Chromium has no WebP encoder');
    const url = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    return url.slice(url.indexOf(',') + 1);
  };
})();

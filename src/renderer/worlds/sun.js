// @ts-check
// The system sun (kit 15 W5): the approved preview's photosphere, injected by a material plugin
// into the view's StandardMaterial, so the colour it is tinted by is still the material's
// emissiveColor that the view pulses (polish P3), plus the preview's corona and glow billboards.
'use strict';

(function () {
  const AUR = window.AUR;
  const worlds = AUR.worlds;
  const { TONE, NOISE, BILLBOARD_VERTEX, CORONA_FRAGMENT, GLOW_FRAGMENT } = worlds.shaders;

  // The preview's SUN_FRAGMENT, its cells() unchanged and its main() reading the StandardMaterial's
  // varyings: animated Worley granulation, supergranulation, sunspot belts, faculae, limb
  // darkening 0.47/0.23 and limb reddening, tone mapped so the core keeps its colour. The result
  // replaces the material's own colour after its image processing, which the worlds bypass too.
  // Granulation and faculae are skipped when sunDetail is 0, where they add nothing. One change:
  // the preview's per-channel ACES bleaches the pale suns (#dfe6ff kept 16-24 % of its tint,
  // #9db8ff 23-31 %), so the tone map goes TINT_KEEP of the way to ACES on the brightest channel
  // with the colour's ratios kept. The brightest channel is unchanged; #ffd27d's core goes from
  // [229,220,181] to about [229,214,169], #9db8ff's from [200,212,229] to about [190,203,229].
  const DEFINITIONS = `
varying vec3 vSunLocal;
const float exposure = 1.0;
const float TINT_KEEP = 0.3;
${TONE}
${NOISE}
vec2 cells(vec3 p, float t) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  float f1 = 8.0;
  float f2 = 8.0;
  for (int x = -1; x <= 1; x++) {
    for (int y = -1; y <= 1; y++) {
      for (int z = -1; z <= 1; z++) {
        vec3 g = vec3(float(x), float(y), float(z));
        vec3 h = vec3(hash13(i + g), hash13(i + g + 19.19), hash13(i + g + 47.53));
        vec3 o = 0.5 + 0.42 * sin(t + 6.2831 * h);
        vec3 d = g + o - f;
        float dd = dot(d, d);
        if (dd < f1) { f2 = f1; f1 = dd; } else if (dd < f2) { f2 = dd; }
      }
    }
  }
  return vec2(sqrt(f1), sqrt(f2));
}`;
  const PHOTOSPHERE = `{
  vec3 n = normalize(vNormalW);
  vec3 v = normalize(vEyePosition.xyz - vPositionW);
  float mu = clamp(dot(n, v), 0.0, 1.0);
  float x = 1.0 - mu;
  vec3 p = normalize(vSunLocal);
  float grain = 1.0;
  float faculae = 0.0;
  if (sunDetail > 0.0) {
    vec3 bend = vec3(vnoise(p * 6.0 + sunTime * 0.01), vnoise(p * 6.0 + 7.3), vnoise(p * 6.0 - 3.1 + sunTime * 0.012)) - 0.5;
    vec2 c1 = cells(p * 40.0 + bend * 1.6, sunTime * 0.35);
    float gran = smoothstep(0.0, 0.5, c1.y - c1.x);
    vec2 c2 = cells(p * 96.0 + bend * 3.0 + 13.0, sunTime * 0.5);
    float fine = smoothstep(0.0, 0.45, c2.y - c2.x);
    grain = mix(1.0, 0.85 + 0.15 * gran * (0.8 + 0.2 * fine), sunDetail);
    faculae = smoothstep(0.55, 0.8, fbm3(p * 12.0 + 5.0)) * x * x * 0.35 * sunDetail;
  }
  grain *= 0.92 + 0.16 * fbm3(p * 4.0 + vec3(0.0, sunTime * 0.004, 0.0));
  float lat = abs(p.y);
  float belt = smoothstep(0.12, 0.22, lat) * (1.0 - smoothstep(0.45, 0.6, lat));
  float s = fbm3(p * 2.6 + 17.0);
  float penumbra = smoothstep(0.6, 0.65, s) * belt;
  float umbra = smoothstep(0.66, 0.71, s) * belt;
  float spots = 1.0 - penumbra * 0.35 - umbra * 0.5;
  float limb = 1.0 - 0.47 * x - 0.23 * x * x;
  vec3 limbTint = mix(vec3(1.0, 0.52, 0.24), vec3(1.0), pow(mu, 0.5));
  vec3 photo = pow(vEmissiveColor, vec3(1.5)) * limbTint * (grain * spots * limb * 0.95 + faculae);
  float peak = max(max(photo.r, photo.g), max(photo.b, 0.0001));
  color.rgb = mix(displayColor(photo), pow(photo / peak, vec3(1.0 / 2.2)) * displayColor(vec3(peak)), TINT_KEEP);
}`;

  class PhotospherePlugin extends BABYLON.MaterialPluginBase {
    constructor(material) {
      super(material, 'photosphere', 200, undefined, true, true);
      this.time = 0;   // seconds, from the view's clock
      this.detail = 1; // granulation and faculae, 0 to 1
    }
    getClassName() { return 'PhotospherePlugin'; }
    getUniforms() {
      return {
        ubo: [{ name: 'sunTime', size: 1, type: 'float' }, { name: 'sunDetail', size: 1, type: 'float' }],
        fragment: 'uniform float sunTime;\nuniform float sunDetail;',
      };
    }
    bindForSubMesh(uniformBuffer) {
      uniformBuffer.updateFloat('sunTime', this.time);
      uniformBuffer.updateFloat('sunDetail', this.detail);
    }
    getCustomCode(shaderType) {
      return shaderType === 'vertex'
        ? { CUSTOM_VERTEX_DEFINITIONS: 'varying vec3 vSunLocal;', CUSTOM_VERTEX_MAIN_END: 'vSunLocal = positionUpdated;' }
        : { CUSTOM_FRAGMENT_DEFINITIONS: DEFINITIONS, CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: PHOTOSPHERE };
    }
  }

  // opts = { diameter, glow, tier }. The caller keeps the sun mesh, its material and its pulse, and
  // takes the sun out of the glow pass. The billboards keep their own copy of the sun's colour.
  function createSun(scene, sun, opts) {
    const { diameter, glow } = opts;
    const plugin = new PhotospherePlugin(sun.material);
    const tint = sun.material.emissiveColor.clone();
    function billboard(name, size, fragmentSource, uniforms) {
      const plane = BABYLON.MeshBuilder.CreatePlane(name, { size }, scene);
      plane.position.copyFrom(sun.position);
      plane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
      plane.isPickable = false;
      plane.alphaIndex = 10; // before the worlds' shells, as in the preview
      const material = worlds.shader(scene, name, fragmentSource, {
        vertex: BILLBOARD_VERTEX, attributes: ['position', 'uv'], uniforms, alpha: true, add: true, doubleSided: true,
      });
      material.setColor3('sunTint', tint);
      plane.material = material;
      glow.addExcludedMesh(plane);
      return material;
    }
    const corona = billboard('sun-corona', diameter * 3.6, CORONA_FRAGMENT, ['worldViewProjection', 'sunTint', 'exposure', 'rs', 'time', 'strength']);
    corona.setFloat('rs', 0.5 / 1.8);
    corona.setFloat('strength', 0.45);
    billboard('sun-glow', diameter * 10, GLOW_FRAGMENT, ['worldViewProjection', 'sunTint', 'strength']).setFloat('strength', 0.24);
    let time = 0, granulation = opts.tier !== 'low';

    return {
      tint,
      setTier(key) { granulation = key !== 'low'; },
      // Granulation fades in as the sun grows on screen, fully from 420 px across, as in the
      // preview: smaller, its cells would be finer than a pixel and shimmer.
      update(dt) {
        time += dt;
        plugin.time = time;
        corona.setFloat('time', time);
        const unitsPerPixel = granulation ? AUR.unitsPerPixel(scene) : 0;
        const px = unitsPerPixel
          ? diameter / (BABYLON.Vector3.Distance(scene.activeCamera.globalPosition, sun.position) * unitsPerPixel) : 0;
        plugin.detail = AUR.clamp((px - 60) / 360, 0, 1);
      },
    };
  }

  worlds.createSun = createSun;
})();

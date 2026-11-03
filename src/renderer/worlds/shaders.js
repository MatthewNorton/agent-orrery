// @ts-check
// GLSL for the world materials (kit 15 W4), ported from the approved preview, itself sidereal-v2
// shaders.js (owner's MIT sandbox-animations-v2 PR #31), with two fixes: pow() never gets a base
// below zero, and the ring shadow samples outside per-pixel branches, so its mip level is defined.
// Every fragment tone maps with the same ACES curve (displayColor), so worlds keep their colour
// without scene-level tone mapping, which would restyle the ships, glyphs and gold samples.
'use strict';

(function () {
  const AUR = window.AUR;

  const TONE = `
vec3 displayColor(vec3 color) {
  vec3 x = max(color * exposure, vec3(0.0));
  x = clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
  return pow(x, vec3(1.0 / 2.2));
}`;

  // Value noise and five-octave fbm for the star's surface (worlds/sun.js).
  const NOISE = `
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float a = hash13(i);
  float b = hash13(i + vec3(1.0, 0.0, 0.0));
  float c = hash13(i + vec3(0.0, 1.0, 0.0));
  float d = hash13(i + vec3(1.0, 1.0, 0.0));
  float e = hash13(i + vec3(0.0, 0.0, 1.0));
  float g = hash13(i + vec3(1.0, 0.0, 1.0));
  float h = hash13(i + vec3(0.0, 1.0, 1.0));
  float k = hash13(i + vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, g, u.x), mix(h, k, u.x), u.y), u.z);
}
float fbm3(vec3 p) {
  float total = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 5; i++) {
    total += vnoise(p) * amp;
    p = p * 2.03 + vec3(1.7, 9.2, 4.1);
    amp *= 0.5;
  }
  return total / 0.96875;
}`;

  const WORLD_VERTEX = `
precision highp float;
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
uniform mat4 world;
uniform mat4 worldViewProjection;
varying vec3 vPosition;
varying vec3 vNormal;
varying vec3 vTangent;
varying vec2 vUV;
void main() {
  mat3 basis = mat3(world[0].xyz, world[1].xyz, world[2].xyz);
  vPosition = (world * vec4(position, 1.0)).xyz;
  vNormal = normalize(basis * normal);
  float longitude = uv.x * 6.28318530718;
  vTangent = normalize(basis * vec3(sin(longitude), 0.0, cos(longitude)));
  vUV = uv;
  gl_Position = worldViewProjection * vec4(position, 1.0);
}`;

  // Albedo from the generated map, relief from its height channel, Lambert light with cloud and
  // ring shadows, ocean glint, night lights or lava, and an atmospheric limb.
  const SURFACE_FRAGMENT = `
precision highp float;
varying vec3 vPosition;
varying vec3 vNormal;
varying vec3 vTangent;
varying vec2 vUV;
uniform sampler2D surfaceMap;
uniform sampler2D nightMap;
uniform sampler2D cloudMap;
uniform sampler2D ringMap;
uniform vec3 sunPosition;
uniform vec3 cameraPosition;
uniform vec3 atmosphereColor;
uniform vec3 sunColor;
uniform mat4 ringSpace;
uniform vec2 ringRange;
uniform vec2 mapStep;
uniform float exposure;
uniform float relief;
uniform float glowDay;
uniform float showClouds;
uniform float showRings;
uniform float haze;
uniform float cloudOffset;
uniform float ambient;
${TONE}
void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(cameraPosition - vPosition);
  vec3 l = normalize(sunPosition - vPosition);
  vec2 mapUV = vec2(1.0 - vUV.x, vUV.y);
  if (relief > 0.0) {
    vec3 tangent = normalize(vTangent);
    vec3 bitangent = normalize(cross(n, tangent));
    float east = texture2D(surfaceMap, mapUV + vec2(mapStep.x, 0.0)).a;
    float west = texture2D(surfaceMap, mapUV - vec2(mapStep.x, 0.0)).a;
    float south = texture2D(surfaceMap, mapUV + vec2(0.0, mapStep.y)).a;
    float north = texture2D(surfaceMap, mapUV - vec2(0.0, mapStep.y)).a;
    float circumference = max(sin(vUV.y * 3.14159265359), 0.15);
    n = normalize(n - relief * 18.0 * ((east - west) / circumference * tangent + (south - north) * bitangent));
  }
  float daylight = dot(n, l);
  vec4 texel = texture2D(surfaceMap, mapUV);
  vec3 albedo = pow(texel.rgb, vec3(2.2));
  float lighting = pow(max(daylight, 0.0), 0.85);
  float shade = 1.0;
  if (showClouds > 0.5) {
    float cloud = texture2D(cloudMap, mapUV + vec2(cloudOffset + 0.0015, 0.0008)).r;
    shade *= 1.0 - smoothstep(0.15, 0.85, cloud) * 0.52;
  }
  if (showRings > 0.5) {
    vec3 p = (ringSpace * vec4(vPosition, 1.0)).xyz;
    vec3 rl = normalize(mat3(ringSpace[0].xyz, ringSpace[1].xyz, ringSpace[2].xyz) * l);
    bool crosses = abs(rl.y) > 0.001;
    float t = -p.y / (crosses ? rl.y : 1.0);
    float radius = length((p + rl * t).xz);
    float opacity = texture2D(ringMap, vec2((radius - ringRange.x) / (ringRange.y - ringRange.x), 0.5)).a;
    shade *= 1.0 - opacity * 0.88 * float(crosses && t > 0.0 && radius > ringRange.x && radius < ringRange.y);
  }
  vec3 color = albedo * (ambient + 1.25 * lighting * shade * sunColor);
  vec4 night = texture2D(nightMap, mapUV);
  if (night.a > 0.0) {
    vec3 halfway = normalize(l + v);
    float glint = pow(max(dot(n, halfway), 0.0), 110.0);
    float fresnel = 0.025 + 0.25 * pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 5.0);
    color += vec3(1.0, 0.91, 0.78) * sunColor * glint * night.a * fresnel * 3.0 * lighting * shade;
  }
  float dark = 1.0 - smoothstep(-0.22, 0.08, daylight);
  color += night.rgb * 2.4 * mix(glowDay, 1.0, dark);
  float limb = pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 4.0);
  color += atmosphereColor * limb * haze * smoothstep(-0.18, 0.35, daylight) * 0.4;
  gl_FragColor = vec4(displayColor(color), 1.0);
}`;

  const CLOUD_FRAGMENT = `
precision highp float;
varying vec3 vPosition;
varying vec3 vNormal;
varying vec2 vUV;
uniform sampler2D cloudMap;
uniform vec3 sunPosition;
uniform vec3 sunColor;
uniform float cloudOffset;
uniform float exposure;
${TONE}
void main() {
  float density = texture2D(cloudMap, vec2(1.0 - vUV.x + cloudOffset, vUV.y)).r;
  vec3 l = normalize(sunPosition - vPosition);
  float daylight = dot(normalize(vNormal), l);
  float lighting = pow(max(daylight, 0.0), 0.8);
  vec3 color = vec3(1.0, 0.98, 0.94) * sunColor * (0.008 + 1.6 * lighting);
  color += vec3(0.3, 0.12, 0.045) * exp(-abs(daylight) * 22.0);
  gl_FragColor = vec4(displayColor(color), smoothstep(0.08, 0.92, density) * 0.96);
}`;

  const ATMO_FRAGMENT = `
precision highp float;
varying vec3 vPosition;
varying vec3 vNormal;
uniform vec3 sunPosition;
uniform vec3 cameraPosition;
uniform vec3 atmosphereColor;
uniform float exposure;
uniform float haze;
${TONE}
void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(cameraPosition - vPosition);
  vec3 l = normalize(sunPosition - vPosition);
  float rim = pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 5.0);
  float daylight = smoothstep(-0.25, 0.5, dot(n, l));
  gl_FragColor = vec4(displayColor(atmosphereColor * 1.6), rim * haze * daylight * 0.8);
}`;

  const RING_FRAGMENT = `
precision highp float;
varying vec3 vPosition;
varying vec3 vNormal;
varying vec2 vUV;
uniform sampler2D ringMap;
uniform vec3 sunPosition;
uniform vec3 sunColor;
uniform vec3 planetCenter;
uniform float planetRadius;
uniform float exposure;
${TONE}
void main() {
  vec4 ring = texture2D(ringMap, vec2(vUV.x, 0.5));
  vec3 l = normalize(sunPosition - vPosition);
  float illumination = 0.3 + 0.9 * abs(dot(normalize(vNormal), l));
  vec3 p = (vPosition - planetCenter) / planetRadius;
  float b = dot(p, l);
  float closest = length(p - l * b);
  float eclipse = b < 0.0 ? smoothstep(0.93, 1.03, closest) : 1.0;
  vec3 color = pow(ring.rgb, vec3(2.2)) * sunColor * illumination * mix(0.025, 1.0, eclipse);
  gl_FragColor = vec4(displayColor(color), ring.a * 0.92);
}`;

  AUR.worlds.shaders = Object.freeze({ TONE, NOISE, WORLD_VERTEX, SURFACE_FRAGMENT, CLOUD_FRAGMENT, ATMO_FRAGMENT, RING_FRAGMENT });
})();

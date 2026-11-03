// Reference world generator: the exact worldGenerator() of the approved kit 15 preview
// (reference/procedural-worlds.html, published 2026-11-01). A port of the owner's MIT
// sandbox-animations-v2 PR #31 (experiments/sidereal-v2/world-generator.mjs) to the app's
// five world classes. grade-worlds.mjs uses it as the parity oracle; the kill-switch loads it
// into a classic worker with importScripts. Frozen: do not edit.
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReferenceWorldGenerator = api;
})(typeof self !== 'undefined' ? self : this, function worldGenerator() {
  const OUT = new Float64Array(9);
  const clamp = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const mix = (a, b, t) => a + (b - a) * t;
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  const blend = (a, b, t) => { t = clamp(t); return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)]; };
  const scale = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
  const lift = (c, k) => [c[0] + k, c[1] + k, c[2] + k];
  const ramp = (c, t) => (t < 0.5 ? blend(c[0], c[1], t * 2) : blend(c[1], c[2], (t - 0.5) * 2));
  const byte = (x) => Math.round(clamp(x) * 255);
  const hex = (h) => { const v = parseInt(h.slice(1), 16); return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]; };
  const lcg = (seed) => { let s = seed >>> 0; return () => ((s = (Math.imul(1664525, s) + 1013904223) >>> 0) / 4294967296); };
  const unitVector = (random, yMin, yMax) => {
    const y = yMin + random() * (yMax - yMin), angle = random() * Math.PI * 2, r = Math.sqrt(1 - y * y);
    return [r * Math.cos(angle), y, r * Math.sin(angle)];
  };

  // Rotation about a storm's axis curls nearby belts without a UV seam.
  function vortex(x, y, z, axis, tightness, turn) {
    const dot = x * axis[0] + y * axis[1] + z * axis[2];
    const angle = turn * Math.exp(-Math.max(0, 2 - 2 * dot) * tightness);
    const c = Math.cos(angle), s = Math.sin(angle), t = dot * (1 - c);
    return [x * c + (axis[1] * z - axis[2] * y) * s + axis[0] * t,
      y * c + (axis[2] * x - axis[0] * z) * s + axis[1] * t,
      z * c + (axis[0] * y - axis[1] * x) * s + axis[2] * t];
  }

  function craterBands(seed) {
    const random = lcg(seed);
    const craters = [{ axis: unitVector(random, -0.6, 0.6), radius: 0.2 + random() * 0.1 }];
    for (let i = 0; i < 164; i++) {
      const y = random() * 2 - 1, angle = random() * Math.PI * 2, r = Math.sqrt(1 - y * y);
      const radius = i < 44 ? 0.035 + random() ** 2 * 0.19 : 0.012 + random() ** 2 * 0.045;
      craters.push({ axis: [r * Math.cos(angle), y, r * Math.sin(angle)], radius });
    }
    const normalized = craters.map(({ axis, radius }) => {
      const length = Math.hypot(axis[0], axis[1], axis[2]);
      const distance2 = radius ** 2 * 3.24;
      return { axis: axis.map((value) => value / length), radius, distance2,
        reach: Math.sqrt(distance2) + 1e-12, strength: Math.min(1, radius * 12) };
    });
    return Array.from({ length: 64 }, (_, i) => normalized.filter((crater) =>
      crater.axis[1] + crater.reach >= i / 32 - 1 && crater.axis[1] - crater.reach <= (i + 1) / 32 - 1));
  }

  function noiseField(seed) {
    const table = Array.from({ length: 256 }, (_, i) => i);
    const random = lcg(seed);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      const swap = table[i]; table[i] = table[j]; table[j] = swap;
    }
    const p = Uint16Array.from(table.concat(table));
    const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
    const grad = (hash, x, y, z) => {
      const h = hash & 15, u = h < 8 ? x : y, v = h < 4 ? y : h === 12 || h === 14 ? x : z;
      return ((h & 1) ? -u : u) + ((h & 2) ? -v : v);
    };
    function noise(x, y, z) {
      const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
      x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
      const u = fade(x), v = fade(y), w = fade(z);
      const A = p[X] + Y, AA = p[A] + Z, AB = p[A + 1] + Z;
      const B = p[X + 1] + Y, BA = p[B] + Z, BB = p[B + 1] + Z;
      return mix(
        mix(mix(grad(p[AA], x, y, z), grad(p[BA], x - 1, y, z), u),
          mix(grad(p[AB], x, y - 1, z), grad(p[BB], x - 1, y - 1, z), u), v),
        mix(mix(grad(p[AA + 1], x, y, z - 1), grad(p[BA + 1], x - 1, y, z - 1), u),
          mix(grad(p[AB + 1], x, y - 1, z - 1), grad(p[BB + 1], x - 1, y - 1, z - 1), u), v), w);
    }
    function fbm(x, y, z, octaves = 5) {
      let sum = 0, amplitude = 0.55;
      for (let i = 0; i < octaves; i++) {
        sum += noise(x, y, z) * amplitude;
        x = x * 2.03 + 11.7; y = y * 2.03 + 5.3; z = z * 2.03 + 8.9;
        amplitude *= 0.5;
      }
      return sum;
    }
    return { noise, fbm };
  }

  function createSampler(cls, seed, palette) {
    const { noise, fbm } = noiseField(seed);
    const P = palette.map(hex);
    const random = lcg((seed ^ 0x9e3779b9) >>> 0);
    const craters = cls === 'rocky' ? craterBands(seed) : null;
    const warp = cls !== 'rocky' && cls !== 'gas';
    const storms = cls === 'gas' ? [unitVector(random, -0.5, -0.15), unitVector(random, 0.12, 0.45)] : null;
    const bandFreq = 19 + random() * 8;
    const belts = blend(P[0], P[1], 0.45);
    const polarHaze = blend(P[0], P[1], 0.3);
    return (x, y, z) => {
      const broad = fbm(x * 2.8 + 4.1, y * 2.8 + 8.7, z * 2.8 - 2.4);
      const detail = fbm(x * 42 + 1.2, y * 42, z * 42, 4);
      let wx = x, wy = y, wz = z;
      if (warp) {
        wx = x + 0.24 * noise(x * 3 + 8, y * 3, z * 3);
        wy = y + 0.24 * noise(x * 3, y * 3 + 6, z * 3);
        wz = z + 0.24 * noise(x * 3, y * 3, z * 3 + 3);
      }
      let color, height = 0.5, er = 0, eg = 0, eb = 0, specular = 0, cloud = 0;

      if (cls === 'rocky') { // sidereal "morrow": banded crater field
        let relief = 0, ejecta = 0, floor = 0;
        for (const crater of craters[Math.min(63, Math.floor((y + 1) * 32))]) {
          const d2 = Math.max(0, 2 - 2 * (x * crater.axis[0] + y * crater.axis[1] + z * crater.axis[2]));
          if (d2 > crater.distance2) continue;
          const r = Math.sqrt(d2) / crater.radius;
          const bowl = Math.max(0, 1 - r * r);
          const rim = Math.exp(-(((r - 1) / 0.14) ** 2));
          relief += (rim * 0.22 - bowl * 0.30) * crater.strength;
          floor = Math.max(floor, (1 - smooth(0.65, 0.95, r)) * 0.48);
          ejecta = Math.max(ejecta, Math.exp(-(((r - 1.12) / 0.27) ** 2)) * (0.5 + detail));
        }
        const maria = smooth(-0.05, 0.22, fbm(x * 1.7 + 3.3, y * 1.7 - 1.1, z * 1.7 + 7.7, 4));
        const tone = clamp(0.56 + broad * 0.55 + detail * 0.22 - floor * 0.28 - maria * 0.32);
        color = blend(ramp(P, tone), scale(P[2], 1.08), ejecta * 0.45);
        height = 0.52 + broad * 0.12 + detail * 0.018 + relief - maria * 0.03;
      } else if (cls === 'gas') { // sidereal "zephra": vortex-curled belts
        const first = vortex(x, y, z, storms[0], 18, 4.8);
        const s = vortex(first[0], first[1], first[2], storms[1], 25, -3.2);
        const turbulence = fbm(s[0] * 12 + broad, s[1] * 17, s[2] * 12, 6);
        const belt = s[1] * 68 + turbulence * 3.4;
        const band = 0.5 + 0.5 * Math.sin(s[1] * bandFreq + turbulence * 1.7);
        color = blend(P[1], P[2], smooth(0.06, 0.94, band));
        const dark = smooth(0.66, 0.98, 0.5 + 0.5 * Math.sin(s[1] * 15 + broad * 1.4));
        color = blend(color, belts, dark * 0.7);
        const stream = 0.5 + 0.5 * Math.sin(belt + turbulence * 2);
        const filaments = 0.5 + 0.5 * Math.sin(belt * 3.7 + turbulence * 6);
        color = lift(scale(color, 0.78 + stream * 0.17 + filaments * 0.07), detail * 0.035);
        color = blend(color, polarHaze, smooth(0.74, 0.98, Math.abs(y)) * 0.55);
      } else if (cls === 'ice') { // sidereal "nivalis": fractured glacial plates
        const faults = Math.abs(fbm(wx * 6.7 + 3, wy * 6.7, wz * 6.7, 5));
        const crack = 1 - smooth(0.006, 0.07, faults);
        const margin = 1 - smooth(0.02, 0.16, faults);
        const oldIce = smooth(-0.12, 0.22, broad);
        color = blend(scale(P[2], 0.87), P[1], oldIce * 0.64);
        const dust = smooth(0.12, 0.28, fbm(x * 12, y * 12, z * 12, 4));
        color = blend(color, [0.48, 0.39, 0.28], dust * (1 - smooth(0.05, 0.14, faults)) * 0.35);
        color = blend(color, [0.56, 0.43, 0.34], margin * 0.38); // stained lineae margins
        color = lift(blend(color, blend(P[0], [0.42, 0.3, 0.24], 0.6), crack * 0.55), detail * 0.11);
        color = blend(color, [0.88, 0.93, 0.95], smooth(0.72, 0.93, Math.abs(y) + broad * 0.1) * 0.6);
        height = 0.62 + detail * 0.24 - crack * 0.22 - margin * 0.06 + broad * 0.13;
        specular = 0.12 * (1 - crack);
      } else if (cls === 'volcanic') { // sidereal "pyra": basalt plates and molten fissures
        const plates = Math.abs(fbm(wx * 7.5, wy * 7.5, wz * 7.5, 6));
        const active = smooth(-0.08, 0.24, broad);
        const fissure = (1 - smooth(0.009, 0.055, plates)) * active;
        const pools = smooth(0.20, 0.34, fbm(wx * 5 + 13, wy * 5, wz * 5)) * active;
        const heat = Math.max(fissure, pools);
        color = blend(scale(P[0], 2.3), P[1], clamp(0.3 + detail * 0.9 + broad * 0.7) * 0.75);
        color = blend(color, [0.46, 0.13, 0.025], smooth(0.015, 0.32, heat));
        er = heat * 0.62; eg = heat * heat * 0.2; eb = heat ** 4 * 0.02;
        height = 0.42 + detail * 0.32 + broad * 0.24 - heat * 0.19;
      } else { // oceanic, sidereal "nerai": archipelagos, weather, glint, night lights
        const terrain = fbm(wx * 4.1 + 2, wy * 4.1, wz * 4.1) + broad * 0.24 - 0.09;
        const land = smooth(0.015, 0.037, terrain);
        const shallows = smooth(-0.11, 0.025, terrain);
        const water = blend(P[0], P[1], shallows * 0.85);
        const mountains = smooth(0.08, 0.42, terrain + detail * 0.22);
        const lat = Math.abs(y);
        const arid = smooth(0.15, 0.35, lat) * (1 - smooth(0.42, 0.6, lat)) * smooth(-0.1, 0.2, fbm(x * 3 + 9, y * 3, z * 3, 3));
        let ground = blend([0.16, 0.23, 0.12], [0.47, 0.44, 0.33], mountains);
        ground = blend(ground, [0.62, 0.52, 0.36], arid * 0.7);
        ground = blend(ground, P[2], smooth(0.3, 0.6, mountains) * 0.35);
        const ice = smooth(0.74, 0.9, lat + mountains * 0.25 + detail * 0.05);
        ground = blend(ground, [0.86, 0.9, 0.92], ice);
        const seaIce = smooth(0.84, 0.95, lat + detail * 0.1) * (1 - land);
        color = blend(blend(water, ground, land), [0.8, 0.86, 0.9], seaIce);
        color = lift(color, detail * 0.045 * land);
        const coast = Math.exp(-Math.abs(terrain - 0.03) * 30) * land;
        const settled = smooth(0, 0.25, fbm(x * 9 + 4, y * 9, z * 9, 4)) * (1 - mountains) * (1 - ice) * land;
        const speck = smooth(0.15, 0.45, noise(x * 160, y * 160, z * 160));
        const lights = clamp((coast * 0.7 + 0.3) * settled * speck * 1.6) * 0.55;
        er = lights; eg = lights * 0.72; eb = lights * 0.42;
        specular = (1 - land) * (1 - seaIce);
        height = 0.25 + land * (0.12 + Math.max(terrain, 0) * 0.8 + detail * 0.16);
        const weather = fbm(wx * 6 + y * 3, wy * 7 - 12, wz * 6, 6);
        const cells = 0.75 + 0.25 * Math.cos(lat * 9.5);
        cloud = smooth(0.015, 0.38, weather * cells + (cells - 0.75) * 0.1) * 0.88;
      }
      OUT[0] = color[0]; OUT[1] = color[1]; OUT[2] = color[2]; OUT[3] = height;
      OUT[4] = er; OUT[5] = eg; OUT[6] = eb; OUT[7] = specular; OUT[8] = cloud;
    };
  }

  function generate(job) {
    const { cls, seed, hue, palette, width, height } = job;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || width > 2048 || height > 1024) {
      throw new RangeError('World maps need 2 × 2 to 2048 × 1024 pixels.');
    }
    const sample = createSampler(cls, seed >>> 0, palette);
    const surface = new Uint8Array(width * height * 4);
    const emission = new Uint8Array(surface.length);
    const clouds = cls === 'oceanic' ? new Uint8Array(surface.length) : null;
    const hr = 1 + hue, hg = 1 - hue * 0.35, hb = 1 - hue; // the app's per-planet hue shift
    const cosLon = new Float64Array(width), sinLon = new Float64Array(width);
    for (let col = 0; col < width; col++) {
      const longitude = Math.PI * 2 * ((col + 0.5) / width);
      cosLon[col] = Math.cos(longitude); sinLon[col] = Math.sin(longitude);
    }
    for (let row = 0; row < height; row++) {
      const latitude = Math.PI * ((row + 0.5) / height); // pixel centres: filtering wraps cleanly
      const radius = Math.sin(latitude), y = Math.cos(latitude);
      for (let col = 0; col < width; col++) {
        sample(radius * cosLon[col], y, radius * sinLon[col]);
        const o = (row * width + col) * 4;
        surface[o] = byte(OUT[0] * hr); surface[o + 1] = byte(OUT[1] * hg); surface[o + 2] = byte(OUT[2] * hb); surface[o + 3] = byte(OUT[3]);
        emission[o] = byte(OUT[4]); emission[o + 1] = byte(OUT[5]); emission[o + 2] = byte(OUT[6]); emission[o + 3] = byte(OUT[7]);
        if (clouds) { const d = byte(OUT[8]); clouds[o] = clouds[o + 1] = clouds[o + 2] = d; clouds[o + 3] = 255; }
      }
    }
    let rings = null;
    if (job.rings) {
      const P = palette.map(hex), random = lcg((seed ^ 0x2545f491) >>> 0);
      const f1 = 300 + random() * 180, f2 = 800 + random() * 250, f3 = 140 + random() * 60, gapAt = 0.42 + random() * 0.16;
      rings = new Uint8Array(1024 * 4);
      for (let i = 0; i < 1024; i++) {
        const r = i / 1023;
        const bands = 0.5 + 0.25 * Math.sin(r * f1) + 0.15 * Math.sin(r * f2) + 0.1 * Math.sin(r * f3);
        const gap = 1 - smooth(0.014, 0.022, Math.abs(r - gapAt));
        const edge = smooth(0.01, 0.07, r) * (1 - smooth(0.89, 0.99, r));
        const tint = blend(blend(P[0], P[1], 0.55), P[2], 0.5 + 0.5 * Math.sin(r * 13));
        for (let c = 0; c < 3; c++) rings[i * 4 + c] = byte(tint[c] * (0.68 + bands * 0.32));
        rings[i * 4 + 3] = byte(edge * (1 - gap) * (0.28 + bands * 0.65));
      }
    }
    return { width, height, surface, emission, clouds, rings };
  }
  return { generate };
});

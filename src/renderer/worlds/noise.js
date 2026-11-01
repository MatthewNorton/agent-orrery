// @ts-check
// World maps, part 1 of 3: colour maths, seeded random numbers and 3D Perlin noise sampled on
// the unit sphere, so the maps have no seam and no pole pinch. Pure: the page, worlds/worker.js
// and Node load this same file, so it never touches Babylon, window or document. Ports the
// owner's MIT sandbox-animations-v2 PR #31 (experiments/sidereal-v2/world-generator.mjs).
'use strict';

(function (root) {
  const AUR = (root.AUR = root.AUR || {});
  const worlds = (AUR.worlds = AUR.worlds || {});

  const clamp = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const mix = (a, b, t) => a + (b - a) * t;
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  const blend = (a, b, t) => { t = clamp(t); return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)]; };
  const scale = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
  const lift = (c, k) => [c[0] + k, c[1] + k, c[2] + k];
  const ramp = (c, t) => (t < 0.5 ? blend(c[0], c[1], t * 2) : blend(c[1], c[2], (t - 0.5) * 2));
  const byte = (x) => Math.round(clamp(x) * 255);
  const hex = (h) => { const v = parseInt(h.slice(1), 16); return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]; };
  // Numerical Recipes LCG: the generator's only source of randomness, so a seed is a world.
  const lcg = (seed) => { let s = seed >>> 0; return () => ((s = (Math.imul(1664525, s) + 1013904223) >>> 0) / 4294967296); };
  const unitVector = (random, yMin, yMax) => {
    const y = yMin + random() * (yMax - yMin), angle = random() * Math.PI * 2, r = Math.sqrt(1 - y * y);
    return [r * Math.cos(angle), y, r * Math.sin(angle)];
  };

  // Ken Perlin's improved noise over a seeded permutation, and its fractal sum.
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

  worlds.math = Object.freeze({ clamp, mix, smooth, blend, scale, lift, ramp, byte, hex, lcg, unitVector });
  worlds.noiseField = noiseField;
})(self);

// @ts-check
// The light of a galaxy as a field: an emission and dust atlas over its disc,
// and the stars drawn from that atlas, in a fixed local frame (disc radius DISC) that the renderer
// scales to the galaxy's radius. The arms wind logarithmically, as a spiral galaxy's do; the
// galaxy's systems scatter through the disc on their own (galaxy-layout.js). Pure and
// dependency-free; the Node tests load it directly.
'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AUR_FIELD = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const DISC = 23.5;
  const EXTENT = 25;
  const SLAB = 4;
  const BOX = { width: 2 * EXTENT, height: 2 * SLAB, depth: 2 * EXTENT };
  const DISK_HEIGHT = [0.18, 0.012];
  const DISK_SHARE = 0.78;
  const YOUNG_SHARE = 0.35;
  const CORE_RADIUS = 0.7;
  const CORE_FLATTEN = 0.43;
  const TINT = 0.35;
  const TAU = Math.PI * 2;

  const clamp = (value, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, value));
  const smooth = (lo, hi, value) => { const t = clamp((value - lo) / (hi - lo)); return t * t * (3 - 2 * t); };

  // Own copy of mulberry32 (src/main/shared/hash.js), so the field stays loadable without AUR.
  function mulberry32(seed) {
    return () => {
      seed |= 0; seed = seed + 0x6d2b79f5 | 0;
      let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
      value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
      return ((value ^ value >>> 14) >>> 0) / 4294967296;
    };
  }

  function hash(x, y) {
    let n = Math.imul(x, 374761393) + Math.imul(y, 668265263) | 0;
    n = Math.imul(n ^ n >>> 13, 1274126177);
    return ((n ^ n >>> 16) >>> 0) / 4294967295;
  }

  function noise(x, y) {
    const ix = Math.floor(x); const iy = Math.floor(y);
    const fx = x - ix; const fy = y - iy;
    const u = fx * fx * (3 - 2 * fx); const v = fy * fy * (3 - 2 * fy);
    const a = hash(ix, iy); const b = hash(ix + 1, iy); const c = hash(ix, iy + 1); const d = hash(ix + 1, iy + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }

  function fbm(x, y) {
    return noise(x, y) * 0.53 + noise(x * 2.03 + 17, y * 2.03 - 11) * 0.27 +
      noise(x * 4.09 - 9, y * 4.09 + 7) * 0.13 + noise(x * 8.21 + 3, y * 8.21) * 0.07;
  }

  // Angle of a point on an arm at a radius of the disc: the arms wind most of a turn.
  function armAngle(spiral, arm, radius) {
    return spiral.phase + arm * TAU / spiral.arms + 2.65 * Math.log(1 + radius * 0.55);
  }

  // Spiral arms, cloudy texture, a warm core, pink star-forming knots and dust lanes just inside
  // the arms, written to `out` as [r, g, b, dust] for a point of the disc. `offset` shifts the
  // noise per galaxy and `tint` leans the arms toward the galaxy's colour.
  function emissionAt(spiral, offset, tint, x, z, out = [0, 0, 0, 0]) {
    const radius = Math.hypot(x, z);
    const envelope = Math.exp(-radius / 12) * (1 - smooth(16, 24, radius));
    if (envelope < 1e-4) { out[0] = out[1] = out[2] = out[3] = 0; return out; }
    const clouds = fbm(x * 0.7 + 32 + offset, z * 0.7 + 19 - offset);
    const filaments = fbm(x * 2.9 - 5 - offset, z * 2.9 + 53 + offset);
    const texture = 0.28 + clouds * clouds * 2.3 + filaments * 0.25;
    const winding = Math.atan2(z, x) - armAngle(spiral, 0, radius);
    const phase = spiral.arms * winding + (clouds - 0.5) * 1.7;
    const arms = Math.pow(0.5 + 0.5 * Math.cos(phase), 9);
    const branches = Math.pow(0.5 + 0.5 * Math.cos(phase * 2 + 1.2), 18) * 0.25;
    const disk = (0.08 + arms * 0.95 + branches) * envelope * texture;
    const warmth = Math.exp(-radius / 5.2);
    const knots = Math.pow(clamp((filaments - 0.49) * 3.5), 3) * arms * envelope * 0.8;
    const r = disk * (0.58 + warmth * 0.42) + knots * 0.8;
    const g = disk * (0.69 + warmth * 0.12) + knots * 0.26;
    const b = disk * (0.88 - warmth * 0.35) + knots * 0.46;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const mix = TINT * (1 - warmth);
    out[0] = r + (luma * tint[0] - r) * mix;
    out[1] = g + (luma * tint[1] - g) * mix;
    out[2] = b + (luma * tint[2] - b) * mix;
    out[3] = (Math.pow(0.5 + 0.5 * Math.cos(phase + 0.46), 20) *
      (clouds * 0.7 + filaments * 0.8) + 0.065) * envelope * smooth(0.7, 3, radius) * 1.65;
    return out;
  }

  // The atlas: `size`² RGBA bytes over [-EXTENT, EXTENT]², emission in rgb and dust in alpha.
  // It depends on the spiral's arms and phase, not the galaxy's radius.
  function buildAtlas(spiral, seed, tint, size) {
    const pixels = new Uint8Array(size * size * 4);
    const offset = (seed % 1000) * 7.3;
    const field = [0, 0, 0, 0];
    for (let row = 0; row < size; row++) {
      const z = (row / (size - 1) * 2 - 1) * EXTENT;
      for (let col = 0; col < size; col++) {
        emissionAt(spiral, offset, tint, (col / (size - 1) * 2 - 1) * EXTENT, z, field);
        const at = (row * size + col) * 4;
        for (let channel = 0; channel < 4; channel++) pixels[at + channel] = clamp(field[channel]) * 255;
      }
    }
    return pixels;
  }

  // Stars drawn from the atlas: most on the disc, each texel as likely as it is bright (so they
  // crowd the arms and the knots), the rest in a three-dimensional bulge. Young blue stars on the
  // disc, warm elsewhere; sizes mostly small with a bright few, in local units.
  function sampleStars(atlas, size, seed, count) {
    const rng = mulberry32(seed);
    const gaussian = () => Math.sqrt(-2 * Math.log(Math.max(rng(), 0.00001))) * Math.cos(TAU * rng());
    // Cumulative brightness over the disc's texels, with a faint floor so field stars remain.
    const cumulative = new Float64Array(size * size);
    let total = 0;
    for (let i = 0; i < cumulative.length; i++) {
      const x = ((i % size) / (size - 1) * 2 - 1) * EXTENT;
      const z = (Math.floor(i / size) / (size - 1) * 2 - 1) * EXTENT;
      if (Math.hypot(x, z) <= DISC) total += atlas[i * 4] + atlas[i * 4 + 1] + atlas[i * 4 + 2] + 1;
      cumulative[i] = total;
    }
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 4);
    const sizes = new Float32Array(count);
    const diskCount = Math.floor(count * DISK_SHARE);
    for (let i = 0; i < count; i++) {
      let x; let y; let z;
      if (i < diskCount) {
        const target = rng() * total;
        let lo = 0; let hi = cumulative.length - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (cumulative[mid] < target) lo = mid + 1; else hi = mid; }
        x = ((lo % size + rng() - 0.5) / (size - 1) * 2 - 1) * EXTENT;
        z = ((Math.floor(lo / size) + rng() - 0.5) / (size - 1) * 2 - 1) * EXTENT;
        y = gaussian() * (DISK_HEIGHT[0] + Math.hypot(x, z) * DISK_HEIGHT[1]) * 0.72;
      } else {
        let r;
        do r = -Math.log(Math.max(rng() * rng(), 0.000001)) * CORE_RADIUS; while (r > 7);
        const theta = rng() * TAU; const elevation = rng() * 2 - 1;
        const ring = Math.sqrt(1 - elevation * elevation) * r;
        x = Math.cos(theta) * ring;
        z = Math.sin(theta) * ring;
        y = elevation * r * CORE_FLATTEN;
      }
      positions[i * 3] = x; positions[i * 3 + 1] = y; positions[i * 3 + 2] = z;
      const warmth = Math.exp(-Math.hypot(x, z) / 5);
      const bright = rng();
      const young = i < diskCount && rng() < YOUNG_SHARE;
      const alpha = 1 - smooth(14, 24, Math.hypot(x, y, z));
      const at = i * 4;
      if (young) { colors[at] = 0.66; colors[at + 1] = 0.79; colors[at + 2] = 1; colors[at + 3] = (0.23 + bright * 0.48) * alpha; }
      else { colors[at] = 1; colors[at + 1] = 0.89 - warmth * 0.13; colors[at + 2] = 0.78 - warmth * 0.28; colors[at + 3] = (0.18 + bright * 0.43) * alpha; }
      sizes[i] = 0.034 + Math.pow(bright, 7) * 0.14;
    }
    return { positions, colors, sizes };
  }

  return { DISC, EXTENT, SLAB, BOX, DISK_HEIGHT, armAngle, emissionAt, buildAtlas, sampleStars };
});

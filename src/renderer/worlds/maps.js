// @ts-check
// World maps, part 3 of 3: AUR.worlds.generate(job) samples a class over the sphere into
// equirectangular RGBA buffers. job = { cls, seed, hue, palette, width, height, rings } (palette
// and hue from AUR.worldProfile). Returns { width, height, surface, emission, clouds, rings }:
// surface = hue-shifted albedo with height in alpha; emission = night or lava light with the
// water/specular mask in alpha; clouds = density for oceanic, else null; rings = a 1024×1 strip
// when job.rings, else null. Pure, like noise.js; runs in worlds/worker.js and on the main thread.
'use strict';

(function (root) {
  const worlds = root.AUR.worlds;
  const { smooth, blend, byte, hex, lcg } = worlds.math;
  const RING_TEXELS = 1024;

  // Banded ring opacity from the inner edge (0) to the outer (1), with one Cassini-style gap.
  function ringStrip(seed, palette) {
    const P = palette.map(hex), random = lcg((seed ^ 0x2545f491) >>> 0);
    const f1 = 300 + random() * 180, f2 = 800 + random() * 250, f3 = 140 + random() * 60, gapAt = 0.42 + random() * 0.16;
    const rings = new Uint8Array(RING_TEXELS * 4);
    for (let i = 0; i < RING_TEXELS; i++) {
      const r = i / (RING_TEXELS - 1);
      const bands = 0.5 + 0.25 * Math.sin(r * f1) + 0.15 * Math.sin(r * f2) + 0.1 * Math.sin(r * f3);
      const gap = 1 - smooth(0.014, 0.022, Math.abs(r - gapAt));
      const edge = smooth(0.01, 0.07, r) * (1 - smooth(0.89, 0.99, r));
      const tint = blend(blend(P[0], P[1], 0.55), P[2], 0.5 + 0.5 * Math.sin(r * 13));
      for (let c = 0; c < 3; c++) rings[i * 4 + c] = byte(tint[c] * (0.68 + bands * 0.32));
      rings[i * 4 + 3] = byte(edge * (1 - gap) * (0.28 + bands * 0.65));
    }
    return rings;
  }

  function generate(job) {
    const { cls, seed, hue, palette, width, height } = job;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || width > 2048 || height > 1024) {
      throw new RangeError('World maps need 2 × 2 to 2048 × 1024 pixels.');
    }
    const sample = worlds.createSampler(cls, seed >>> 0, palette);
    const out = new Float64Array(9);
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
        sample(radius * cosLon[col], y, radius * sinLon[col], out);
        const o = (row * width + col) * 4;
        surface[o] = byte(out[0] * hr); surface[o + 1] = byte(out[1] * hg); surface[o + 2] = byte(out[2] * hb); surface[o + 3] = byte(out[3]);
        emission[o] = byte(out[4]); emission[o + 1] = byte(out[5]); emission[o + 2] = byte(out[6]); emission[o + 3] = byte(out[7]);
        if (clouds) { const d = byte(out[8]); clouds[o] = clouds[o + 1] = clouds[o + 2] = d; clouds[o + 3] = 255; }
      }
    }
    const rings = job.rings ? ringStrip(seed, palette) : null;
    return { width, height, surface, emission, clouds, rings };
  }

  worlds.RING_TEXELS = RING_TEXELS;
  worlds.generate = generate;
})(self);

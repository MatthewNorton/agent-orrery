// @ts-check
// World maps, part 2 of 3: the five world classes. createSampler(cls, seed, palette) returns
// sample(x, y, z, out), which shades one point of the unit sphere into `out`: albedo RGB (0–2),
// height (3), emission RGB (4–6), specular/water mask (7) and cloud density (8). Rocky, gas,
// volcanic and oceanic are the approved preview's maths unchanged (kit 15 checks parity); ice
// swaps the preview's noise iso-line cracks for Europa-style lineae. Pure, like noise.js.
'use strict';

(function (root) {
  const worlds = root.AUR.worlds;
  const { clamp, smooth, blend, scale, lift, ramp, hex, lcg, unitVector } = worlds.math;

  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const normalize = (a) => { const n = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };

  function write(out, color, height, er, eg, eb, specular, cloud) {
    out[0] = color[0]; out[1] = color[1]; out[2] = color[2]; out[3] = height;
    out[4] = er; out[5] = eg; out[6] = eb; out[7] = specular; out[8] = cloud;
  }

  // Rotation about a storm's axis curls nearby belts without a UV seam.
  function vortex(x, y, z, axis, tightness, turn) {
    const dot = x * axis[0] + y * axis[1] + z * axis[2];
    const angle = turn * Math.exp(-Math.max(0, 2 - 2 * dot) * tightness);
    const c = Math.cos(angle), s = Math.sin(angle), t = dot * (1 - c);
    return [x * c + (axis[1] * z - axis[2] * y) * s + axis[0] * t,
      y * c + (axis[2] * x - axis[0] * z) * s + axis[1] * t,
      z * c + (axis[0] * y - axis[1] * x) * s + axis[2] * t];
  }

  // 165 craters filed into 64 latitude bands, so a point only tests the craters that can reach it.
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

  // Each factory takes the planet's noise, palette and seeded random numbers once and returns
  // shade(x, y, z, wx, wy, wz, broad, detail, out); (wx, wy, wz) is the domain-warped point.
  const CLASSES = {
    rocky({ fbm, P, seed }) { // sidereal "morrow": banded crater field
      const craters = craterBands(seed);
      return (x, y, z, wx, wy, wz, broad, detail, out) => {
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
        const color = blend(ramp(P, tone), scale(P[2], 1.08), ejecta * 0.45);
        write(out, color, 0.52 + broad * 0.12 + detail * 0.018 + relief - maria * 0.03, 0, 0, 0, 0, 0);
      };
    },

    gas({ fbm, P, random }) { // sidereal "zephra": vortex-curled belts
      const storms = [unitVector(random, -0.5, -0.15), unitVector(random, 0.12, 0.45)];
      const bandFreq = 19 + random() * 8;
      const belts = blend(P[0], P[1], 0.45);
      const polarHaze = blend(P[0], P[1], 0.3);
      return (x, y, z, wx, wy, wz, broad, detail, out) => {
        const first = vortex(x, y, z, storms[0], 18, 4.8);
        const s = vortex(first[0], first[1], first[2], storms[1], 25, -3.2);
        const turbulence = fbm(s[0] * 12 + broad, s[1] * 17, s[2] * 12, 6);
        const belt = s[1] * 68 + turbulence * 3.4;
        const band = 0.5 + 0.5 * Math.sin(s[1] * bandFreq + turbulence * 1.7);
        let color = blend(P[1], P[2], smooth(0.06, 0.94, band));
        const dark = smooth(0.66, 0.98, 0.5 + 0.5 * Math.sin(s[1] * 15 + broad * 1.4));
        color = blend(color, belts, dark * 0.7);
        const stream = 0.5 + 0.5 * Math.sin(belt + turbulence * 2);
        const filaments = 0.5 + 0.5 * Math.sin(belt * 3.7 + turbulence * 6);
        color = lift(scale(color, 0.78 + stream * 0.17 + filaments * 0.07), detail * 0.035);
        color = blend(color, polarHaze, smooth(0.74, 0.98, Math.abs(y)) * 0.55);
        write(out, color, 0.5, 0, 0, 0, 0, 0);
      };
    },

    ice: iceLineae, // sidereal "nivalis" plates, dust and frost, with Europa-style lineae

    volcanic({ fbm, P }) { // sidereal "pyra": basalt plates and molten fissures
      return (x, y, z, wx, wy, wz, broad, detail, out) => {
        const plates = Math.abs(fbm(wx * 7.5, wy * 7.5, wz * 7.5, 6));
        const active = smooth(-0.08, 0.24, broad);
        const fissure = (1 - smooth(0.009, 0.055, plates)) * active;
        const pools = smooth(0.20, 0.34, fbm(wx * 5 + 13, wy * 5, wz * 5)) * active;
        const heat = Math.max(fissure, pools);
        let color = blend(scale(P[0], 2.3), P[1], clamp(0.3 + detail * 0.9 + broad * 0.7) * 0.75);
        color = blend(color, [0.46, 0.13, 0.025], smooth(0.015, 0.32, heat));
        write(out, color, 0.42 + detail * 0.32 + broad * 0.24 - heat * 0.19,
          heat * 0.62, heat * heat * 0.2, heat ** 4 * 0.02, 0, 0);
      };
    },

    oceanic({ noise, fbm, P }) { // sidereal "nerai": archipelagos, weather, glint, night lights
      return (x, y, z, wx, wy, wz, broad, detail, out) => {
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
        let color = blend(blend(water, ground, land), [0.8, 0.86, 0.9], seaIce);
        color = lift(color, detail * 0.045 * land);
        const coast = Math.exp(-Math.abs(terrain - 0.03) * 30) * land;
        const settled = smooth(0, 0.25, fbm(x * 9 + 4, y * 9, z * 9, 4)) * (1 - mountains) * (1 - ice) * land;
        const speck = smooth(0.15, 0.45, noise(x * 160, y * 160, z * 160));
        const lights = clamp((coast * 0.7 + 0.3) * settled * speck * 1.6) * 0.55;
        const weather = fbm(wx * 6 + y * 3, wy * 7 - 12, wz * 6, 6);
        const cells = 0.75 + 0.25 * Math.cos(lat * 9.5);
        write(out, color, 0.25 + land * (0.12 + Math.max(terrain, 0) * 0.8 + detail * 0.16),
          lights, lights * 0.72, lights * 0.42, (1 - land) * (1 - seaIce),
          smooth(0.015, 0.38, weather * cells + (cells - 0.75) * 0.1) * 0.88);
      };
    },
  };

  // Ice: 5–8 seeded small circles (an axis and an angular radius of 43–86°, so each crosses much
  // of the globe), warped by low-frequency noise. Strength is 1 − smoothstep(w0, w1, |angle(p, axis)
  // − radius + 0.04·warp|), maxed over the circles; a noise fade along each circle leaves long arcs
  // rather than closed loops. Each linea is a dark core in reddish-brown stained margins, with a
  // ridged double band (1 − |fbm|, sharpened) flanking it.
  function iceLineae({ noise, fbm, P, seed }) {
    const random = lcg((seed ^ 0x6c8e9cf5) >>> 0);
    const count = 5 + Math.floor(random() * 4);
    const REACH = 0.1; // widest band (rad) any linea paints, warp included
    const lineae = [];
    for (let i = 0; i < count; i++) {
      const axis = unitVector(random, -1, 1);
      const radius = 0.75 + random() * 0.75;
      // Two axes across the circle's plane, for the angle along it.
      const helper = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      const u = normalize(cross(axis, helper)), v = cross(axis, u);
      lineae.push({ axis, radius, u, v, width: 0.004 + random() * 0.008, phase: random() * 97,
        lo: Math.cos(Math.min(Math.PI, radius + REACH)), hi: Math.cos(Math.max(0, radius - REACH)) });
    }
    return (x, y, z, wx, wy, wz, broad, detail, out) => {
      const bend = noise(x * 1.9 + 21.3, y * 1.9 - 4.7, z * 1.9 + 9.1);
      let line = 0, core = 0, margin = 0, ridge = 0, near = 0;
      for (const l of lineae) {
        const dot = x * l.axis[0] + y * l.axis[1] + z * l.axis[2];
        if (dot < l.lo || dot > l.hi) continue;
        const d = Math.abs(Math.acos(dot) - l.radius + 0.04 * bend);
        if (d >= REACH) continue;
        const along = Math.atan2(x * l.v[0] + y * l.v[1] + z * l.v[2], x * l.u[0] + y * l.u[1] + z * l.u[2]);
        const keep = smooth(-0.12, 0.22, noise(Math.cos(along) * 1.3 + l.phase, Math.sin(along) * 1.3, l.phase * 0.31));
        if (keep <= 0) continue;
        const w = l.width;
        line = Math.max(line, (1 - smooth(w * 0.5, w * 1.5, d)) * keep);
        core = Math.max(core, (1 - smooth(0, w * 0.6, d)) * keep);
        margin = Math.max(margin, (1 - smooth(w * 1.5, w * 6.5, d)) * keep);
        ridge = Math.max(ridge, Math.exp(-(((d - w * 2) / (w * 0.75)) ** 2)) * keep);
        near = Math.max(near, (1 - smooth(w * 4, REACH, d)) * keep);
      }
      if (ridge > 0.002) ridge *= (1 - Math.abs(fbm(x * 31 + 3, y * 31, z * 31, 3))) ** 3;
      const oldIce = smooth(-0.12, 0.22, broad);
      let color = blend(scale(P[2], 0.87), P[1], oldIce * 0.64);
      const dust = smooth(0.12, 0.28, fbm(x * 12, y * 12, z * 12, 4));
      color = blend(color, [0.48, 0.39, 0.28], dust * (0.45 + 0.55 * near) * 0.42);
      color = blend(color, [0.56, 0.43, 0.34], margin * 0.5); // stained lineae margins
      color = blend(color, [0.4, 0.25, 0.18], line * 0.66);
      color = blend(color, [0.22, 0.13, 0.1], core * 0.5); // the darker core
      color = lift(color, ridge * 0.2 + detail * 0.11);
      color = blend(color, [0.88, 0.93, 0.95], smooth(0.72, 0.93, Math.abs(y) + broad * 0.1) * 0.6);
      write(out, color, 0.62 + detail * 0.24 - line * 0.2 + ridge * 0.09 - margin * 0.04 + broad * 0.13,
        0, 0, 0, 0.12 * (1 - line), 0);
    };
  }

  function createSampler(cls, seed, palette) {
    const factory = Object.prototype.hasOwnProperty.call(CLASSES, cls) ? CLASSES[cls] : null;
    if (!factory) throw new RangeError('Unknown world class: ' + String(cls));
    const { noise, fbm } = worlds.noiseField(seed);
    const P = palette.map(hex);
    const shade = factory({ noise, fbm, P, seed, random: lcg((seed ^ 0x9e3779b9) >>> 0) });
    const warp = cls === 'volcanic' || cls === 'oceanic'; // the classes that read (wx, wy, wz)
    return function sample(x, y, z, out) {
      const broad = fbm(x * 2.8 + 4.1, y * 2.8 + 8.7, z * 2.8 - 2.4);
      const detail = fbm(x * 42 + 1.2, y * 42, z * 42, 4);
      let wx = x, wy = y, wz = z;
      if (warp) {
        wx = x + 0.24 * noise(x * 3 + 8, y * 3, z * 3);
        wy = y + 0.24 * noise(x * 3, y * 3 + 6, z * 3);
        wz = z + 0.24 * noise(x * 3, y * 3, z * 3 + 3);
      }
      shade(x, y, z, wx, wy, wz, broad, detail, out);
    };
  }

  worlds.CLASS_KEYS = Object.freeze(Object.keys(CLASSES));
  worlds.createSampler = createSampler;
})(self);

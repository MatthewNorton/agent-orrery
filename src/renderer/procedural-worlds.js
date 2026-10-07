// @ts-check
// procedural-worlds.js — deterministic runtime planet surfaces and asteroid forms.
'use strict';

(function () {
  const AUR = window.AUR;

  const WORLD_TYPES = Object.freeze([
    Object.freeze({
      key: 'rocky', colors: ['#171a20', '#55504a', '#a89072'],
      roughness: 0.92, bumpLevel: 0.68, atmosphere: 'thin',
    }),
    Object.freeze({
      key: 'gas', colors: ['#30253f', '#b66d51', '#e8c99f'],
      roughness: 0.56, bumpLevel: 0.16, atmosphere: 'deep',
    }),
    Object.freeze({
      key: 'ice', colors: ['#15283a', '#6595ac', '#d9eef1'],
      roughness: 0.72, bumpLevel: 0.42, atmosphere: 'cold',
    }),
    Object.freeze({
      key: 'volcanic', colors: ['#100e0d', '#4b2920', '#f06b32'],
      roughness: 0.88, bumpLevel: 0.76, atmosphere: 'haze',
    }),
    Object.freeze({
      key: 'oceanic', colors: ['#071b35', '#17617a', '#b7cab8'],
      roughness: 0.46, bumpLevel: 0.3, atmosphere: 'deep',
    }),
  ]);
  const WORLD_CACHE = new Map();
  const WORLD_CACHE_LIMIT = 48;
  const TEXTURE_WORLD_TYPES = Object.freeze([
    'rocky', 'rocky', 'ice', 'ice', 'volcanic', 'volcanic',
    'oceanic', 'oceanic', 'gas', 'gas', 'rocky', 'rocky',
    'rocky', 'rocky', 'oceanic', 'oceanic', 'volcanic', 'volcanic',
    'ice', 'ice', 'volcanic', 'volcanic', 'rocky', 'rocky',
    'oceanic', 'oceanic', 'ice', 'ice', 'oceanic', 'oceanic', 'rocky',
  ]);

  function hexRgb(hex) {
    const value = parseInt(hex.slice(1), 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  }

  function mixColor(a, b, amount) {
    const t = AUR.clamp(amount, 0, 1);
    return [
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t),
    ];
  }

  function fade(t) { return t * t * (3 - 2 * t); }

  function lattice(seed, x, y) {
    let h = seed ^ Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    return ((h ^ (h >>> 13)) >>> 0) / 4294967295;
  }

  function periodicNoise(u, v, seed, cellsX, cellsY) {
    const px = u * cellsX;
    const py = v * cellsY;
    const x0 = Math.floor(px);
    const y0 = Math.floor(py);
    const x1 = (x0 + 1) % cellsX;
    const y1 = Math.min(cellsY, y0 + 1);
    const ax = ((x0 % cellsX) + cellsX) % cellsX;
    const ay = Math.max(0, Math.min(cellsY, y0));
    const tx = fade(px - x0);
    const ty = fade(py - y0);
    const top = lattice(seed, ax, ay) * (1 - tx) + lattice(seed, x1, ay) * tx;
    const bottom = lattice(seed, ax, y1) * (1 - tx) + lattice(seed, x1, y1) * tx;
    return top * (1 - ty) + bottom * ty;
  }

  function fractalNoise(u, v, seed, octaves) {
    let value = 0;
    let amplitude = 0.55;
    let total = 0;
    for (let octave = 0; octave < octaves; octave += 1) {
      const cells = 4 << octave;
      value += periodicNoise(u, v, seed + octave * 977, cells, Math.max(2, cells >> 1)) * amplitude;
      total += amplitude;
      amplitude *= 0.5;
    }
    return value / total;
  }

  AUR.worldProfile = function worldProfile(projectId, planetName) {
    const seed = AUR.fnv1a(projectId + ':world:' + planetName);
    const textureIndex = AUR.planetTextureIndex(projectId, planetName);
    const key = TEXTURE_WORLD_TYPES[textureIndex - 1];
    const base = WORLD_TYPES.find((candidate) => candidate.key === key) || WORLD_TYPES[0];
    const hueShift = ((seed >>> 8) % 25 - 12) / 100;
    return Object.freeze({
      key: base.key,
      colors: base.colors,
      roughness: base.roughness,
      bumpLevel: base.bumpLevel,
      atmosphere: base.atmosphere,
      hueShift,
      seed,
    });
  };

  function craterField(u, v, craters) {
    let depth = 0;
    for (const crater of craters) {
      const rawDx = Math.abs(u - crater.u);
      const dx = Math.min(rawDx, 1 - rawDx) * Math.cos((v - 0.5) * 1.15);
      const dy = (v - crater.v) * 0.62;
      const d = Math.sqrt(dx * dx + dy * dy) / crater.radius;
      if (d < 1) {
        const bowl = (1 - d) * (1 - d);
        const rim = Math.max(0, 1 - Math.abs(d - 0.82) / 0.16);
        depth += rim * 0.34 - bowl * 0.62;
      }
    }
    return depth;
  }

  function makeCraters(seed, count) {
    const rand = AUR.mulberry32(seed ^ 0xa511e9b3);
    const craters = [];
    for (let i = 0; i < count; i += 1) {
      craters.push({ u: rand(), v: 0.08 + rand() * 0.84, radius: 0.018 + rand() * 0.055 });
    }
    return craters;
  }

  function normalPixels(heights, width, height, strength) {
    const pixels = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      const up = Math.max(0, y - 1);
      const down = Math.min(height - 1, y + 1);
      for (let x = 0; x < width; x += 1) {
        const left = (x + width - 1) % width;
        const right = (x + 1) % width;
        const dx = ((heights[y * width + right] - heights[y * width + left]) / 255) * strength;
        const dy = ((heights[down * width + x] - heights[up * width + x]) / 255) * strength;
        const length = Math.hypot(dx, dy, 1);
        const offset = (y * width + x) * 4;
        pixels[offset] = Math.round((-dx / length * 0.5 + 0.5) * 255);
        pixels[offset + 1] = Math.round((-dy / length * 0.5 + 0.5) * 255);
        pixels[offset + 2] = Math.round((1 / length * 0.5 + 0.5) * 255);
        pixels[offset + 3] = 255;
      }
    }
    return pixels;
  }

  AUR.proceduralPlanetData = function proceduralPlanetData(projectId, planetName, size) {
    const width = AUR.clamp(Math.round(size || 256), 64, 512);
    const height = width;
    const cacheKey = projectId + ':' + planetName + ':' + width;
    if (WORLD_CACHE.has(cacheKey)) return WORLD_CACHE.get(cacheKey);
    const profile = AUR.worldProfile(projectId, planetName);
    const colors = profile.colors.map(hexRgb);
    const pixels = new Uint8Array(width * height * 4);
    const heights = new Uint8Array(width * height);
    const craters = makeCraters(profile.seed, profile.key === 'rocky' ? 18 : 8);

    for (let y = 0; y < height; y += 1) {
      const v = y / height;
      for (let x = 0; x < width; x += 1) {
        const u = x / width;
        const broad = fractalNoise(u, v, profile.seed, 4);
        const detail = fractalNoise(u, v, profile.seed ^ 0x9e3779b9, 5);
        let elevation = broad * 0.72 + detail * 0.28;
        let color;

        if (profile.key === 'gas') {
          const latitude = (v - 0.5) * Math.PI;
          const warp = (broad - 0.5) * 0.22;
          const bands = 0.5 + 0.5 * Math.sin(latitude * 18 + warp * 12);
          const storm = Math.max(0, 1 - Math.hypot((u - 0.72) * 4.6, (v - 0.57) * 10));
          elevation = 0.42 + bands * 0.22 + detail * 0.16 + storm * 0.2;
          color = mixColor(mixColor(colors[0], colors[1], bands), colors[2], detail * 0.46 + storm * 0.58);
        } else if (profile.key === 'ice') {
          const fissures = Math.pow(Math.abs(detail - 0.5) * 2, 4);
          elevation = broad * 0.62 + fissures * 0.38;
          color = mixColor(colors[0], mixColor(colors[1], colors[2], broad), 0.55 + fissures * 0.35);
        } else if (profile.key === 'volcanic') {
          const cracks = Math.pow(Math.max(0, 0.18 - Math.abs(detail - 0.5)), 2) * 22;
          elevation = broad * 0.76 + detail * 0.2 - cracks * 0.18;
          color = mixColor(mixColor(colors[0], colors[1], broad), colors[2], cracks);
        } else if (profile.key === 'oceanic') {
          const land = AUR.clamp((broad - 0.58) * 5, 0, 1);
          const cloud = AUR.clamp((detail - 0.68) * 3.2, 0, 0.42);
          elevation = 0.28 + land * 0.5 + detail * 0.08;
          color = mixColor(mixColor(colors[0], colors[1], detail), colors[2], land + cloud);
        } else {
          elevation += craterField(u, v, craters);
          color = elevation < 0.47
            ? mixColor(colors[0], colors[1], elevation * 1.8)
            : mixColor(colors[1], colors[2], (elevation - 0.47) * 1.65);
        }

        elevation = AUR.clamp(elevation, 0, 1);
        const offset = (y * width + x) * 4;
        pixels[offset] = AUR.clamp(color[0] * (1 + profile.hueShift), 0, 255);
        pixels[offset + 1] = AUR.clamp(color[1] * (1 - profile.hueShift * 0.35), 0, 255);
        pixels[offset + 2] = AUR.clamp(color[2] * (1 - profile.hueShift), 0, 255);
        pixels[offset + 3] = 255;
        heights[y * width + x] = Math.round(elevation * 255);
      }
    }

    const normals = normalPixels(heights, width, height, 2.2);
    const result = Object.freeze({ profile, width, height, pixels, heights, normals });
    WORLD_CACHE.set(cacheKey, result);
    if (WORLD_CACHE.size > WORLD_CACHE_LIMIT) {
      WORLD_CACHE.delete(WORLD_CACHE.keys().next().value);
    }
    return result;
  };

  AUR.applyPlanetSurface = function applyPlanetSurface(scene, material, projectId, planetName, options) {
    const opts = options || {};
    const textureIndex = AUR.planetTextureIndex(projectId, planetName);
    const profile = AUR.worldProfile(projectId, planetName);
    const authoredBump = textureIndex === 31;
    if (!opts.generate || authoredBump) {
      const diffuse = new BABYLON.Texture(AUR.planetTexPath(projectId, planetName), scene);
      diffuse.uScale = 2; diffuse.vScale = 2;
      diffuse.anisotropicFilteringLevel = 8;
      material.diffuseTexture = diffuse;
      const normalData = authoredBump ? null
        : AUR.proceduralPlanetData(projectId, planetName, opts.detail ? 256 : 128);
      const bump = authoredBump
        ? new BABYLON.Texture('../../assets/planets/planet-031-normal.png', scene)
        : BABYLON.RawTexture.CreateRGBATexture(
          normalData.normals, normalData.width, normalData.height,
          scene, true, false, BABYLON.Texture.TRILINEAR_SAMPLINGMODE);
      bump.uScale = 2; bump.vScale = 2;
      bump.wrapU = BABYLON.Texture.WRAP_ADDRESSMODE;
      bump.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
      bump.level = profile.bumpLevel * (opts.detail ? 0.72 : 0.34);
      bump.anisotropicFilteringLevel = 8;
      bump.gammaSpace = false;
      material.bumpTexture = bump;
      return Object.freeze({ ...profile, authored: true, bumpLevel: bump.level });
    }

    const data = AUR.proceduralPlanetData(projectId, planetName, opts.detail ? 256 : 64);
    const sampling = BABYLON.Texture.TRILINEAR_SAMPLINGMODE;
    const diffuse = BABYLON.RawTexture.CreateRGBATexture(
      data.pixels, data.width, data.height, scene, true, false, sampling);
    diffuse.name = 'generated-world:' + projectId + ':' + planetName;
    diffuse.wrapU = BABYLON.Texture.WRAP_ADDRESSMODE;
    diffuse.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
    diffuse.uScale = 2; diffuse.vScale = 2;
    diffuse.anisotropicFilteringLevel = opts.detail ? 8 : 4;
    material.diffuseTexture = diffuse;
    const bump = BABYLON.RawTexture.CreateRGBATexture(
      data.normals, data.width, data.height, scene, true, false, sampling);
    bump.name = 'generated-relief:' + projectId + ':' + planetName;
    bump.wrapU = BABYLON.Texture.WRAP_ADDRESSMODE;
    bump.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
    bump.uScale = 2; bump.vScale = 2;
    bump.level = data.profile.bumpLevel * (opts.detail ? 0.76 : 0.36);
    bump.gammaSpace = false;
    material.bumpTexture = bump;
    return data.profile;
  };

  AUR.applyAsteroidSurface = function applyAsteroidSurface(scene, material, variant) {
    const index = AUR.clamp(Math.round(variant || 1), 1, 3);
    const id = AUR.pad3(index);
    const diffuse = new BABYLON.Texture(`../../assets/asteroids/asteroid-${id}.png`, scene);
    const bump = new BABYLON.Texture(`../../assets/asteroids/asteroid-${id}-normal.png`, scene);
    diffuse.uScale = 1.35; diffuse.vScale = 1.35;
    bump.uScale = diffuse.uScale; bump.vScale = diffuse.vScale;
    diffuse.wrapU = bump.wrapU = BABYLON.Texture.WRAP_ADDRESSMODE;
    diffuse.wrapV = bump.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
    diffuse.anisotropicFilteringLevel = 8;
    bump.anisotropicFilteringLevel = 8;
    bump.gammaSpace = false;
    bump.level = 0.72;
    material.diffuseTexture = diffuse;
    material.bumpTexture = bump;
    material.specularColor = new BABYLON.Color3(0.035, 0.032, 0.028);
    material.specularPower = 12;
    return material;
  };

  AUR.createAsteroidMesh = function createAsteroidMesh(scene, name, seed, size) {
    const mesh = BABYLON.MeshBuilder.CreateIcoSphere(name, {
      radius: size || 0.16, subdivisions: 4, flat: false, updatable: true,
    }, scene);
    const positions = mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind);
    const indices = mesh.getIndices();
    const rand = AUR.mulberry32(seed);
    const axis = [0.86 + rand() * 0.22, 0.82 + rand() * 0.24, 0.86 + rand() * 0.22];
    const dents = [];
    for (let i = 0; i < 4; i += 1) {
      const z = rand() * 2 - 1;
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(1 - z * z);
      dents.push([r * Math.cos(a), z, r * Math.sin(a), 0.9 + rand() * 0.045]);
    }
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i]; const y = positions[i + 1]; const z = positions[i + 2];
      const length = Math.hypot(x, y, z) || 1;
      const nx = x / length; const ny = y / length; const nz = z / length;
      const u = Math.atan2(nz, nx) / (Math.PI * 2) + 0.5;
      const v = Math.acos(AUR.clamp(ny, -1, 1)) / Math.PI;
      let form = 0.8 + fractalNoise(u, v, seed, 4) * 0.34;
      for (const dent of dents) {
        const alignment = nx * dent[0] + ny * dent[1] + nz * dent[2];
        if (alignment > dent[3]) {
          const depth = (alignment - dent[3]) / (1 - dent[3]);
          form -= Math.sin(depth * Math.PI * 0.5) * 0.09;
        }
      }
      positions[i] = x * form * axis[0];
      positions[i + 1] = y * form * axis[1];
      positions[i + 2] = z * form * axis[2];
    }
    const normals = [];
    BABYLON.VertexData.ComputeNormals(positions, indices, normals);
    mesh.updateVerticesData(BABYLON.VertexBuffer.PositionKind, positions);
    mesh.updateVerticesData(BABYLON.VertexBuffer.NormalKind, normals);
    mesh.refreshBoundingInfo();
    return mesh;
  };
})();

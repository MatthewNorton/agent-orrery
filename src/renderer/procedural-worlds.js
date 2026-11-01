// @ts-check
// Planet world profiles (class, seed, palette: what worlds/ generates a surface from) and the
// deterministic asteroid forms.
'use strict';

(function () {
  const AUR = window.AUR;

  // Each class's palette, dark to light.
  const PALETTES = Object.freeze({
    rocky: Object.freeze(['#171a20', '#55504a', '#a89072']),
    gas: Object.freeze(['#30253f', '#b66d51', '#e8c99f']),
    ice: Object.freeze(['#15283a', '#6595ac', '#d9eef1']),
    volcanic: Object.freeze(['#100e0d', '#4b2920', '#f06b32']),
    oceanic: Object.freeze(['#071b35', '#17617a', '#b7cab8']),
  });
  // A planet's class by AUR.planetTextureIndex, the hash that once picked its PNG.
  const TEXTURE_WORLD_TYPES = Object.freeze([
    'rocky', 'rocky', 'ice', 'ice', 'volcanic', 'volcanic',
    'oceanic', 'oceanic', 'gas', 'gas', 'rocky', 'rocky',
    'rocky', 'rocky', 'oceanic', 'oceanic', 'volcanic', 'volcanic',
    'ice', 'ice', 'volcanic', 'volcanic', 'rocky', 'rocky',
    'oceanic', 'oceanic', 'ice', 'ice', 'oceanic', 'oceanic', 'rocky',
  ]);

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
    const key = TEXTURE_WORLD_TYPES[AUR.planetTextureIndex(projectId, planetName) - 1];
    const hueShift = ((seed >>> 8) % 25 - 12) / 100;
    return Object.freeze({ key, colors: PALETTES[key], hueShift, seed });
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

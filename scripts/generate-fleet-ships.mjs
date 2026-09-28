import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALBEDO_PATH = path.join(ROOT, 'assets', 'ships', 'textures', 'aur-fleet-neutral-albedo.jpg');
const NORMAL_PATH = path.join(ROOT, 'assets', 'ships', 'textures', 'aur-fleet-neutral-normal.jpg');
const MATERIAL_NAMES = [
  'hull_primary', 'armor_secondary', 'structure_light', 'mechanical_gunmetal',
  'accent_energy', 'canopy_glass', 'engine_glow',
];

function createGeometry() {
  return new Map(MATERIAL_NAMES.map((name) => [name, {
    positions: [], normals: [], uvs: [], indices: [],
  }]));
}

function subtract(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize(v) {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

function uvFor(position) {
  return [
    Math.max(0, Math.min(1, (position[0] + 4.5) / 9)),
    Math.max(0, Math.min(1, (position[2] + 3.6) / 7.2)),
  ];
}

function addTriangle(geometry, material, a, bValue, cValue, desiredNormal) {
  const bucket = geometry.get(material);
  let b = bValue;
  let c = cValue;
  let normal = normalize(cross(subtract(b, a), subtract(c, a)));
  if (desiredNormal && dot(normal, desiredNormal) < 0) {
    [b, c] = [c, b];
    normal = normalize(cross(subtract(b, a), subtract(c, a)));
  }
  const base = bucket.positions.length / 3;
  for (const point of [a, b, c]) {
    bucket.positions.push(...point);
    bucket.normals.push(...normal);
    bucket.uvs.push(...uvFor(point));
  }
  bucket.indices.push(base, base + 1, base + 2);
}

function addQuad(geometry, material, a, b, c, d, desiredNormal) {
  addTriangle(geometry, material, a, b, c, desiredNormal);
  addTriangle(geometry, material, a, c, d, desiredNormal);
}

function addPolygonFace(geometry, material, points, desiredNormal) {
  for (let index = 1; index < points.length - 1; index += 1) {
    addTriangle(geometry, material, points[0], points[index], points[index + 1], desiredNormal);
  }
}

function addPrism(geometry, material, polygon, yBottom, yTop) {
  const bottom = polygon.map(([x, z]) => [x, yBottom, z]);
  const top = polygon.map(([x, z]) => [x, yTop, z]);
  addPolygonFace(geometry, material, top, [0, 1, 0]);
  addPolygonFace(geometry, material, bottom, [0, -1, 0]);
  for (let index = 0; index < polygon.length; index += 1) {
    const next = (index + 1) % polygon.length;
    const [x0, z0] = polygon[index];
    const [x1, z1] = polygon[next];
    addQuad(geometry, material, bottom[index], bottom[next], top[next], top[index],
      normalize([z1 - z0, 0, -(x1 - x0)]));
  }
}

function addLoft(geometry, material, bottomPolygon, topPolygon, yBottom, yTop) {
  const bottom = bottomPolygon.map(([x, z]) => [x, yBottom, z]);
  const top = topPolygon.map(([x, z]) => [x, yTop, z]);
  addPolygonFace(geometry, material, top, [0, 1, 0]);
  addPolygonFace(geometry, material, bottom, [0, -1, 0]);
  for (let index = 0; index < bottom.length; index += 1) {
    const next = (index + 1) % bottom.length;
    const edge = subtract(bottom[next], bottom[index]);
    addQuad(geometry, material, bottom[index], bottom[next], top[next], top[index],
      normalize([edge[2], 0.2, -edge[0]]));
  }
}

function addEllipsoid(geometry, material, center, radii, segments = 24, rings = 12) {
  const bucket = geometry.get(material);
  const base = bucket.positions.length / 3;
  for (let ring = 0; ring <= rings; ring += 1) {
    const v = ring / rings;
    const latitude = -Math.PI / 2 + v * Math.PI;
    const cosLatitude = Math.cos(latitude);
    const sinLatitude = Math.sin(latitude);
    for (let segment = 0; segment <= segments; segment += 1) {
      const u = segment / segments;
      const longitude = u * Math.PI * 2;
      const cosLongitude = Math.cos(longitude);
      const sinLongitude = Math.sin(longitude);
      const point = [
        center[0] + radii[0] * cosLatitude * cosLongitude,
        center[1] + radii[1] * sinLatitude,
        center[2] + radii[2] * cosLatitude * sinLongitude,
      ];
      const normal = normalize([
        (point[0] - center[0]) / (radii[0] * radii[0]),
        (point[1] - center[1]) / (radii[1] * radii[1]),
        (point[2] - center[2]) / (radii[2] * radii[2]),
      ]);
      bucket.positions.push(...point);
      bucket.normals.push(...normal);
      bucket.uvs.push(u, v);
    }
  }
  for (let ring = 0; ring < rings; ring += 1) {
    for (let segment = 0; segment < segments; segment += 1) {
      const row = segments + 1;
      const a = base + ring * row + segment;
      const b = a + row;
      bucket.indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
}

function addCylinderZ(geometry, material, centerX, centerY, zRear, zFront,
  rearRadiusX, rearRadiusY, frontRadiusX, frontRadiusY, segments = 18) {
  const rear = [];
  const front = [];
  for (let index = 0; index < segments; index += 1) {
    const angle = (index / segments) * Math.PI * 2;
    rear.push([
      centerX + Math.cos(angle) * rearRadiusX,
      centerY + Math.sin(angle) * rearRadiusY,
      zRear,
    ]);
    front.push([
      centerX + Math.cos(angle) * frontRadiusX,
      centerY + Math.sin(angle) * frontRadiusY,
      zFront,
    ]);
  }
  addPolygonFace(geometry, material, rear, [0, 0, -1]);
  addPolygonFace(geometry, material, front, [0, 0, 1]);
  for (let index = 0; index < segments; index += 1) {
    const next = (index + 1) % segments;
    const middleAngle = ((index + 0.5) / segments) * Math.PI * 2;
    addQuad(geometry, material, rear[index], rear[next], front[next], front[index],
      normalize([Math.cos(middleAngle), Math.sin(middleAngle), 0.06]));
  }
}

function mirrorPolygon(polygon) {
  return polygon.map(([x, z]) => [-x, z]).reverse();
}

function addWingPair(geometry, material, rightPolygon, yBottom, yTop) {
  addPrism(geometry, material, rightPolygon, yBottom, yTop);
  addPrism(geometry, material, mirrorPolygon(rightPolygon), yBottom, yTop);
}

function addEngine(geometry, x, y, zRear, zFront, radiusX, radiusY, segments = 20) {
  addCylinderZ(geometry, 'mechanical_gunmetal', x, y, zRear, zFront,
    radiusX, radiusY, radiusX * 0.78, radiusY * 0.78, segments);
  addCylinderZ(geometry, 'engine_glow', x, y, zRear - 0.08, zRear + 0.035,
    radiusX * 0.72, radiusY * 0.72, radiusX * 0.72, radiusY * 0.72, segments);
}

function addPanelRun(geometry, x, zStart, count, spacing, width, length, y = 0.31) {
  for (let index = 0; index < count; index += 1) {
    const z = zStart + index * spacing;
    addPrism(geometry, index % 3 === 0 ? 'structure_light' : 'armor_secondary', [
      [x - width, z - length], [x + width, z - length],
      [x + width * 0.86, z + length], [x - width * 0.86, z + length],
    ], y, y + 0.055);
  }
}

function addEnergyRail(geometry, rightPolygon, yBottom, yTop) {
  addWingPair(geometry, 'accent_energy', rightPolygon, yBottom, yTop);
}

function buildHalcyonDart(geometry) {
  addEllipsoid(geometry, 'hull_primary', [0, 0.02, 0.18], [0.55, 0.34, 2.52], 30, 14);
  addWingPair(geometry, 'hull_primary', [
    [0.34, -1.48], [1.08, -1.72], [2.72, -0.40], [2.52, 0.38],
    [1.38, 0.92], [0.45, 0.78],
  ], -0.12, 0.13);
  addWingPair(geometry, 'armor_secondary', [
    [0.46, -1.12], [1.03, -1.25], [2.26, -0.31], [1.82, 0.27], [0.58, 0.52],
  ], 0.135, 0.235);
  addLoft(geometry, 'canopy_glass', [
    [-0.36, 0.12], [0.36, 0.12], [0.31, 1.10], [0.12, 1.58], [-0.12, 1.58], [-0.31, 1.10],
  ], [
    [-0.22, 0.28], [0.22, 0.28], [0.18, 1.03], [0.07, 1.35], [-0.07, 1.35], [-0.18, 1.03],
  ], 0.26, 0.56);
  for (const x of [-1.22, 1.22]) addEngine(geometry, x, 0.01, -1.82, 0.18, 0.33, 0.25, 22);
  addEnergyRail(geometry, [[0.52, 0.50], [0.61, 0.64], [2.28, 0.18], [2.34, 0.04]], 0.24, 0.30);
  addPanelRun(geometry, 0, -1.27, 5, 0.36, 0.25, 0.12, 0.34);
  for (const x of [-2.18, 2.18]) {
    addPrism(geometry, 'structure_light', [[x - 0.10, -0.35], [x + 0.10, -0.35], [x + 0.07, 0.26], [x - 0.04, 0.42]], 0.13, 0.43);
  }
}

function buildKiteglassRunner(geometry) {
  for (const x of [-0.58, 0.58]) {
    addEllipsoid(geometry, 'hull_primary', [x, -0.01, 0.02], [0.39, 0.28, 2.22], 26, 12);
    addEngine(geometry, x, -0.02, -2.14, -0.82, 0.31, 0.23, 20);
  }
  addEllipsoid(geometry, 'canopy_glass', [0, 0.26, 0.84], [0.48, 0.25, 0.94], 26, 12);
  addWingPair(geometry, 'hull_primary', [
    [0.22, -1.42], [1.04, -1.76], [2.84, -0.72], [2.24, 0.08],
    [1.06, 1.34], [0.50, 1.16],
  ], -0.14, 0.12);
  addWingPair(geometry, 'armor_secondary', [
    [0.54, -1.16], [1.09, -1.38], [2.31, -0.66], [1.82, -0.05], [0.90, 0.66],
  ], 0.125, 0.25);
  addWingPair(geometry, 'structure_light', [
    [0.78, 0.62], [0.96, 0.82], [1.54, 1.33], [1.39, 1.48], [0.70, 1.05],
  ], 0.18, 0.32);
  addEnergyRail(geometry, [[0.71, -0.92], [0.81, -0.83], [2.24, -0.49], [2.30, -0.62]], 0.255, 0.315);
  addPrism(geometry, 'mechanical_gunmetal', [
    [-0.29, -1.12], [0.29, -1.12], [0.40, 0.45], [0.22, 1.30], [-0.22, 1.30], [-0.40, 0.45],
  ], -0.32, -0.12);
  addPanelRun(geometry, -0.58, -0.72, 4, 0.39, 0.19, 0.12, 0.28);
  addPanelRun(geometry, 0.58, -0.72, 4, 0.39, 0.19, 0.12, 0.28);
}

function buildMeridianTalon(geometry) {
  addEllipsoid(geometry, 'hull_primary', [0, -0.01, 0.22], [0.70, 0.38, 2.72], 32, 15);
  addWingPair(geometry, 'hull_primary', [
    [0.40, -1.62], [1.22, -1.92], [3.32, -0.74], [3.15, 0.24],
    [2.12, 1.32], [0.78, 1.58], [0.52, 0.82],
  ], -0.17, 0.16);
  addWingPair(geometry, 'armor_secondary', [
    [0.62, -1.35], [1.31, -1.54], [2.84, -0.65], [2.62, 0.12],
    [1.78, 0.88], [0.80, 1.09],
  ], 0.165, 0.31);
  addLoft(geometry, 'canopy_glass', [
    [-0.45, 0.08], [0.45, 0.08], [0.47, 1.24], [0.18, 1.86], [-0.18, 1.86], [-0.47, 1.24],
  ], [
    [-0.27, 0.30], [0.27, 0.30], [0.28, 1.18], [0.10, 1.61], [-0.10, 1.61], [-0.28, 1.18],
  ], 0.31, 0.67);
  for (const x of [-1.72, -0.78, 0.78, 1.72]) addEngine(geometry, x, -0.02, -1.88, -0.62, 0.27, 0.22, 20);
  addEnergyRail(geometry, [[0.68, 0.68], [0.79, 0.84], [2.64, 0.20], [2.72, 0.02]], 0.315, 0.38);
  for (const x of [-2.78, 2.78]) {
    addPrism(geometry, 'structure_light', [[x - 0.11, -0.55], [x + 0.11, -0.55], [x + 0.07, 0.38], [x - 0.06, 0.62]], 0.16, 0.52);
  }
  addPanelRun(geometry, 0, -1.48, 7, 0.37, 0.32, 0.12, 0.40);
}

function buildCinderRelay(geometry) {
  addPrism(geometry, 'hull_primary', [
    [-0.62, -2.62], [0.62, -2.62], [0.88, -0.92], [0.68, 1.62],
    [0.25, 2.56], [0, 2.92], [-0.25, 2.56], [-0.68, 1.62], [-0.88, -0.92],
  ], -0.28, 0.30);
  for (const x of [-1.20, 1.20]) {
    for (const z of [-0.98, 0.72]) {
      addEllipsoid(geometry, 'armor_secondary', [x, 0.02, z], [0.58, 0.39, 0.90], 24, 12);
      addPrism(geometry, 'structure_light', [[x - 0.49, z - 0.34], [x + 0.49, z - 0.34], [x + 0.44, z + 0.34], [x - 0.44, z + 0.34]], 0.34, 0.43);
    }
    addEngine(geometry, x, -0.01, -2.35, -1.42, 0.40, 0.31, 22);
  }
  addWingPair(geometry, 'hull_primary', [
    [0.56, -1.88], [1.48, -2.10], [2.48, -1.32], [2.31, 0.42], [1.62, 1.38], [0.68, 1.56],
  ], -0.21, 0.13);
  addWingPair(geometry, 'mechanical_gunmetal', [
    [0.76, -1.48], [1.37, -1.65], [2.08, -1.08], [1.95, 0.20], [1.47, 0.78], [0.82, 0.94],
  ], 0.14, 0.24);
  addLoft(geometry, 'canopy_glass', [
    [-0.47, 0.48], [0.47, 0.48], [0.38, 1.74], [0.15, 2.22], [-0.15, 2.22], [-0.38, 1.74],
  ], [
    [-0.28, 0.68], [0.28, 0.68], [0.23, 1.66], [0.08, 1.99], [-0.08, 1.99], [-0.23, 1.66],
  ], 0.31, 0.68);
  addEnergyRail(geometry, [[0.72, 1.18], [0.82, 1.32], [1.85, 0.92], [1.91, 0.76]], 0.25, 0.32);
  addPanelRun(geometry, 0, -1.88, 6, 0.46, 0.34, 0.15, 0.32);
}

function buildCrownWarden(geometry) {
  addEllipsoid(geometry, 'hull_primary', [0, -0.02, 0.08], [0.92, 0.54, 3.28], 36, 18);
  addWingPair(geometry, 'hull_primary', [
    [0.58, -2.55], [1.70, -2.72], [3.66, -1.30], [3.48, 0.48],
    [2.58, 1.92], [1.10, 2.45], [0.72, 1.18],
  ], -0.27, 0.22);
  addWingPair(geometry, 'armor_secondary', [
    [0.82, -2.22], [1.72, -2.32], [3.16, -1.12], [3.02, 0.30],
    [2.27, 1.49], [1.16, 1.85], [0.88, 0.88],
  ], 0.225, 0.43);
  addWingPair(geometry, 'structure_light', [
    [1.22, -1.82], [1.49, -1.90], [2.80, -0.82], [2.68, -0.58], [1.42, -1.40],
  ], 0.435, 0.51);
  addPrism(geometry, 'mechanical_gunmetal', [
    [-0.34, -2.80], [0.34, -2.80], [0.52, -0.40], [0.28, 1.64],
    [0, 2.54], [-0.28, 1.64], [-0.52, -0.40],
  ], -0.58, -0.30);
  addLoft(geometry, 'canopy_glass', [
    [-0.55, 0.14], [0.55, 0.14], [0.48, 1.52], [0.20, 2.26], [-0.20, 2.26], [-0.48, 1.52],
  ], [
    [-0.30, 0.40], [0.30, 0.40], [0.27, 1.45], [0.10, 1.96], [-0.10, 1.96], [-0.27, 1.45],
  ], 0.50, 0.94);
  for (const x of [-2.18, -1.18, 0, 1.18, 2.18]) addEngine(geometry, x, -0.08, -2.72, -1.68, 0.34, 0.28, 22);
  addEnergyRail(geometry, [[0.92, 1.18], [1.08, 1.36], [2.67, 0.63], [2.73, 0.42]], 0.44, 0.52);
  addPanelRun(geometry, 0, -2.14, 10, 0.40, 0.40, 0.14, 0.58);
  for (const x of [-3.15, 3.15]) {
    addPrism(geometry, 'structure_light', [[x - 0.13, -0.92], [x + 0.13, -0.92], [x + 0.08, 0.70], [x - 0.08, 1.10]], 0.23, 0.72);
  }
}

const SHIPS = [
  { id: 'aur-halcyon-dart', name: 'Halcyon Dart', role: 'main-s', scale: 0.66, build: buildHalcyonDart,
    features: ['spear pressure hull', 'swept delta wings', 'twin vector nacelles'] },
  { id: 'aur-kiteglass-runner', name: 'Kiteglass Runner', role: 'main-s', scale: 0.64, build: buildKiteglassRunner,
    features: ['twin-boom hull', 'forked kite wings', 'raised bridge blister'] },
  { id: 'aur-meridian-talon', name: 'Meridian Talon', role: 'main-m', scale: 0.59, build: buildMeridianTalon,
    features: ['broad manta planform', 'four vector drives', 'armored dorsal plates'] },
  { id: 'aur-cinder-relay', name: 'Cinder Relay', role: 'main-m', scale: 0.58, build: buildCinderRelay,
    features: ['modular side pods', 'reinforced central spine', 'heavy relay engines'] },
  { id: 'aur-crown-warden', name: 'Crown Warden', role: 'main-l', scale: 0.52, build: buildCrownWarden,
    features: ['capital spear hull', 'layered shoulder armor', 'five-engine stern'] },
];

class BinaryBuilder {
  constructor() {
    this.parts = [];
    this.byteLength = 0;
    this.bufferViews = [];
  }

  align() {
    const padding = (4 - (this.byteLength % 4)) % 4;
    if (padding) {
      this.parts.push(Buffer.alloc(padding));
      this.byteLength += padding;
    }
  }

  add(buffer, target = null) {
    this.align();
    const byteOffset = this.byteLength;
    this.parts.push(buffer);
    this.byteLength += buffer.length;
    const view = { buffer: 0, byteOffset, byteLength: buffer.length };
    if (target) view.target = target;
    this.bufferViews.push(view);
    return this.bufferViews.length - 1;
  }

  finish() {
    this.align();
    return Buffer.concat(this.parts, this.byteLength);
  }
}

function floatBuffer(values) {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return buffer;
}

function indexBuffer(values) {
  const buffer = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => buffer.writeUInt16LE(value, index * 2));
  return buffer;
}

function bounds(values, stride) {
  const min = Array(stride).fill(Number.POSITIVE_INFINITY);
  const max = Array(stride).fill(Number.NEGATIVE_INFINITY);
  for (let index = 0; index < values.length; index += stride) {
    for (let axis = 0; axis < stride; axis += 1) {
      min[axis] = Math.min(min[axis], values[index + axis]);
      max[axis] = Math.max(max[axis], values[index + axis]);
    }
  }
  return { min, max };
}

function materialDefinitions() {
  const textured = (factor, metallicFactor, roughnessFactor) => ({
    baseColorFactor: factor,
    baseColorTexture: { index: 0 },
    metallicFactor,
    roughnessFactor,
  });
  return [
    {
      name: 'hull_primary',
      pbrMetallicRoughness: textured([0.78, 0.80, 0.84, 1], 0.78, 0.38),
      normalTexture: { index: 1, scale: 0.72 },
    },
    {
      name: 'armor_secondary',
      pbrMetallicRoughness: textured([0.60, 0.64, 0.70, 1], 0.70, 0.44),
      normalTexture: { index: 1, scale: 0.62 },
    },
    {
      name: 'structure_light',
      pbrMetallicRoughness: { baseColorFactor: [0.64, 0.66, 0.70, 1], metallicFactor: 0.72, roughnessFactor: 0.34 },
    },
    {
      name: 'mechanical_gunmetal',
      pbrMetallicRoughness: { baseColorFactor: [0.045, 0.052, 0.066, 1], metallicFactor: 0.94, roughnessFactor: 0.28 },
    },
    {
      name: 'accent_energy',
      pbrMetallicRoughness: { baseColorFactor: [0.74, 0.80, 0.90, 1], metallicFactor: 0.42, roughnessFactor: 0.18 },
      emissiveFactor: [0.52, 0.62, 0.82],
    },
    {
      name: 'canopy_glass',
      pbrMetallicRoughness: { baseColorFactor: [0.025, 0.035, 0.060, 0.92], metallicFactor: 0.28, roughnessFactor: 0.08 },
      emissiveFactor: [0.008, 0.012, 0.025], alphaMode: 'BLEND', doubleSided: true,
    },
    {
      name: 'engine_glow',
      pbrMetallicRoughness: { baseColorFactor: [0.72, 0.78, 0.88, 1], metallicFactor: 0.10, roughnessFactor: 0.16 },
      emissiveFactor: [0.60, 0.70, 0.92],
    },
  ];
}

function writeShip(ship, albedoBytes, normalBytes) {
  const geometry = createGeometry();
  ship.build(geometry);
  const binary = new BinaryBuilder();
  const accessors = [];
  const meshes = [];
  const nodes = [{ name: ship.name, children: [] }];

  for (let materialIndex = 0; materialIndex < MATERIAL_NAMES.length; materialIndex += 1) {
    const materialName = MATERIAL_NAMES[materialIndex];
    const bucket = geometry.get(materialName);
    if (!bucket.indices.length) continue;
    if (bucket.positions.length / 3 > 65535) throw new Error(`${ship.id}:${materialName} exceeds uint16 capacity`);
    const positionView = binary.add(floatBuffer(bucket.positions), 34962);
    const normalView = binary.add(floatBuffer(bucket.normals), 34962);
    const uvView = binary.add(floatBuffer(bucket.uvs), 34962);
    const indexView = binary.add(indexBuffer(bucket.indices), 34963);
    const positionBounds = bounds(bucket.positions, 3);
    const positionAccessor = accessors.push({
      bufferView: positionView, componentType: 5126, count: bucket.positions.length / 3,
      type: 'VEC3', min: positionBounds.min, max: positionBounds.max,
    }) - 1;
    const normalAccessor = accessors.push({
      bufferView: normalView, componentType: 5126, count: bucket.normals.length / 3, type: 'VEC3',
    }) - 1;
    const uvAccessor = accessors.push({
      bufferView: uvView, componentType: 5126, count: bucket.uvs.length / 2, type: 'VEC2',
    }) - 1;
    const indexAccessor = accessors.push({
      bufferView: indexView, componentType: 5123, count: bucket.indices.length, type: 'SCALAR',
    }) - 1;
    const meshIndex = meshes.push({
      name: materialName,
      primitives: [{
        attributes: { POSITION: positionAccessor, NORMAL: normalAccessor, TEXCOORD_0: uvAccessor },
        indices: indexAccessor, material: materialIndex, mode: 4,
      }],
    }) - 1;
    nodes[0].children.push(nodes.push({ name: materialName, mesh: meshIndex }) - 1);
  }

  const albedoView = binary.add(albedoBytes);
  const normalView = binary.add(normalBytes);
  const binaryChunk = binary.finish();
  const gltf = {
    asset: {
      version: '2.0', generator: 'Agent Universe shared fleet generator',
      copyright: `Original ${ship.name} design released under CC0-1.0`,
    },
    scene: 0,
    scenes: [{ name: `${ship.name} Fleet Hull`, nodes: [0] }],
    nodes,
    meshes,
    materials: materialDefinitions(),
    textures: [
      { name: 'Agent Universe neutral fleet albedo', sampler: 0, source: 0 },
      { name: 'Agent Universe neutral fleet normal', sampler: 0, source: 1 },
    ],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
    images: [
      { name: 'aur-fleet-neutral-albedo', mimeType: 'image/jpeg', bufferView: albedoView },
      { name: 'aur-fleet-neutral-normal', mimeType: 'image/jpeg', bufferView: normalView },
    ],
    accessors,
    bufferViews: binary.bufferViews,
    buffers: [{ byteLength: binaryChunk.length }],
    extras: {
      shipId: ship.id,
      design: `Original shared-fleet ${ship.role} hull`,
      facing: '+Z', up: '+Y', providerPalette: 'runtime', features: ship.features,
    },
  };

  const jsonBytes = Buffer.from(JSON.stringify(gltf), 'utf8');
  const paddedJson = Buffer.concat([jsonBytes, Buffer.alloc((4 - jsonBytes.length % 4) % 4, 0x20)]);
  const paddedBin = Buffer.concat([binaryChunk, Buffer.alloc((4 - binaryChunk.length % 4) % 4)]);
  const totalLength = 12 + 8 + paddedJson.length + 8 + paddedBin.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLength, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(paddedJson.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(paddedBin.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);

  const outputPath = path.join(ROOT, 'assets', 'ships', `${ship.id}.glb`);
  fs.writeFileSync(outputPath, Buffer.concat([header, jsonHeader, paddedJson, binHeader, paddedBin]));
  const triangles = [...geometry.values()].reduce((sum, bucket) => sum + bucket.indices.length / 3, 0);
  const vertices = [...geometry.values()].reduce((sum, bucket) => sum + bucket.positions.length / 3, 0);
  console.log(`Generated ${path.relative(ROOT, outputPath)} (${triangles} triangles, ${vertices} vertices, ${totalLength} bytes)`);
}

const albedoBytes = fs.readFileSync(ALBEDO_PATH);
const normalBytes = fs.readFileSync(NORMAL_PATH);
for (const ship of SHIPS) writeShip(ship, albedoBytes, normalBytes);

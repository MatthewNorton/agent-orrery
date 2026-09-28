import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEXTURE_PATH = path.join(ROOT, 'assets', 'ships', 'textures', 'aur-aster-kite-albedo.jpg');
const OUTPUT_PATH = path.join(ROOT, 'assets', 'ships', 'aur-aster-kite.glb');

const materials = ['hull_textured', 'accent_energy', 'canopy_glass', 'engine_glow'];
const geometry = new Map(materials.map((name) => [name, {
  positions: [], normals: [], uvs: [], indices: [],
}]));

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
    Math.max(0, Math.min(1, (position[0] + 3.05) / 6.1)),
    Math.max(0, Math.min(1, (position[2] + 1.85) / 4.35)),
  ];
}

function addTriangle(material, a, bValue, cValue, desiredNormal) {
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

function addQuad(material, a, b, c, d, desiredNormal) {
  addTriangle(material, a, b, c, desiredNormal);
  addTriangle(material, a, c, d, desiredNormal);
}

function addPolygonFace(material, points, desiredNormal) {
  for (let index = 1; index < points.length - 1; index += 1) {
    addTriangle(material, points[0], points[index], points[index + 1], desiredNormal);
  }
}

function addPrism(material, polygon, yBottom, yTop) {
  const bottom = polygon.map(([x, z]) => [x, yBottom, z]);
  const top = polygon.map(([x, z]) => [x, yTop, z]);
  addPolygonFace(material, top, [0, 1, 0]);
  addPolygonFace(material, bottom, [0, -1, 0]);
  for (let index = 0; index < polygon.length; index += 1) {
    const next = (index + 1) % polygon.length;
    const [x0, z0] = polygon[index];
    const [x1, z1] = polygon[next];
    addQuad(material, bottom[index], bottom[next], top[next], top[index],
      normalize([z1 - z0, 0, -(x1 - x0)]));
  }
}

function addLoft(material, bottomPolygon, topPolygon, yBottom, yTop) {
  if (bottomPolygon.length !== topPolygon.length) throw new Error('Loft rings must match');
  const bottom = bottomPolygon.map(([x, z]) => [x, yBottom, z]);
  const top = topPolygon.map(([x, z]) => [x, yTop, z]);
  addPolygonFace(material, top, [0, 1, 0]);
  addPolygonFace(material, bottom, [0, -1, 0]);
  for (let index = 0; index < bottom.length; index += 1) {
    const next = (index + 1) % bottom.length;
    const edge = subtract(bottom[next], bottom[index]);
    addQuad(material, bottom[index], bottom[next], top[next], top[index],
      normalize([edge[2], 0.25, -edge[0]]));
  }
}

function addTaperedCylinder(material, centerX, centerY, zRear, zFront,
  rearRadiusX, rearRadiusY, frontRadiusX, frontRadiusY, segments = 10) {
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
  addPolygonFace(material, rear, [0, 0, -1]);
  addPolygonFace(material, front, [0, 0, 1]);
  for (let index = 0; index < segments; index += 1) {
    const next = (index + 1) % segments;
    const middleAngle = ((index + 0.5) / segments) * Math.PI * 2;
    addQuad(material, rear[index], rear[next], front[next], front[index],
      normalize([Math.cos(middleAngle), Math.sin(middleAngle), 0.08]));
  }
}

// Central spear hull, centered on +Z flight direction.
addPrism('hull_textured', [
  [-0.48, -1.58], [0.48, -1.58], [0.62, 0.22], [0.42, 1.18],
  [0.16, 1.88], [0, 2.35], [-0.16, 1.88], [-0.42, 1.18], [-0.62, 0.22],
], -0.19, 0.22);

// Mirrored swept wings give the ship its kite silhouette and forked tail.
const rightWing = [
  [0.42, -1.10], [1.02, -1.36], [1.57, -0.92], [2.45, -0.58],
  [2.82, 0.08], [2.28, 0.63], [1.42, 1.16], [0.55, 0.78],
];
const leftWing = rightWing.map(([x, z]) => [-x, z]).reverse();
addPrism('hull_textured', rightWing, -0.12, 0.14);
addPrism('hull_textured', leftWing, -0.12, 0.14);

// A shallow ventral keel keeps the profile readable from oblique camera angles.
addPrism('hull_textured', [
  [-0.22, -1.38], [0.22, -1.38], [0.28, 0.45], [0.12, 1.18],
  [-0.12, 1.18], [-0.28, 0.45],
], -0.38, -0.17);

// Twin engine nacelles are intentionally chunkier than the stock hulls.
for (const x of [-1.22, 1.22]) {
  addTaperedCylinder('hull_textured', x, 0.02, -1.67, 0.34, 0.34, 0.27, 0.24, 0.20, 10);
  addTaperedCylinder('engine_glow', x, 0.02, -1.73, -1.64, 0.25, 0.19, 0.25, 0.19, 12);
}

// Raised faceted canopy.
addLoft('canopy_glass', [
  [-0.34, 0.02], [0.34, 0.02], [0.36, 0.67], [0.17, 1.30],
  [-0.17, 1.30], [-0.36, 0.67],
], [
  [-0.20, 0.24], [0.20, 0.24], [0.21, 0.64], [0.10, 1.03],
  [-0.10, 1.03], [-0.21, 0.64],
], 0.22, 0.53);

// Provider-tinted energy rails and nose chevron.
const rightRail = [[0.78, 0.66], [0.96, 0.91], [2.30, 0.22], [2.20, 0.08]];
const leftRail = rightRail.map(([x, z]) => [-x, z]).reverse();
addPrism('accent_energy', rightRail, 0.145, 0.205);
addPrism('accent_energy', leftRail, 0.145, 0.205);
addPrism('accent_energy', [
  [-0.10, 1.55], [0.10, 1.55], [0.06, 1.90], [0, 2.08], [-0.06, 1.90],
], 0.225, 0.275);

// Compact dorsal stabilizers finish the original silhouette.
for (const x of [-1.82, 1.82]) {
  const polygon = x < 0
    ? [[x - 0.13, -0.58], [x + 0.14, -0.72], [x + 0.09, 0.10], [x - 0.04, 0.25]]
    : [[x - 0.14, -0.72], [x + 0.13, -0.58], [x + 0.04, 0.25], [x - 0.09, 0.10]];
  addPrism('accent_energy', polygon, 0.13, 0.34);
}

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

  add(buffer, target) {
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

const binary = new BinaryBuilder();
const accessors = [];
const meshes = [];
const nodes = [{ name: 'Aster Kite', children: [] }];

for (let materialIndex = 0; materialIndex < materials.length; materialIndex += 1) {
  const materialName = materials[materialIndex];
  const bucket = geometry.get(materialName);
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
  const indicesAccessor = accessors.push({
    bufferView: indexView, componentType: 5123, count: bucket.indices.length, type: 'SCALAR',
  }) - 1;

  const meshIndex = meshes.push({
    name: materialName,
    primitives: [{
      attributes: { POSITION: positionAccessor, NORMAL: normalAccessor, TEXCOORD_0: uvAccessor },
      indices: indicesAccessor,
      material: materialIndex,
      mode: 4,
    }],
  }) - 1;
  const nodeIndex = nodes.push({ name: materialName, mesh: meshIndex }) - 1;
  nodes[0].children.push(nodeIndex);
}

const textureBytes = fs.readFileSync(TEXTURE_PATH);
const textureView = binary.add(textureBytes);
const binaryChunk = binary.finish();

const gltf = {
  asset: {
    version: '2.0',
    generator: 'Agent Universe original ship generator',
    copyright: 'Original Aster Kite design released under CC0-1.0',
  },
  scene: 0,
  scenes: [{ name: 'Aster Kite Preview', nodes: [0] }],
  nodes,
  meshes,
  materials: [
    {
      name: 'hull_textured',
      pbrMetallicRoughness: {
        baseColorTexture: { index: 0 }, metallicFactor: 0.72, roughnessFactor: 0.42,
      },
    },
    {
      name: 'accent_energy',
      pbrMetallicRoughness: {
        baseColorFactor: [0.03, 0.38, 0.78, 1], metallicFactor: 0.55, roughnessFactor: 0.28,
      },
      emissiveFactor: [0.02, 0.32, 0.8],
    },
    {
      name: 'canopy_glass',
      pbrMetallicRoughness: {
        baseColorFactor: [0.035, 0.055, 0.14, 1], metallicFactor: 0.35, roughnessFactor: 0.12,
      },
      emissiveFactor: [0.015, 0.035, 0.10],
    },
    {
      name: 'engine_glow',
      pbrMetallicRoughness: {
        baseColorFactor: [0.0, 0.42, 0.82, 1], metallicFactor: 0.15, roughnessFactor: 0.24,
      },
      emissiveFactor: [0.0, 0.78, 1.0],
    },
  ],
  textures: [{ name: 'Aster Kite hull albedo', sampler: 0, source: 0 }],
  samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
  images: [{ name: 'aur-aster-kite-albedo', mimeType: 'image/jpeg', bufferView: textureView }],
  accessors,
  bufferViews: binary.bufferViews,
  buffers: [{ byteLength: binaryChunk.length }],
  extras: {
    shipId: 'aur-aster-kite',
    design: 'Original split-wing courier/interceptor with twin nacelles',
    facing: '+Z',
    up: '+Y',
  },
};

const jsonBytes = Buffer.from(JSON.stringify(gltf), 'utf8');
const jsonPadding = (4 - (jsonBytes.length % 4)) % 4;
const paddedJson = Buffer.concat([jsonBytes, Buffer.alloc(jsonPadding, 0x20)]);
const binPadding = (4 - (binaryChunk.length % 4)) % 4;
const paddedBin = Buffer.concat([binaryChunk, Buffer.alloc(binPadding)]);
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

fs.writeFileSync(OUTPUT_PATH, Buffer.concat([
  header, jsonHeader, paddedJson, binHeader, paddedBin,
]));

const triangles = [...geometry.values()].reduce((total, bucket) => total + bucket.indices.length / 3, 0);
console.log(`Generated ${path.relative(ROOT, OUTPUT_PATH)} (${triangles} triangles, ${totalLength} bytes)`);

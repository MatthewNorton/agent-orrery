import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIP_ROOT = path.join(ROOT, 'assets', 'ships');
const ALBEDO_PATH = path.join(SHIP_ROOT, 'textures', 'vanta-seraph-albedo.jpg');
const NORMAL_PATH = path.join(SHIP_ROOT, 'textures', 'vanta-seraph-normal.jpg');
const OUTPUT_PATH = path.join(SHIP_ROOT, 'aur-vanta-seraph.glb');

const materialNames = [
  'hull_primary',
  'armor_secondary',
  'structure_ivory',
  'mechanical_gunmetal',
  'accent_energy',
  'canopy_glass',
  'engine_glow',
];
const geometry = new Map(materialNames.map((name) => [name, {
  positions: [], normals: [], uvs: [], indices: [],
}]));

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const normalize = (value) => {
  const length = Math.hypot(...value) || 1;
  return value.map((component) => component / length);
};

function globalUv(position) {
  return [
    Math.max(0, Math.min(1, (position[0] + 3.85) / 7.7)),
    Math.max(0, Math.min(1, (position[2] + 2.75) / 6.15)),
  ];
}

function addTriangle(material, a, bValue, cValue, desiredNormal = null,
  uvValues = null, normalValues = null) {
  const bucket = geometry.get(material);
  let b = bValue;
  let c = cValue;
  let uvs = uvValues ? uvValues.map((uv) => [...uv]) : [globalUv(a), globalUv(b), globalUv(c)];
  let normals = normalValues ? normalValues.map((normal) => normalize(normal)) : null;
  let faceNormal = normalize(cross(sub(b, a), sub(c, a)));
  if (desiredNormal && dot(faceNormal, desiredNormal) < 0) {
    [b, c] = [c, b];
    [uvs[1], uvs[2]] = [uvs[2], uvs[1]];
    if (normals) [normals[1], normals[2]] = [normals[2], normals[1]];
    faceNormal = normalize(cross(sub(b, a), sub(c, a)));
  }
  const base = bucket.positions.length / 3;
  for (let index = 0; index < 3; index += 1) {
    const point = [a, b, c][index];
    bucket.positions.push(...point);
    bucket.normals.push(...(normals ? normals[index] : faceNormal));
    bucket.uvs.push(...uvs[index]);
  }
  bucket.indices.push(base, base + 1, base + 2);
}

function addQuad(material, a, b, c, d, desiredNormal = null, uvs = null, normals = null) {
  const quadUvs = uvs || [globalUv(a), globalUv(b), globalUv(c), globalUv(d)];
  addTriangle(material, a, b, c, desiredNormal,
    [quadUvs[0], quadUvs[1], quadUvs[2]],
    normals && [normals[0], normals[1], normals[2]]);
  addTriangle(material, a, c, d, desiredNormal,
    [quadUvs[0], quadUvs[2], quadUvs[3]],
    normals && [normals[0], normals[2], normals[3]]);
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

function mirrored(polygon) {
  return polygon.map(([x, z]) => [-x, z]).reverse();
}

function addMirroredPrisms(material, rightPolygon, yBottom, yTop) {
  addPrism(material, rightPolygon, yBottom, yTop);
  addPrism(material, mirrored(rightPolygon), yBottom, yTop);
}

function addEllipticalLoft(material, sections, segments = 12) {
  const rings = sections.map((section) => Array.from({ length: segments }, (_, index) => {
    const angle = (index / segments) * Math.PI * 2;
    return [
      (section.x || 0) + Math.cos(angle) * section.rx,
      (section.y || 0) + Math.sin(angle) * section.ry,
      section.z,
    ];
  }));
  addPolygonFace(material, rings[0], [0, 0, -1]);
  addPolygonFace(material, rings.at(-1), [0, 0, 1]);
  for (let ring = 0; ring < rings.length - 1; ring += 1) {
    for (let index = 0; index < segments; index += 1) {
      const next = (index + 1) % segments;
      const angle0 = (index / segments) * Math.PI * 2;
      const angle1 = ((index + 1) / segments) * Math.PI * 2;
      const normal0 = [Math.cos(angle0), Math.sin(angle0), 0.08];
      const normal1 = [Math.cos(angle1), Math.sin(angle1), 0.08];
      const v0 = ring / (rings.length - 1);
      const v1 = (ring + 1) / (rings.length - 1);
      addQuad(material,
        rings[ring][index], rings[ring][next], rings[ring + 1][next], rings[ring + 1][index],
        normalize([Math.cos((angle0 + angle1) / 2), Math.sin((angle0 + angle1) / 2), 0.08]),
        [[index / segments, v0], [(index + 1) / segments, v0],
          [(index + 1) / segments, v1], [index / segments, v1]],
        [normal0, normal1, normal1, normal0]);
    }
  }
}

function addCylinderZ(material, x, y, zRear, zFront,
  rearRadius, frontRadius, segments = 16) {
  const rear = [];
  const front = [];
  const rearNormals = [];
  const frontNormals = [];
  for (let index = 0; index < segments; index += 1) {
    const angle = (index / segments) * Math.PI * 2;
    rear.push([x + Math.cos(angle) * rearRadius, y + Math.sin(angle) * rearRadius, zRear]);
    front.push([x + Math.cos(angle) * frontRadius, y + Math.sin(angle) * frontRadius, zFront]);
    rearNormals.push([Math.cos(angle), Math.sin(angle), 0]);
    frontNormals.push([Math.cos(angle), Math.sin(angle), 0]);
  }
  addPolygonFace(material, rear, [0, 0, -1]);
  addPolygonFace(material, front, [0, 0, 1]);
  for (let index = 0; index < segments; index += 1) {
    const next = (index + 1) % segments;
    addQuad(material, rear[index], rear[next], front[next], front[index], null,
      [[index / segments, 0], [(index + 1) / segments, 0],
        [(index + 1) / segments, 1], [index / segments, 1]],
      [rearNormals[index], rearNormals[next], frontNormals[next], frontNormals[index]]);
  }
}

function addCylinderY(material, x, yBottom, yTop, z, radius, segments = 24) {
  const bottom = [];
  const top = [];
  const normals = [];
  for (let index = 0; index < segments; index += 1) {
    const angle = (index / segments) * Math.PI * 2;
    bottom.push([x + Math.cos(angle) * radius, yBottom, z + Math.sin(angle) * radius]);
    top.push([x + Math.cos(angle) * radius, yTop, z + Math.sin(angle) * radius]);
    normals.push([Math.cos(angle), 0, Math.sin(angle)]);
  }
  addPolygonFace(material, bottom, [0, -1, 0]);
  addPolygonFace(material, top, [0, 1, 0]);
  for (let index = 0; index < segments; index += 1) {
    const next = (index + 1) % segments;
    addQuad(material, bottom[index], bottom[next], top[next], top[index], null,
      [[index / segments, 0], [(index + 1) / segments, 0],
        [(index + 1) / segments, 1], [index / segments, 1]],
      [normals[index], normals[next], normals[next], normals[index]]);
  }
}

function addTorusY(material, centerX, centerY, centerZ,
  majorRadius, tubeRadius, radialSegments = 40, tubeSegments = 10) {
  const point = (radial, tube) => {
    const around = (radial / radialSegments) * Math.PI * 2;
    const crossSection = (tube / tubeSegments) * Math.PI * 2;
    const radialDistance = majorRadius + Math.cos(crossSection) * tubeRadius;
    return {
      position: [
        centerX + Math.cos(around) * radialDistance,
        centerY + Math.sin(crossSection) * tubeRadius,
        centerZ + Math.sin(around) * radialDistance,
      ],
      normal: [
        Math.cos(around) * Math.cos(crossSection),
        Math.sin(crossSection),
        Math.sin(around) * Math.cos(crossSection),
      ],
      uv: [radial / radialSegments, tube / tubeSegments],
    };
  };
  for (let radial = 0; radial < radialSegments; radial += 1) {
    for (let tube = 0; tube < tubeSegments; tube += 1) {
      const a = point(radial, tube);
      const b = point(radial + 1, tube);
      const c = point(radial + 1, tube + 1);
      const d = point(radial, tube + 1);
      addQuad(material, a.position, b.position, c.position, d.position, a.normal,
        [a.uv, b.uv, c.uv, d.uv], [a.normal, b.normal, c.normal, d.normal]);
    }
  }
}

// Spearhead pressure hull with smooth, faceted longitudinal taper.
addEllipticalLoft('hull_primary', [
  { z: -2.42, rx: 0.38, ry: 0.24, y: -0.01 },
  { z: -1.72, rx: 0.61, ry: 0.34, y: 0.00 },
  { z: -0.72, rx: 0.79, ry: 0.43, y: 0.02 },
  { z: 0.36, rx: 0.72, ry: 0.48, y: 0.06 },
  { z: 1.34, rx: 0.53, ry: 0.37, y: 0.08 },
  { z: 2.28, rx: 0.27, ry: 0.22, y: 0.03 },
  { z: 3.18, rx: 0.025, ry: 0.035, y: 0.00 },
], 14);

// Layered inner wings and isolated outer blades create negative-space channels.
const innerWing = [
  [0.52, -1.83], [1.04, -2.18], [1.76, -1.70], [2.66, -0.91],
  [3.49, -0.25], [3.22, 0.48], [2.46, 1.20], [1.59, 1.55], [0.78, 0.66],
];
const outerBlade = [
  [2.43, -0.87], [3.23, -0.39], [3.72, 0.29], [3.39, 1.16],
  [2.87, 1.96], [2.43, 1.38], [2.76, 0.49],
];
const forwardBlade = [
  [0.77, 0.64], [1.42, 1.30], [1.78, 2.28], [1.44, 2.87],
  [1.04, 2.06], [0.64, 1.07],
];
addMirroredPrisms('hull_primary', innerWing, -0.15, 0.17);
addMirroredPrisms('hull_primary', outerBlade, -0.08, 0.16);
addMirroredPrisms('hull_primary', forwardBlade, -0.10, 0.22);

// Secondary armor floats above the primary structure in distinct readable layers.
addMirroredPrisms('armor_secondary', [
  [0.78, -1.39], [1.29, -1.61], [2.16, -0.83], [2.82, -0.08],
  [2.43, 0.53], [1.61, 0.98], [0.91, 0.44],
], 0.175, 0.315);
addMirroredPrisms('armor_secondary', [
  [2.77, -0.31], [3.25, 0.04], [3.42, 0.37], [3.19, 0.97],
  [2.88, 1.39], [2.68, 1.13], [2.92, 0.42],
], 0.17, 0.29);
addMirroredPrisms('armor_secondary', [
  [0.90, 1.00], [1.25, 1.40], [1.52, 2.23], [1.38, 2.47],
  [1.14, 1.89], [0.78, 1.14],
], 0.225, 0.36);

// Raised dorsal command spine and ventral keel.
addPrism('armor_secondary', [
  [-0.29, -1.92], [0.29, -1.92], [0.38, 0.70], [0.22, 2.18],
  [0, 2.72], [-0.22, 2.18], [-0.38, 0.70],
], 0.40, 0.57);
addPrism('mechanical_gunmetal', [
  [-0.24, -2.10], [0.24, -2.10], [0.33, 0.18], [0.17, 1.25],
  [-0.17, 1.25], [-0.33, 0.18],
], -0.43, -0.28);

// Smoked multi-section canopy embedded into the forward spine.
addEllipticalLoft('canopy_glass', [
  { z: 0.28, rx: 0.39, ry: 0.22, y: 0.43 },
  { z: 0.82, rx: 0.36, ry: 0.24, y: 0.48 },
  { z: 1.48, rx: 0.27, ry: 0.20, y: 0.48 },
  { z: 2.02, rx: 0.08, ry: 0.08, y: 0.40 },
], 12);
for (const [z, halfWidth, y] of [[0.58, 0.35, 0.70], [1.02, 0.32, 0.735], [1.45, 0.26, 0.70]]) {
  addPrism('structure_ivory', [
    [-halfWidth, z - 0.028], [halfWidth, z - 0.028],
    [halfWidth * 0.94, z + 0.028], [-halfWidth * 0.94, z + 0.028],
  ], y, y + 0.035);
}

// Twin gravitic rings: physical outer housings, luminous inner rings, and hubs.
for (const x of [-1.62, 1.62]) {
  addTorusY('mechanical_gunmetal', x, 0.26, -0.30, 0.69, 0.17, 44, 12);
  addTorusY('accent_energy', x, 0.285, -0.30, 0.53, 0.065, 44, 8);
  addTorusY('structure_ivory', x, 0.255, -0.30, 0.80, 0.035, 44, 6);
  addCylinderY('mechanical_gunmetal', x, 0.13, 0.24, -0.30, 0.34, 28);
  addTorusY('accent_energy', x, 0.25, -0.30, 0.24, 0.032, 32, 6);
}

// Three conventional thrusters supply readable rear propulsion architecture.
for (const [x, radius] of [[-0.47, 0.22], [0, 0.27], [0.47, 0.22]]) {
  addCylinderZ('mechanical_gunmetal', x, -0.02, -2.68, -2.12, radius, radius * 0.83, 20);
  addCylinderZ('engine_glow', x, -0.02, -2.75, -2.66, radius * 0.72, radius * 0.72, 20);
}

// Structural ivory rails break up the dark mass without relying on texture alone.
addMirroredPrisms('structure_ivory', [
  [2.43, -0.70], [2.56, -0.76], [3.17, -0.08], [3.08, 0.13],
  [2.78, -0.20], [2.52, -0.48],
], 0.32, 0.375);
addMirroredPrisms('structure_ivory', [
  [1.03, 1.25], [1.18, 1.40], [1.53, 2.29], [1.42, 2.53],
  [1.28, 2.20], [0.94, 1.41],
], 0.36, 0.415);
addPrism('structure_ivory', [
  [-0.105, 2.14], [0.105, 2.14], [0.065, 2.70], [0, 2.93], [-0.065, 2.70],
], 0.575, 0.63);

// Provider-tinted energy channels follow the silhouette and ring-drive logic.
addMirroredPrisms('accent_energy', [
  [2.70, 0.16], [2.79, 0.08], [3.29, 0.43], [3.21, 0.61],
  [2.96, 0.44], [2.77, 0.30],
], 0.378, 0.425);
addMirroredPrisms('accent_energy', [
  [2.89, 0.01], [3.02, 0.10], [3.20, 0.42], [3.08, 0.75],
  [2.99, 0.69], [3.10, 0.40],
], 0.292, 0.345);
addPrism('accent_energy', [
  [-0.055, 2.31], [0.055, 2.31], [0.035, 2.76], [0, 2.93], [-0.035, 2.76],
], 0.632, 0.685);

// Articulated dorsal vanes and small machined greebles reward close inspection.
addMirroredPrisms('armor_secondary', [
  [2.10, -1.48], [2.35, -1.35], [2.58, -0.55], [2.40, -0.42], [2.20, -0.88],
], 0.18, 0.48);
for (const side of [-1, 1]) {
  for (let index = 0; index < 7; index += 1) {
    const x0 = side * (0.42 + index * 0.115);
    const width = 0.055;
    const z0 = -1.74 + index * 0.17;
    const polygon = side < 0
      ? [[x0 - width, z0], [x0 + width, z0], [x0 + width, z0 + 0.11], [x0 - width, z0 + 0.11]]
      : [[x0 - width, z0], [x0 + width, z0], [x0 + width, z0 + 0.11], [x0 - width, z0 + 0.11]];
    addPrism('mechanical_gunmetal', polygon, 0.31, 0.43);
  }
}
for (const x of [-2.52, -2.31, 2.31, 2.52]) {
  addCylinderY('mechanical_gunmetal', x, 0.17, 0.33, 0.42, 0.075, 12);
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

const binary = new BinaryBuilder();
const accessors = [];
const meshes = [];
const nodes = [{ name: 'Vanta Seraph', children: [] }];

for (let materialIndex = 0; materialIndex < materialNames.length; materialIndex += 1) {
  const materialName = materialNames[materialIndex];
  const bucket = geometry.get(materialName);
  if (bucket.positions.length / 3 > 65535) throw new Error(`${materialName} exceeds uint16 vertex capacity`);
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
      indices: indicesAccessor, material: materialIndex, mode: 4,
    }],
  }) - 1;
  nodes[0].children.push(nodes.push({ name: materialName, mesh: meshIndex }) - 1);
}

const albedoView = binary.add(fs.readFileSync(ALBEDO_PATH));
const normalView = binary.add(fs.readFileSync(NORMAL_PATH));
const binaryChunk = binary.finish();

const texturedPbr = (factor, metallicFactor, roughnessFactor) => ({
  baseColorFactor: factor,
  baseColorTexture: { index: 0 },
  metallicFactor,
  roughnessFactor,
});
const gltf = {
  asset: {
    version: '2.0',
    generator: 'Agent Universe Vanta Seraph flagship generator',
    copyright: 'Original Vanta Seraph design released under CC0-1.0',
  },
  scene: 0,
  scenes: [{ name: 'Vanta Seraph Flagship', nodes: [0] }],
  nodes,
  meshes,
  materials: [
    {
      name: 'hull_primary',
      pbrMetallicRoughness: texturedPbr([0.82, 0.88, 1, 1], 0.76, 0.37),
      normalTexture: { index: 1, scale: 0.72 },
    },
    {
      name: 'armor_secondary',
      pbrMetallicRoughness: texturedPbr([0.52, 0.62, 0.88, 1], 0.68, 0.46),
      normalTexture: { index: 1, scale: 0.64 },
    },
    {
      name: 'structure_ivory',
      pbrMetallicRoughness: {
        baseColorFactor: [0.58, 0.55, 0.48, 1], metallicFactor: 0.72, roughnessFactor: 0.34,
      },
    },
    {
      name: 'mechanical_gunmetal',
      pbrMetallicRoughness: {
        baseColorFactor: [0.055, 0.065, 0.09, 1], metallicFactor: 0.94, roughnessFactor: 0.29,
      },
    },
    {
      name: 'accent_energy',
      pbrMetallicRoughness: {
        baseColorFactor: [0.025, 0.45, 0.90, 1], metallicFactor: 0.45, roughnessFactor: 0.20,
      },
      emissiveFactor: [0.03, 0.58, 1.0],
    },
    {
      name: 'canopy_glass',
      pbrMetallicRoughness: {
        baseColorFactor: [0.018, 0.07, 0.13, 0.90], metallicFactor: 0.30, roughnessFactor: 0.08,
      },
      emissiveFactor: [0.008, 0.04, 0.08],
      alphaMode: 'BLEND',
      doubleSided: true,
    },
    {
      name: 'engine_glow',
      pbrMetallicRoughness: {
        baseColorFactor: [0.01, 0.38, 0.86, 1], metallicFactor: 0.10, roughnessFactor: 0.18,
      },
      emissiveFactor: [0.02, 0.72, 1.0],
    },
  ],
  textures: [
    { name: 'Vanta Seraph albedo', sampler: 0, source: 0 },
    { name: 'Vanta Seraph normal', sampler: 0, source: 1 },
  ],
  samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
  images: [
    { name: 'vanta-seraph-albedo', mimeType: 'image/jpeg', bufferView: albedoView },
    { name: 'vanta-seraph-normal', mimeType: 'image/jpeg', bufferView: normalView },
  ],
  accessors,
  bufferViews: binary.bufferViews,
  buffers: [{ byteLength: binaryChunk.length }],
  extras: {
    shipId: 'aur-vanta-seraph',
    design: 'Original elite command interceptor and fleet quality benchmark',
    facing: '+Z',
    up: '+Y',
    features: [
      'layered bifurcated wings', 'twin gravitic ring drives', 'dorsal command spine',
      'triple conventional thrusters', 'embedded albedo and tangent-space normal maps',
    ],
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
fs.writeFileSync(OUTPUT_PATH, Buffer.concat([header, jsonHeader, paddedJson, binHeader, paddedBin]));

const triangles = [...geometry.values()].reduce((sum, bucket) => sum + bucket.indices.length / 3, 0);
const vertices = [...geometry.values()].reduce((sum, bucket) => sum + bucket.positions.length / 3, 0);
console.log(`Generated ${path.relative(ROOT, OUTPUT_PATH)} (${triangles} triangles, ${vertices} vertices, ${totalLength} bytes)`);

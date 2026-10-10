// Usage: node scripts/build-fleet-v2-runtime.mjs [hull-id ...]
// Rebuilds assets/ships/fleet-v2/<id>-far.glb and <id>-near.glb from the
// fleet-scale-v2 sources. Runs @gltf-transform/cli through npx (fetched on the
// first run, never a package dependency); needs no Blender.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIR = path.join(ROOT, 'assets', 'ships', 'fleet-scale-v2');
const OUT_DIR = path.join(ROOT, 'assets', 'ships', 'fleet-v2');
const CLI = '@gltf-transform/cli@4.5.1';
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_MESHES = 8;
const ACCENT = 'accent_energy';
const CREASE_COS = Math.cos((25 * Math.PI) / 180);
// Mean of the one metallic_roughness map every source material shares.
const MAP_METALLIC = 0.88;
const MAP_ROUGHNESS = 0.41;

// cull / accentCull: drop parts whose bounding-box diagonal is below this
// fraction of the ship's diagonal (accent parts glow on the unlit universe map,
// so they keep a lower limit). tris: simplifier target, growing with the rank's
// display size. error: meshoptimizer limit as a fraction of each joined mesh's
// extent. Tuned by eye against the source in a contact sheet.
const far = (tris) => ({ cull: 0.03, accentCull: 0.012, tris, error: 0.04 });
const near = (tris) => ({ cull: 0.006, accentCull: 0, tris, error: 0.02 });
const HULLS = [
  { id: 'aur-wisp-drone', far: far(1500), near: near(5000) },
  { id: 'aur-lance-interceptor', far: far(3000), near: near(8000) },
  { id: 'aur-wayfarer-shuttle', far: far(3000), near: near(9000) },
  { id: 'aur-bastion-corvette', far: far(3500), near: near(10000) },
  { id: 'aur-vigil-frigate', far: far(3500), near: near(12000) },
  { id: 'aur-helix-destroyer', far: far(4000), near: near(14000) },
  { id: 'aur-atlas-cruiser', far: far(4000), near: near(16000) },
  { id: 'aur-ark-carrier', far: far(4000), near: near(18000) },
];

// Babylon has no offline decoder for compressed geometry or textures, and the
// app tints by material, so the runtime files use no glTF extensions at all.
const STRIPPED_MATERIAL_EXTENSIONS = [
  'KHR_materials_transmission', 'KHR_materials_clearcoat', 'KHR_materials_emissive_strength',
];
const TEXTURE_SLOTS = ['normalTexture', 'occlusionTexture', 'emissiveTexture'];

// ---------- GLB container ----------

function readGlb(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file}: not a GLB`);
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));
  const binStart = 20 + jsonLength;
  const bin = binStart < bytes.length
    ? bytes.subarray(binStart + 8, binStart + 8 + bytes.readUInt32LE(binStart)) : null;
  return { json, bin };
}

function chunk(type, data, pad) {
  const padded = Buffer.alloc(Math.ceil(data.length / 4) * 4, pad);
  data.copy(padded);
  const header = Buffer.alloc(8);
  header.writeUInt32LE(padded.length, 0);
  header.writeUInt32LE(type, 4);
  return Buffer.concat([header, padded]);
}

function writeGlb(file, json, bin) {
  const parts = [chunk(0x4e4f534a, Buffer.from(JSON.stringify(json), 'utf8'), 0x20)];
  if (bin) parts.push(chunk(0x004e4942, bin, 0));
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + parts.reduce((sum, part) => sum + part.length, 0), 8);
  fs.writeFileSync(file, Buffer.concat([header, ...parts]));
}

// ---------- scene bounds ----------

function nodeMatrix(node) {
  if (node.matrix) return node.matrix;
  const [tx, ty, tz] = node.translation || [0, 0, 0];
  const [x, y, z, w] = node.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale || [1, 1, 1];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + w * z) * sx, 2 * (x * z - w * y) * sx, 0,
    2 * (x * y - w * z) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + w * x) * sy, 0,
    2 * (x * z + w * y) * sz, 2 * (y * z - w * x) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      for (let k = 0; k < 4; k++) out[col * 4 + row] += a[k * 4 + row] * b[col * 4 + k];
    }
  }
  return out;
}

function emptyBox() {
  return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
}

function growBox(box, matrix, accessor) {
  for (let corner = 0; corner < 8; corner++) {
    const p = [0, 1, 2].map((axis) => (corner >> axis) & 1 ? accessor.max[axis] : accessor.min[axis]);
    for (let axis = 0; axis < 3; axis++) {
      const value = matrix[axis] * p[0] + matrix[4 + axis] * p[1] + matrix[8 + axis] * p[2] + matrix[12 + axis];
      box.min[axis] = Math.min(box.min[axis], value);
      box.max[axis] = Math.max(box.max[axis], value);
    }
  }
}

/** Every mesh node with its world matrix. */
function meshNodes(json) {
  const found = [];
  const visit = (index, parent) => {
    const node = json.nodes[index];
    const world = multiply(parent, nodeMatrix(node));
    if (node.mesh != null) found.push({ node, world });
    for (const child of node.children || []) visit(child, world);
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const index of json.scenes[json.scene || 0].nodes) visit(index, identity);
  return found;
}

/** Conservative world-space box of every mesh node, plus the whole scene's box. */
function meshNodeBoxes(json) {
  const scene = emptyBox();
  const boxes = meshNodes(json).map(({ node, world }) => {
    const box = emptyBox();
    for (const primitive of json.meshes[node.mesh].primitives) {
      growBox(box, world, json.accessors[primitive.attributes.POSITION]);
      growBox(scene, world, json.accessors[primitive.attributes.POSITION]);
    }
    return { node, box };
  });
  return { boxes, scene };
}

const diagonal = (box) => Math.hypot(...box.max.map((value, axis) => value - box.min[axis]));

function primitiveTriangles(json, primitive) {
  const accessor = json.accessors[primitive.indices != null ? primitive.indices : primitive.attributes.POSITION];
  return accessor.count / 3;
}

function meshTriangles(json) {
  return meshNodeBoxes(json).boxes.reduce((total, { node }) =>
    total + json.meshes[node.mesh].primitives.reduce((sum, primitive) =>
      sum + primitiveTriangles(json, primitive), 0), 0);
}

// ---------- JSON-only passes (the BIN chunk is left as is; prune drops orphans) ----------

// The provider tint owns albedo and the accent's emission, so the hulls carry
// no textures: the navy base colour and cyan stripes would fight the tint, and
// the 256 px panel maps vanish at the app's ship sizes. Without normals and UVs
// the simplifier can weld across hard edges; normals are rebuilt afterwards.
function plainMaterials(json) {
  for (const material of json.materials || []) {
    if (material.extensions) {
      for (const name of STRIPPED_MATERIAL_EXTENSIONS) delete material.extensions[name];
      if (Object.keys(material.extensions).length === 0) delete material.extensions;
    }
    // Untextured materials can become identical; the role keeps dedup from
    // merging them, since the renderer tints by material name.
    material.extras = { ...material.extras, tintRole: material.name };
    const pbr = material.pbrMetallicRoughness || (material.pbrMetallicRoughness = {});
    if (pbr.metallicRoughnessTexture) {
      pbr.metallicFactor = (pbr.metallicFactor ?? 1) * MAP_METALLIC;
      pbr.roughnessFactor = (pbr.roughnessFactor ?? 1) * MAP_ROUGHNESS;
    }
    delete pbr.baseColorTexture;
    delete pbr.metallicRoughnessTexture;
    for (const slot of TEXTURE_SLOTS) delete material[slot];
    if (material.name === ACCENT) material.emissiveFactor = [1, 1, 1];
  }
  for (const mesh of json.meshes) {
    for (const primitive of mesh.primitives) {
      primitive.attributes = { POSITION: primitive.attributes.POSITION };
    }
  }
  delete json.extensionsUsed;
  delete json.extensionsRequired;
}

function usesAccent(json, node) {
  return json.meshes[node.mesh].primitives.some((primitive) =>
    json.materials[primitive.material].name === ACCENT);
}

/** Drops small parts and returns the triangles left for the simplifier. */
function cullSmallParts(json, settings) {
  const { boxes, scene } = meshNodeBoxes(json);
  const size = diagonal(scene);
  for (const { node, box } of boxes) {
    const limit = usesAccent(json, node) ? settings.accentCull : settings.cull;
    if (diagonal(box) < size * limit) delete node.mesh;
  }
  return meshTriangles(json);
}

// ---------- geometry: crease-angle normals ----------

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const READERS = {
  5126: [4, (view, at) => view.getFloat32(at, true)],
  5125: [4, (view, at) => view.getUint32(at, true)],
  5123: [2, (view, at) => view.getUint16(at, true)],
  5121: [1, (view, at) => view.getUint8(at)],
};

function readAccessor(json, bin, index) {
  const accessor = json.accessors[index];
  const bufferView = json.bufferViews[accessor.bufferView];
  const components = COMPONENTS[accessor.type];
  const [bytes, read] = READERS[accessor.componentType];
  const stride = bufferView.byteStride || components * bytes;
  const base = (bufferView.byteOffset || 0) + (accessor.byteOffset || 0);
  const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const out = new Float64Array(accessor.count * components);
  for (let i = 0; i < accessor.count; i++) {
    for (let c = 0; c < components; c++) out[i * components + c] = read(view, base + i * stride + c * bytes);
  }
  return out;
}

function faceNormals(positions, indices) {
  const normals = new Float64Array(indices.length);
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t] * 3, indices[t + 1] * 3, indices[t + 2] * 3];
    const u = [0, 1, 2].map((k) => positions[b + k] - positions[a + k]);
    const v = [0, 1, 2].map((k) => positions[c + k] - positions[a + k]);
    normals[t] = u[1] * v[2] - u[2] * v[1];
    normals[t + 1] = u[2] * v[0] - u[0] * v[2];
    normals[t + 2] = u[0] * v[1] - u[1] * v[0];
  }
  return normals;
}

const unit = (x, y, z) => {
  const length = Math.hypot(x, y, z);
  return length > 0 ? [x / length, y / length, z / length] : null;
};

/** Splits vertices where adjacent faces meet at more than the crease angle. */
function creaseShade(positions, indices) {
  const area = faceNormals(positions, indices);
  const faceUnit = [];
  const facesOf = new Map();
  for (let t = 0; t < indices.length; t += 3) {
    faceUnit.push(unit(area[t], area[t + 1], area[t + 2]));
    for (let k = 0; k < 3; k++) {
      const vertex = indices[t + k];
      if (!facesOf.has(vertex)) facesOf.set(vertex, []);
      facesOf.get(vertex).push(t / 3);
    }
  }
  const outPositions = [];
  const outNormals = [];
  const outIndices = [];
  const lookup = new Map();
  for (let face = 0; face < faceUnit.length; face++) {
    const own = faceUnit[face];
    if (!own) continue; // zero-area triangles left by the simplifier
    for (let k = 0; k < 3; k++) {
      const vertex = indices[face * 3 + k];
      const sum = [0, 0, 0];
      for (const other of facesOf.get(vertex)) {
        const n = faceUnit[other];
        if (!n || n[0] * own[0] + n[1] * own[1] + n[2] * own[2] < CREASE_COS) continue;
        for (let axis = 0; axis < 3; axis++) sum[axis] += area[other * 3 + axis];
      }
      const normal = unit(...sum) || own;
      const key = `${vertex}:${normal.map((value) => Math.round(value * 1000)).join(',')}`;
      let index = lookup.get(key);
      if (index == null) {
        index = outPositions.length / 3;
        lookup.set(key, index);
        outPositions.push(positions[vertex * 3], positions[vertex * 3 + 1], positions[vertex * 3 + 2]);
        outNormals.push(...normal);
      }
      outIndices.push(index);
    }
  }
  return { positions: outPositions, normals: outNormals, indices: outIndices };
}

const determinant = (m) => m[0] * (m[5] * m[10] - m[9] * m[6]) -
  m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);

/**
 * Bakes node transforms into the vertices (join can leave a part's rotation on
 * its merged mesh, which loosens every bounding box), centres the hull on the
 * origin and returns world-space primitives with the hull's extent.
 */
function bakeWorldGeometry(json, bin) {
  const nodes = meshNodes(json);
  if (new Set(nodes.map(({ node }) => node.mesh)).size !== nodes.length) {
    throw new Error('a mesh is shared by several nodes');
  }
  const bounds = emptyBox();
  const parts = [];
  for (const { node, world } of nodes) {
    for (const primitive of json.meshes[node.mesh].primitives) {
      const local = readAccessor(json, bin, primitive.attributes.POSITION);
      const positions = new Float64Array(local.length);
      for (let i = 0; i < local.length; i += 3) {
        for (let axis = 0; axis < 3; axis++) {
          const value = world[axis] * local[i] + world[4 + axis] * local[i + 1] +
            world[8 + axis] * local[i + 2] + world[12 + axis];
          positions[i + axis] = value;
          bounds.min[axis] = Math.min(bounds.min[axis], value);
          bounds.max[axis] = Math.max(bounds.max[axis], value);
        }
      }
      const indices = primitive.indices != null
        ? readAccessor(json, bin, primitive.indices)
        : Float64Array.from({ length: positions.length / 3 }, (_, i) => i);
      if (determinant(world) < 0) {
        for (let t = 0; t < indices.length; t += 3) [indices[t + 1], indices[t + 2]] = [indices[t + 2], indices[t + 1]];
      }
      parts.push({ primitive, positions, indices });
    }
  }
  for (const node of json.nodes) {
    for (const key of ['matrix', 'translation', 'rotation', 'scale']) delete node[key];
  }
  const center = bounds.min.map((value, axis) => (value + bounds.max[axis]) / 2);
  for (const { positions } of parts) {
    for (let i = 0; i < positions.length; i++) positions[i] -= center[i % 3];
  }
  return { parts, extent: bounds.max.map((value, axis) => value - bounds.min[axis]) };
}

/** Rewrites every primitive as POSITION + NORMAL + indices in a fresh BIN. */
function writeShadedGeometry(json, parts) {
  const views = [];
  const accessors = [];
  const pieces = [];
  let offset = 0;
  const append = (typed, target) => {
    const bytes = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    const padding = (4 - (bytes.length % 4)) % 4;
    views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
    pieces.push(bytes, Buffer.alloc(padding));
    offset += bytes.length + padding;
    return views.length - 1;
  };
  for (const { primitive, positions, indices } of parts) {
    const shaded = creaseShade(positions, indices);
    const vertexCount = shaded.positions.length / 3;
    const packed = Float32Array.from(shaded.positions);
    const { min, max } = emptyBox();
    packed.forEach((value, i) => {
      min[i % 3] = Math.min(min[i % 3], value);
      max[i % 3] = Math.max(max[i % 3], value);
    });
    accessors.push({ bufferView: append(packed, 34962), componentType: 5126, count: vertexCount, type: 'VEC3', min, max });
    accessors.push({ bufferView: append(Float32Array.from(shaded.normals), 34962), componentType: 5126, count: vertexCount, type: 'VEC3' });
    const wide = vertexCount > 65535;
    const indexArray = wide ? Uint32Array.from(shaded.indices) : Uint16Array.from(shaded.indices);
    accessors.push({ bufferView: append(indexArray, 34963), componentType: wide ? 5125 : 5123, count: shaded.indices.length, type: 'SCALAR' });
    primitive.attributes = { POSITION: accessors.length - 3, NORMAL: accessors.length - 2 };
    primitive.indices = accessors.length - 1;
  }
  for (const key of ['images', 'textures', 'samplers']) delete json[key];
  json.accessors = accessors;
  json.bufferViews = views;
  json.buffers = [{ byteLength: offset }];
  return Buffer.concat(pieces);
}

// ---------- pipeline ----------

function runCli(args) {
  const quoted = ['-y', CLI, ...args].map((arg) => `"${arg}"`).join(' ');
  const result = spawnSync(`npx ${quoted}`, { shell: true, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`gltf-transform ${args[0]} failed:\n${result.stdout}\n${result.stderr}`);
  }
}

function audit(file, json) {
  const size = fs.statSync(file).size;
  const primitives = json.meshes.flatMap((mesh) => mesh.primitives);
  const accent = json.materials.findIndex((material) => material.name === ACCENT);
  const problems = [];
  if (size > MAX_BYTES) problems.push(`${size} bytes exceeds 2 MB`);
  if (json.meshes.length > MAX_MESHES) problems.push(`${json.meshes.length} meshes exceeds ${MAX_MESHES}`);
  if (accent < 0 || !primitives.some((primitive) => primitive.material === accent)) {
    problems.push(`no primitive uses ${ACCENT}; provider tint evidence would be lost`);
  }
  if ((json.extensionsUsed || []).length) problems.push(`uses extensions ${json.extensionsUsed.join(', ')}`);
  if (problems.length) throw new Error(`${path.basename(file)}: ${problems.join('; ')}`);
  return { size, meshes: json.meshes.length };
}

function buildLod(hull, lod, tmp) {
  const settings = hull[lod];
  const source = readGlb(path.join(SOURCE_DIR, hull.id, `${hull.id}.glb`));
  plainMaterials(source.json);
  const input = cullSmallParts(source.json, settings);
  const culled = path.join(tmp, `${hull.id}-${lod}-culled.glb`);
  const optimized = path.join(tmp, `${hull.id}-${lod}-optimized.glb`);
  writeGlb(culled, source.json, source.bin);

  const ratio = Math.min(1, settings.tris / input).toFixed(4);
  runCli([
    'optimize', culled, optimized,
    '--compress', 'false', '--texture-compress', 'false', '--instance', 'false',
    '--palette', 'false', '--resample', 'false', '--sparse', 'false',
    '--simplify-ratio', ratio, '--simplify-error', String(settings.error),
  ]);

  const result = readGlb(optimized);
  const { parts, extent } = bakeWorldGeometry(result.json, result.bin);
  const bin = writeShadedGeometry(result.json, parts);
  result.json.asset.extras = {
    source: `fleet-scale-v2/${hull.id}/${hull.id}.glb`, lod, license: 'CC0-1.0',
  };
  const out = path.join(OUT_DIR, `${hull.id}-${lod}.glb`);
  writeGlb(out, result.json, bin);
  return {
    file: path.relative(ROOT, out).replace(/\\/g, '/'), input, ratio: Number(ratio),
    triangles: meshTriangles(result.json), ...audit(out, result.json),
    length: Number(extent[2].toFixed(3)),
  };
}

function main() {
  const only = new Set(process.argv.slice(2));
  const hulls = HULLS.filter((hull) => only.size === 0 || only.has(hull.id));
  if (only.size && hulls.length !== only.size) throw new Error('unknown hull id in arguments');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-v2-'));
  try {
    for (const hull of hulls) {
      for (const lod of ['far', 'near']) {
        console.log(JSON.stringify({ id: hull.id, lod, ...buildLod(hull, lod, tmp) }));
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main();

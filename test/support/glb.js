'use strict';

// A hull file's glTF JSON and the length it spans along Z, for test/fleet-ships.test.js and
// test/ships-petrel-model.test.js.
const assert = require('node:assert/strict');
const fs = require('node:fs');

function readGlbJson(filePath) {
  const bytes = fs.readFileSync(filePath);
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, 'GLB magic');
  assert.equal(bytes.readUInt32LE(4), 2, 'GLB version');
  assert.equal(bytes.readUInt32LE(8), bytes.length, 'declared GLB length');
  const jsonLength = bytes.readUInt32LE(12);
  return {
    bytes,
    model: JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8').trim()),
  };
}

function glbLength(model) {
  const positions = model.meshes.flatMap((mesh) =>
    mesh.primitives.map((primitive) => model.accessors[primitive.attributes.POSITION]));
  return Math.max(...positions.map((accessor) => accessor.max[2])) -
    Math.min(...positions.map((accessor) => accessor.min[2]));
}

module.exports = { readGlbJson, glbLength };

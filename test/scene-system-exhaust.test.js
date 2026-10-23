'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readRenderer: renderer } = require('./support/renderer-source');

test('the system view trails a plume from each stern nozzle of a hull, read off its glow discs', () => {
  const exhaust = renderer('scene/system/exhaust.js');
  const ships = renderer('scene/system/ships.js');
  const focus = renderer('scene/system/focus.js');
  const view = renderer('scene/system/view.js');

  assert.match(view, /parts\.exhaust\(view\)/);
  assert.match(exhaust, /mesh\.material\.metadata\.role !== 'glow'/, 'nozzles are the glow material');
  assert.match(exhaust, /AUR\.meshIslands\(positions, indices\)/, 'one plume per disc, not one per mesh');
  assert.match(exhaust, /AUR\.sternIslands\(islands, length, PLUME\.sternShare\)/, 'lit intakes forward of the stern get no plume');
  assert.match(exhaust, /new BABYLON\.TrailMesh\([^)]*anchor/, 'the ribbon trails an anchor, not the ship root');
  assert.match(exhaust, /anchor\.parent = rec\.mesh;/, 'the anchor rides the ship root and its display scale');
  assert.match(exhaust, /plumeMaterial\(rec\.tint\)/, 'one material per tint, shared by every plume');
  assert.match(exhaust, /glow\.addExcludedMesh\(trail\)/, 'additive plumes skip the glow pass');
  assert.doesNotMatch(ships, /TrailMesh/, 'the ships part no longer trails from the ship origin');
  assert.match(ships, /view\.attachExhaust\(rec\);/);
  assert.match(ships, /view\.detachExhaust\(r\);/);
  assert.match(ships, /const hull = AUR\.shipHullId\(r\.mesh\);\s*if \(r\.hull !== hull\)/, 'a hull arriving or swapping re-anchors the plumes');
  assert.match(focus, /rec\.plumes/, 'focus fades the plumes with the ship');
});

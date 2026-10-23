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
  assert.match(exhaust, /AUR\.memo\(hulls, rec\.hull/, 'nozzles are found once per hull, not once per ship');
  assert.match(exhaust, /new BABYLON\.TrailMesh\([^)]*anchor/, 'the ribbon trails a nozzle anchor under the root, not the root');
  assert.match(exhaust, /plumeMaterial\(rec\.tint\)/, 'one material per tint, shared by every plume');
  assert.match(exhaust, /glow\.addExcludedMesh\(trail\)/, 'additive plumes skip the glow pass');
  assert.match(exhaust, /rec\.hull === hull/, 'the part re-anchors when the hull under the record changes');
  assert.doesNotMatch(ships, /TrailMesh/, 'the ships part no longer trails from the ship origin');
  assert.match(ships, /if \(view\.refreshExhaust\(r\)\) view\.applyShipFocusVisual\(r\);/, 'each frame the plumes follow the hull and the focus fade covers them');
  assert.match(ships, /view\.detachExhaust\(r\);/);
  assert.match(focus, /rec\.plumes/, 'focus fades the plumes with the ship');
});

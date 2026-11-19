'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runRenderer } = require('./support/renderer-source');

function registry() {
  const window = { AUR: {} };
  runRenderer('ships/modules.js', { window });
  return window.AUR;
}

test('a ship module runs the first time it is used, once, whatever order the modules registered in', () => {
  const AUR = registry();
  const ran = [];
  AUR.shipModule('ship/hull', (use) => { ran.push('hull'); return { length: use('ship/frame').LENGTH * 2 }; });
  AUR.shipModule('ship/frame', () => { ran.push('frame'); return { LENGTH: 4 }; });
  assert.deepEqual(ran, [], 'registering builds nothing');
  assert.equal(AUR.useShipModule('ship/hull').length, 8);
  assert.equal(AUR.useShipModule('ship/hull'), AUR.useShipModule('ship/hull'));
  assert.deepEqual(ran, ['hull', 'frame']);
});

test('a missing module and a module that depends on itself both say so', () => {
  const AUR = registry();
  AUR.shipModule('ship/a', (use) => use('ship/b'));
  AUR.shipModule('ship/b', (use) => use('ship/a'));
  assert.throws(() => AUR.useShipModule('ship/none'), /ship\/none is not loaded/);
  assert.throws(() => AUR.useShipModule('ship/a'), /depends on itself/);
  // A failed module can be used again once what it needed is there.
  AUR.shipModule('ship/b', () => 'b');
  assert.equal(AUR.useShipModule('ship/a'), 'b');
});

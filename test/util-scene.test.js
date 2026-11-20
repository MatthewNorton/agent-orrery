'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadUtilLayer, scriptTags } = require('./support/renderer-source');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');

test('index.html loads every util-*.js file directly after util.js', () => {
  const tags = scriptTags();
  const parts = fs.readdirSync(RENDERER).filter((f) => /^util-[a-z0-9-]+\.js$/.test(f)).sort();
  const at = tags.indexOf('util.js');
  assert.ok(at >= 0, 'util.js is loaded');
  assert.ok(parts.length > 0, 'util.js has split-off parts');
  assert.deepEqual(tags.slice(at + 1, at + 1 + parts.length).sort(), parts);
});

test('markShipMesh tags a hull with its normalized provider identity', () => {
  const AUR = loadUtilLayer();
  const mesh = { metadata: { lod: 'near' } };
  const provider = AUR.markShipMesh(mesh, { id: 7, project: 'p1', provider: 'Claude Code', kind: 'drone' });

  assert.equal(provider.key, 'claude');
  assert.deepEqual({ ...mesh.metadata }, {
    lod: 'near', isShip: true, shipId: '7', projectId: 'p1',
    providerKey: 'claude', providerLabel: 'Claude', kind: 'drone',
  });
});

test('sceneProviderStats counts ship meshes per provider and flags tint mismatches', () => {
  const AUR = loadUtilLayer();
  const shipMesh = (id, provider, hex) => {
    const mesh = { material: { emissiveColor: { toHexString: () => hex.toUpperCase() } } };
    AUR.markShipMesh(mesh, { id, project: 'p', provider });
    return mesh;
  };
  const stats = AUR.sceneProviderStats({
    meshes: [
      shipMesh('b', 'codex', '#f2f0ea'),
      shipMesh('a', 'claude', '#d97757'),
      shipMesh('c', 'claude', '#123456'),
      { metadata: { isShip: false } },
      {},
    ],
  });

  assert.equal(stats.shipMeshCount, 3);
  assert.deepEqual({ ...stats.providerCounts }, { claude: 2, codex: 1, generic: 0, local: 0 });
  assert.deepEqual([...stats.representedProviders], ['claude', 'codex']);
  assert.equal(stats.distinctProviderCount, 2);
  assert.equal(stats.distinctColorCount, 3);
  assert.equal(stats.colorMismatchCount, 1);
  assert.deepEqual([...stats.ships].map((ship) => ship.shipId), ['a', 'b', 'c']);
  assert.equal(stats.ships[2].expectedColor, '#d97757');
  assert.equal(AUR.sceneProviderStats(null).shipMeshCount, 0);
});

test('meshIslands splits a mesh into its connected pieces, each with a centre and radius', () => {
  const AUR = loadUtilLayer();
  // Two unit squares of two triangles: one at the origin sharing its vertices, one at x = 10 with
  // a vertex per corner per face, as a flat-shaded export has them; and a stray vertex.
  const positions = [
    0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
    10, 0, 0, 11, 0, 0, 11, 1, 0, 10, 0, 0, 11, 1, 0, 10, 1, 0,
    50, 50, 50,
  ];
  const indices = [0, 1, 2, 0, 2, 3, 4, 5, 6, 7, 8, 9];
  const islands = AUR.meshIslands(positions, indices).sort((a, b) => a.center[0] - b.center[0]);

  assert.deepEqual(islands.map((island) => island.center), [[0.5, 0.5, 0], [10.5, 0.5, 0]], 'a vertex no triangle uses is no island');
  for (const island of islands) assert.ok(Math.abs(island.radius - Math.SQRT1_2) < 1e-9);
});

test('sternIslands keeps the glow islands near the stern and drops lit intakes forward of it', () => {
  const AUR = loadUtilLayer();
  const island = (z) => ({ position: { z }, radius: 1 });
  // A 90 m hull: nozzles at -31, -30 and -28, lit intakes at +22.
  const kept = AUR.sternIslands([island(-30), island(-28), island(22), island(-31)], 90, 0.25);

  assert.deepEqual(Array.from(kept, (found) => found.position.z), [-30, -28, -31]);
});

test('shipHullId names the hull under a dart, the asset root itself, or nothing for a bare dart', () => {
  const AUR = loadUtilLayer();
  assert.equal(AUR.shipHullId({ metadata: { upgradedHullId: 'scout' } }), 'scout');
  assert.equal(AUR.shipHullId({ metadata: { assetHullId: 'capital' } }), 'capital');
  assert.equal(AUR.shipHullId({ metadata: {} }), null);
  assert.equal(AUR.shipHullId(null), null);
});

test('shipHullNode finds the hull swapped in under a dart, past its plume anchors, or gives the mesh itself', () => {
  const AUR = loadUtilLayer();
  const anchor = { metadata: null };
  const hull = { metadata: { assetHullId: 'scout' } };
  const under = (children) => (predicate, directOnly) => {
    assert.equal(directOnly, true, 'only the dart\'s own children: a hull holds parts tagged with its id too');
    return children.filter(predicate);
  };
  const dart = { metadata: { upgradedHullId: 'scout' }, getChildren: under([anchor, hull]) };
  assert.equal(AUR.shipHullNode(dart), hull);
  const root = { metadata: { assetHullId: 'capital' }, getChildren: under([]) };
  assert.equal(AUR.shipHullNode(root), root, 'a hull built in place');
  const bare = { metadata: { isShip: true }, getChildren: under([anchor]) };
  assert.equal(AUR.shipHullNode(bare), bare, 'a dart that flies no hull');
  const arriving = { metadata: { upgradedHullId: 'scout' }, getChildren: under([anchor]) };
  assert.equal(AUR.shipHullNode(arriving), arriving, 'a dart noted before its hull is under it');
});

test('memo builds an entry once and hands the same one back after', () => {
  const AUR = loadUtilLayer();
  const map = new Map();
  let builds = 0;
  const build = () => ({ build: ++builds });
  assert.equal(AUR.memo(map, 'k', build), AUR.memo(map, 'k', build));
  assert.equal(builds, 1);
});

test('AUR.dressed returns a material once dressed, and disposes one that cannot be', () => {
  const AUR = loadUtilLayer();
  const made = () => ({ disposed: 0, dispose() { this.disposed += 1; } });
  const whole = made();
  assert.equal(AUR.dressed(whole, (material) => { material.worn = true; }), whole);
  assert.deepEqual([whole.worn, whole.disposed], [true, 0]);

  const half = made();
  const fault = new Error('no trim');
  assert.throws(() => AUR.dressed(half, () => { throw fault; }), (error) => error === fault);
  assert.equal(half.disposed, 1);

  const logs = [];
  AUR.log = (message) => logs.push(message);
  const stuck = { name: 'lamp claude', dispose() { throw new Error('no dispose'); } };
  assert.throws(() => AUR.dressed(stuck, () => { throw fault; }), (error) => error === fault, 'the cause stays the dressing\'s');
  assert.deepEqual(logs, ['Undressed material lamp claude could not be disposed (no dispose).']);
});

test('AUR.disposeLogged logs a dispose that throws once per message', () => {
  const AUR = loadUtilLayer();
  const logs = [];
  AUR.log = (message) => logs.push(message);
  let cause = 'no dispose';
  const stuck = { dispose() { throw new Error(cause); } };
  AUR.disposeLogged(stuck, 'A copy');
  AUR.disposeLogged(stuck, 'A copy');
  cause = 'context lost';
  AUR.disposeLogged(stuck, 'A copy');
  assert.deepEqual(logs, ['A copy could not be disposed (no dispose).', 'A copy could not be disposed (context lost).']);
});

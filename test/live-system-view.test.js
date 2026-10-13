'use strict';

// src/main/live/system-view.js: planets listed from a project folder on disk.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getSystem, getPlanet, isPlanetSegment, IGNORE_DIRS } = require('../src/main/live/system-view');

function projectOnDisk(t, files, buckets = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'au-live-system-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const rel of files) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), 'x');
  }
  const project = {
    id: 'p', path: root, name: path.basename(root), exists: true,
    lastActivity: 0, totalBytes: 0, buckets, totalBuilds: 0, firstSeen: 0,
  };
  const model = { projects: new Map([['p', project]]), systemCache: new Map() };
  return { root, project, model };
}

test('live system view: planets are top-level folders ranked by files plus five per build', (t) => {
  const { model } = projectOnDisk(t, [
    'big/1.js', 'big/2.js', 'big/3.js', 'big/4.js', 'big/5.js',
    'small/a.js', 'small/deep/b.js', 'small/deep/c.js',
    'node_modules/pkg/index.js', '.hidden/x.js', 'build/out.js',
    'README.md', 'notes.txt',
  ], { small: 2, '(root)': 1 });

  const system = getSystem(model, 'p');
  assert.deepEqual(system.planets, [
    { name: 'small', files: 3, builds: 2 },
    { name: '(root)', files: 2, builds: 1 },
    { name: 'big', files: 5, builds: 0 },
  ]);
  assert.equal(system.beltDensity, 2);
  assert.equal(system.project.id, 'p');
  assert.equal(getSystem(model, 'missing'), null);
});

test('live system view: at most eight planets; a system is cached for 30 s', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const { root, model } = projectOnDisk(t, Array.from({ length: 10 }, (_, index) => `dir${index}/f.js`));
  const first = getSystem(model, 'p');
  assert.equal(first.planets.length, 8);

  fs.rmSync(path.join(root, 'dir0'), { recursive: true });
  t.mock.timers.tick(29_999);
  assert.equal(getSystem(model, 'p'), first);
  t.mock.timers.tick(1);
  const fresh = getSystem(model, 'p');
  assert.notEqual(fresh, first);
  assert.equal(fresh.planets.some((planet) => planet.name === 'dir0'), false);
});

test('live system view: a planet walks two levels down; the root planet counts top-level files only', (t) => {
  const { model } = projectOnDisk(t, [
    'src/a.js', 'src/b.ts', 'src/lib/c.js', 'src/lib/deeper/d.js', 'src/lib/deeper/deepest/e.js',
    'src/node_modules/x.js', 'README.md', 'NOTES.md', 'package.json',
  ], { src: 4 });

  const src = getPlanet(model, 'p', 'src');
  assert.deepEqual([src.files, src.subdirs, src.builds, src.resources], [4, 1, 4, ['JS', 'TS']]);
  const rootPlanet = getPlanet(model, 'p', '(root)');
  assert.deepEqual([rootPlanet.files, rootPlanet.subdirs, rootPlanet.resources], [3, 1, ['MD', 'JSON']]);
  assert.equal(getPlanet(model, 'p', 'src/lib'), null);
  assert.equal(getPlanet(model, 'missing', 'src'), null);
});

test('live system view: a planet name is one plain path segment', () => {
  for (const ok of ['src', 'Docs', '(root)', '.config', 'a'.repeat(255)]) assert.equal(isPlanetSegment(ok), true, ok);
  for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a\0b', 'a'.repeat(256), null, 7]) {
    assert.equal(isPlanetSegment(bad), false, String(bad));
  }
  assert.equal(IGNORE_DIRS.has('node_modules'), true);
});

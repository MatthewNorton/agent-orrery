'use strict';

// src/main/live/system-view.js: planets listed from a project folder on disk.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getSystem, getPlanet, isPlanetSegment, IGNORE_DIRS } = require('../src/main/live/system-view');
const { liveProject, tempDir } = require('./support/main-wiring');

// `files` are written; a path ending in '/' is an empty folder. `under` nests the project below the
// temp folder: 'case\\root' gives it a Windows-style path on every host (one folder with a
// backslash in its name on POSIX), so folder names compare in any case.
function projectOnDisk(t, files, buckets = {}, under = '') {
  const root = path.join(tempDir(t, 'au-live-system-'), under);
  fs.mkdirSync(root, { recursive: true });
  for (const rel of files) {
    if (rel.endsWith('/')) { fs.mkdirSync(path.join(root, rel), { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), 'x');
  }
  const project = liveProject('p', root, { totalBytes: 0, buckets, totalBuilds: 0, firstSeen: 0 });
  const model = { projects: new Map([['p', project]]), systemCache: new Map() };
  return { root, project, model };
}

// Fails the folder reads `refuse` picks, counting them, with an error of `code`.
function refuseReads(t, refuse, code = 'EACCES') {
  const readdir = fs.promises.readdir;
  const seen = { tried: 0 };
  t.mock.method(fs.promises, 'readdir', async (dir, options) => {
    if (!refuse(String(dir))) return readdir.call(fs.promises, dir, options);
    seen.tried++;
    throw Object.assign(new Error(code), { code });
  });
  return seen;
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
    { name: 'small', key: 'small', files: 3, builds: 2 },
    { name: '(root)', key: '(root)', files: 2, builds: 1 },
    { name: 'big', key: 'big', files: 5, builds: 0 },
  ]);
  assert.equal(system.beltDensity, 2);
  assert.equal(system.project.id, 'p');
  assert.equal('planetTotal' in system, false, 'no total when every planet is drawn');
  assert.equal(getSystem(model, 'missing'), null);
});

test('live system view: the biggest eight planets, and of how many; a system is cached for 30 s', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const { root, model } = projectOnDisk(t, [
    ...Array.from({ length: 10 }, (_, index) => `dir${index}/f.js`), 'dir9/g.js', 'dir9/h.js',
  ], { dir8: 1 });
  const first = getSystem(model, 'p');
  assert.equal(first.planets.length, 8);
  assert.equal(first.planetTotal, 10);
  assert.deepEqual(first.planets.slice(0, 2).map((planet) => planet.name), ['dir8', 'dir9'], 'the biggest stay');

  fs.rmSync(path.join(root, 'dir0'), { recursive: true });
  fs.rmSync(path.join(root, 'dir1'), { recursive: true });
  t.mock.timers.tick(29_999);
  assert.equal(getSystem(model, 'p'), first);
  t.mock.timers.tick(1);
  const fresh = getSystem(model, 'p');
  assert.notEqual(fresh, first);
  assert.equal(fresh.planets.some((planet) => planet.name === 'dir0'), false);
  assert.deepEqual([fresh.planets.length, 'planetTotal' in fresh], [8, false]);
});

test('live system view: a planet reads its folder five levels down; the root planet counts top-level files only', async (t) => {
  const { model } = projectOnDisk(t, [
    'src/a.js', 'src/b.ts', 'src/lib/c.js', 'src/lib/deeper/d.js', 'src/lib/deeper/deepest/e.js',
    'src/node_modules/x.js', 'README.md', 'NOTES.md', 'package.json',
  ], { src: 4 });

  const src = await getPlanet(model, 'p', 'src');
  assert.deepEqual([src.files, src.subdirs, src.builds, src.resources, src.folderRead], [5, 1, 4, ['JS', 'TS'], 'full']);
  const rootPlanet = await getPlanet(model, 'p', '(root)');
  assert.deepEqual([rootPlanet.files, rootPlanet.subdirs, rootPlanet.resources, rootPlanet.folderRead],
    [3, 1, ['MD', 'JSON'], 'full']);
  assert.equal(await getPlanet(model, 'p', 'src/lib'), null);
  assert.equal(await getPlanet(model, 'missing', 'src'), null);
});

test('live system view: past five levels, 300 folders or 600 files the read stops short and says so', async (t) => {
  const { model } = projectOnDisk(t, [
    'pkg/main/java/com/acme/App.java', 'pkg/main/java/com/acme/app/Service.java',
    ...Array.from({ length: 301 }, (_, index) => `wide/d${index}/f.txt`),
    ...Array.from({ length: 601 }, (_, index) => `many/f${index}.txt`),
  ]);
  const pkg = await getPlanet(model, 'p', 'pkg');
  assert.deepEqual([pkg.files, pkg.folderRead], [1, 'partial'], 'the fifth level counts; the folder below it is not read');
  const wide = await getPlanet(model, 'p', 'wide');
  assert.deepEqual([wide.files, wide.subdirs, wide.folderRead], [299, 301, 'partial'], 'every subfolder counts; 300 are read');
  const many = await getPlanet(model, 'p', 'many');
  assert.deepEqual([many.files, many.folderRead], [600, 'partial']);
});

test('live system view: a folder left unread makes the counts floors only when it holds a file', async (t) => {
  const { root, model } = projectOnDisk(t, [
    'empty/a.js', 'empty/l1/l2/l3/l4/l5/',
    'hollow/a.js', 'hollow/l1/l2/l3/l4/l5/x/y/', 'hollow/l1/l2/l3/l4/l5/z/',
    'ignored/a.js', 'ignored/l1/l2/l3/l4/l5/node_modules/pkg/index.js', 'ignored/l1/l2/l3/l4/l5/.cache/blob',
    'nested/a.js', 'nested/l1/l2/l3/l4/l5/x/y/deep.txt',
    'locked/a.js', 'locked/l1/l2/l3/l4/l5/',
    ...Array.from({ length: 301 }, (_, index) => `wide/d${index}/`),
  ]);
  const read = async (name) => {
    const planet = await getPlanet(model, 'p', name);
    return [planet.files, planet.folderRead];
  };
  assert.deepEqual(await read('empty'), [1, 'full'], 'an empty folder below the fifth level hides nothing');
  assert.deepEqual(await read('hollow'), [1, 'full'], 'nor do the empty folders inside one');
  assert.deepEqual(await read('ignored'), [1, 'full'], 'nor folders the read skips anyway');
  assert.deepEqual(await read('nested'), [1, 'partial'], 'a file further down is one the read did not count');
  assert.deepEqual(await read('wide'), [0, 'full'], 'empty folders past the 300th hide nothing');

  const seen = refuseReads(t, (dir) => dir === path.join(root, 'locked', 'l1', 'l2', 'l3', 'l4', 'l5'));
  assert.deepEqual([...await read('locked'), seen.tried], [1, 'partial', 1], 'a folder that cannot be looked into may hold files');
});

test('live system view: at most 100 folders left unread are looked into', async (t) => {
  const empties = (name, count) => Array.from({ length: count }, (_, index) => `${name}/d${index}/`);
  // The planet's own folder and 299 below it are read, which leaves 100 and 101 to look into.
  const { model } = projectOnDisk(t, [...empties('within', 399), ...empties('past', 400)]);
  const within = await getPlanet(model, 'p', 'within');
  assert.deepEqual([within.subdirs, within.folderRead], [399, 'full']);
  const past = await getPlanet(model, 'p', 'past');
  assert.deepEqual([past.subdirs, past.folderRead], [400, 'partial'], 'the 101st is not looked into, so it may hold files');
});

test('live system view: a folder it cannot read counts toward the 300', async (t) => {
  const { root, model } = projectOnDisk(t, Array.from({ length: 400 }, (_, index) => `locked/d${index}/f.txt`));
  const locked = path.join(root, 'locked');
  const seen = refuseReads(t, (dir) => path.dirname(dir) === locked);
  const planet = await getPlanet(model, 'p', 'locked');
  assert.deepEqual([planet.files, planet.subdirs, planet.folderRead, seen.tried], [0, 400, 'partial', 299],
    'its own folder and 299 failed reads make 300; the other 101 are not tried');
});

test('live system view: a file whose size cannot be read leaves the size a floor', async (t) => {
  const { root, model } = projectOnDisk(t, ['src/a.js', 'src/b.js']);
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'x'.repeat(4096));
  const whole = await getPlanet(model, 'p', 'src');
  assert.deepEqual([whole.files, whole.sizeKb, whole.folderRead], [2, 4, 'full']);

  const stat = fs.promises.stat;
  t.mock.method(fs.promises, 'stat', async (file, options) => {
    if (path.basename(String(file)) === 'a.js') throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    return stat.call(fs.promises, file, options);
  });
  const short = await getPlanet(model, 'p', 'src');
  assert.deepEqual([short.files, short.sizeKb, short.folderRead], [2, 0, 'partial'], 'both files count; one size is missing');
});

test('live system view: a planet whose folder is gone says so; one that is there and unreadable read none', async (t) => {
  const { root, project, model } = projectOnDisk(t, ['src/a.js', 'README.md'], { gone: 3, src: 1 });
  const gone = await getPlanet(model, 'p', 'gone');
  assert.deepEqual([gone.files, gone.builds, gone.folderRead], [0, 3, 'gone'], 'a build bucket whose folder was deleted');
  assert.equal('procedural' in gone, false);

  for (const code of ['EACCES', 'EMFILE']) {
    const seen = refuseReads(t, (dir) => dir === path.join(root, 'src'), code);
    const src = await getPlanet(model, 'p', 'src');
    assert.deepEqual([src.files, src.builds, src.folderRead, seen.tried], [0, 1, 'none', 1], code);
    t.mock.restoreAll();
  }
  refuseReads(t, (dir) => dir === path.join(root, 'src'), 'ENOTDIR');
  assert.equal((await getPlanet(model, 'p', 'src')).folderRead, 'gone', 'a file where the folder was');
  t.mock.restoreAll();

  project.exists = false;
  const planet = await getPlanet(model, 'p', 'src');
  assert.equal(planet.procedural, true);
  assert.equal('folderRead' in planet, false);
});

test('live system view: a stand-in planet is one without a folder or builds, whatever it is called', async (t) => {
  const { project, model } = projectOnDisk(t, ['README.md', 'Sector-9/a.js'], { 'Sector-7': 2 });
  const standIn = await getPlanet(model, 'p', 'Sector-1');
  assert.deepEqual([standIn.procedural, standIn.builds, 'folderRead' in standIn], [true, 0, false]);
  assert.deepEqual(await getPlanet(model, 'p', 'Sector-1'), standIn, 'the same numbers each time');

  const real = await getPlanet(model, 'p', 'Sector-9');
  assert.deepEqual([real.files, real.folderRead, 'procedural' in real], [1, 'full', false], 'a real folder of that name is read');
  const built = await getPlanet(model, 'p', 'Sector-7');
  assert.deepEqual([built.builds, built.folderRead, 'procedural' in built], [2, 'gone', false], 'builds make it a folder that is gone');
  assert.equal(await getPlanet(model, 'p', 'Sector-1/..'), null);

  project.exists = false;
  assert.equal((await getPlanet(model, 'p', 'Sector-9')).procedural, true);
});

test('live system view: under a Windows path a planet answers to any casing, by the name on disk', async (t) => {
  const { model } = projectOnDisk(t, ['Docs/a.md', 'Docs/b.md', 'src/a.js'], { docs: 3, Gone: 2 }, 'case\\root');
  // One key for the folder, in the system and in the planet, whatever casing asked for it.
  assert.deepEqual(getSystem(model, 'p').planets.map((planet) => [planet.name, planet.key, planet.builds]),
    [['Docs', 'docs', 3], ['src', 'src', 0]]);
  for (const asked of ['Docs', 'docs', 'DOCS']) {
    const planet = await getPlanet(model, 'p', asked);
    assert.deepEqual([planet.name, planet.key, planet.files, planet.builds, planet.folderRead], ['Docs', 'docs', 2, 3, 'full'], asked);
  }
  const gone = await getPlanet(model, 'p', 'GONE');
  assert.deepEqual([gone.name, gone.key, gone.builds, gone.folderRead], ['Gone', 'gone', 2, 'gone'],
    'a folder that is gone answers to its bucket key');
  const neither = await getPlanet(model, 'p', 'Nowhere');
  assert.deepEqual([neither.name, neither.key, neither.builds, neither.folderRead], ['Nowhere', 'nowhere', 0, 'gone']);
});

test('live system view: under a POSIX path a planet keeps the name it was asked for', async (t) => {
  const { model } = projectOnDisk(t, ['Docs/a.md'], { Docs: 1 });
  if (path.sep === '\\') return t.skip('a temp folder on Windows has a Windows path');
  assert.deepEqual([(await getPlanet(model, 'p', 'Docs')).name, getSystem(model, 'p').planets[0].key], ['Docs', 'Docs']);
  const other = await getPlanet(model, 'p', 'docs');
  assert.deepEqual([other.name, other.key, other.builds], ['docs', 'docs', 0]);
});

test('live system view: a planet name is one plain path segment', () => {
  for (const ok of ['src', 'Docs', '(root)', '.config', 'a'.repeat(255)]) assert.equal(isPlanetSegment(ok), true, ok);
  for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a\0b', 'a'.repeat(256), null, 7]) {
    assert.equal(isPlanetSegment(bad), false, String(bad));
  }
  assert.equal(IGNORE_DIRS.has('node_modules'), true);
});

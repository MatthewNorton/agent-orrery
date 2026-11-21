'use strict';

// src/main/live/system-view.js: the planets a system lists from its project folder, and the names a planet answers to;
// with src/main/history/model.js, the builds a planet card answers with in both models.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getSystem, getPlanet, planetFolders } = require('../src/main/live/system-view');
const { linkTo, outsideFolder, projectOnDisk, refuseReads, spyReaddir } = require('./support/system-view');
const { SEC, SLUG, T0, claude, ofType } = require('./support/transcripts');
const { runBoth } = require('./support/both-models');

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

test('live system view: the root planet\'s builds are the top-level files\' own bucket, a whole count', (t) => {
  // A count held past the rule (shared/values.js) is made whole on the way out, and one that is none starts no planet.
  const builds = (root) => getSystem(projectOnDisk(t, ['src/a.js', 'README.md'], { '(root)': root, src: 2 }).model, 'p').planets.map((planet) => [planet.name, planet.builds]);
  assert.deepEqual(builds(2.9), [['src', 2], ['(root)', 2]]);
  assert.deepEqual(builds('3'), [['src', 2]]);
});

test('live system view: a folder whose name a Windows path folds to (root) draws no root planet', (t) => {
  if (path.sep !== '\\') return t.skip('a temp folder has a Windows path on Windows only');
  const { root, model } = projectOnDisk(t, ['(Root)/a.js', 'src/b.js', 'README.md'], { '(Root)': 3 });
  const planets = () => getSystem(model, 'p').planets.map((planet) => [planet.name, planet.builds]);
  assert.deepEqual(planets(), [['(Root)', 3], ['src', 0]]);
  // Nor once the folder is gone.
  fs.rmSync(path.join(root, '(Root)'), { recursive: true });
  model.systemCache.clear();
  assert.deepEqual(planets(), [['src', 0]]);
});

test('both models answer a planet card with as many builds as were sent with its key, (root) beside a folder (Root) too', async (t) => {
  // A Windows-style root on every host, where the folder (Root) and the top-level files' (root) share a key.
  const { live, replay } = await runBoth(t, {
    cwd: 'C:\\Orrery-Fixture-Missing\\Demo',
    records: (dir) => [claude.prompt(dir, T0),
      ...[1, 2].map((n) => claude.tool(dir, T0 + n * SEC, `toolu_${n}`, 'Write', { file_path: `${dir}\\(Root)\\${n}.md` }))],
  });
  const cards = [[live, (name) => live.tracker.getPlanet(SLUG, name)], [replay, (name) => replay.source.getPlanet(SLUG, name)]];
  for (const [side, card] of cards) {
    const builds = ofType(side.events, 'build');
    assert.equal(builds.length, 2);
    for (const name of ['(root)', '(Root)']) {
      const planet = await card(name);
      assert.equal(planet.builds, builds.filter((event) => event.key === planet.key).length, name);
    }
  }
  // The history system draws the folder alone too.
  assert.deepEqual(replay.source.getSystem(SLUG).planets.map((planet) => planet.name), ['(Root)']);
});

test('live system view: the system view and the planet card take a link as the one file it is, by one rule', async (t) => {
  const { root, model } = projectOnDisk(t, ['src/a.js', 'README.md'], { src: 1, '(root)': 1 });
  const outside = outsideFolder(t, ['one.txt']);
  linkTo(outside, path.join(root, 'linked'));
  linkTo(outside, path.join(root, 'src', 'out'));
  const system = getSystem(model, 'p');
  const drawn = Object.fromEntries(system.planets.map((planet) => [planet.name, planet.files]));
  const cards = { src: (await getPlanet(model, 'p', 'src')).files, '(root)': (await getPlanet(model, 'p', '(root)')).files };
  assert.deepEqual([drawn, system.beltDensity], [cards, cards['(root)']]);
  assert.deepEqual(cards, { src: 2, '(root)': 2 });
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

test('live system view: a stand-in planet stays one when the project folder cannot be listed', async (t) => {
  const { root, model } = projectOnDisk(t, ['src/a.js', 'Sector-9/a.js'], { 'Sector-7': 2, src: 1 });
  // macOS without the Files and Folders permission: the folder is there and no read of it is allowed.
  for (const code of ['EPERM', 'EACCES', 'EIO']) {
    refuseReads(t, (dir) => dir.startsWith(root), code);
    assert.deepEqual(getSystem({ ...model, systemCache: new Map() }, 'p').planets.map((planet) => planet.name).slice(0, 1), ['src'],
      'the system is listed by readdirSync, which is not refused here');
    const standIn = await getPlanet(model, 'p', 'Sector-1');
    assert.deepEqual([standIn.procedural, standIn.builds, 'folderRead' in standIn], [true, 0, false], code);
    const built = await getPlanet(model, 'p', 'Sector-7');
    assert.deepEqual([built.builds, built.folderRead, 'procedural' in built], [2, 'none', false], code + ': builds make it a folder');
    const src = await getPlanet(model, 'p', 'src');
    assert.deepEqual([src.folderRead, 'procedural' in src], ['none', false], code + ': another name is a folder that could not be read');
    t.mock.restoreAll();
  }
  // The project folder lists, and the planet's own folder does not: a real folder, unread.
  refuseReads(t, (dir) => dir === path.join(root, 'Sector-9'), 'EPERM');
  const real = await getPlanet(model, 'p', 'Sector-9');
  assert.deepEqual([real.folderRead, 'procedural' in real], ['none', false]);
});

test('live system view: a name that is no plain segment has no planet, whatever folder the project has or gets', async (t) => {
  const { root, project, model } = projectOnDisk(t, ['src/a.js', 'src/deep/b.js'], { src: 1 });
  const dirs = spyReaddir(t);
  const unsafe = ['..', 'src/deep', 'src\\deep', '.', '', 'a\0b'];
  for (const name of unsafe) assert.equal(await getPlanet(model, 'p', name), null, `with a folder: ${JSON.stringify(name)}`);
  // With no folder a planet is a stand-in: the name is checked all the same, before anything is read.
  for (const lost of [{ exists: false }, { path: null }]) {
    Object.assign(project, { path: root, exists: true }, lost);
    for (const name of unsafe) assert.equal(await getPlanet(model, 'p', name), null, `${JSON.stringify(lost)}: ${JSON.stringify(name)}`);
    assert.equal((await getPlanet(model, 'p', 'Sector-1')).procedural, true);
  }
  // A project that has no folder when it is first asked and has one when it is asked again.
  let asked = 0;
  Object.defineProperty(project, 'exists', { get: () => asked++ > 0, configurable: true });
  Object.assign(project, { path: root });
  for (const name of unsafe) {
    asked = 0;
    assert.equal(await getPlanet(model, 'p', name), null, `a folder gained meanwhile: ${JSON.stringify(name)}`);
  }
  assert.deepEqual(dirs, [], 'and no folder was read for any of them');
  asked = 0;
  assert.deepEqual([(await getPlanet(model, 'p', 'src')).files, dirs.length > 0], [2, true], 'a plain name is read in the folder gained');
});

test('live system view: under a Windows path a planet answers to any casing, by the name on disk', async (t) => {
  if (path.sep !== '\\') return t.skip('a temp folder has a Windows path on Windows only');
  const { model } = projectOnDisk(t, ['Docs/a.md', 'Docs/b.md', 'src/a.js'], { docs: 3, Gone: 2 });
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

test('live system view: one definition of a planet folder; the system draws those not ignored, a planet reads any', async (t) => {
  const { root, model } = projectOnDisk(t, ['.github/workflows/ci.yml', '.github/a.md', 'node_modules/pkg/index.js', 'src/a.js', 'notes', 'README.md'],
    { '.github': 2, node_modules: 1, linked: 1, notes: 1 });
  // One listing: a dot folder, an ignored folder, a folder that is drawn, a file, and a link (an entry typed as one; none is made on disk).
  const link = { name: 'linked', isDirectory: () => false, isSymbolicLink: () => true, isFile: () => false };
  const listed = (list) => [.../** @type {any[]} */ (list), link];
  const entries = listed(fs.readdirSync(root, { withFileTypes: true }));
  const readdirSync = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (dir, options) => (dir === root ? listed(readdirSync(dir, options)) : readdirSync(dir, options)));
  spyReaddir(t, { entries: (list, options) => (options && list.some((entry) => entry.name === 'README.md') ? listed(list) : list) });

  const folders = planetFolders(entries, root);
  assert.deepEqual(folders.all.map((entry) => entry.name).sort(), ['.github', 'node_modules', 'src']);
  const named = (name, from = folders) => { const { folder, ...rest } = from.named(name); return { ...rest, folder: folder && folder.name }; };
  assert.deepEqual(['.github', 'linked', 'notes', 'absent'].map((name) => named(name)), [
    { name: '.github', folder: '.github', missing: null, standIn: false }, { name: 'linked', folder: null, missing: 'none', standIn: false },
    { name: 'notes', folder: null, missing: 'gone', standIn: false }, { name: null, folder: null, missing: 'gone', standIn: false },
  ]);
  // The stand-in rule: a stand-in's name with no listing to look in, or with nothing there to say otherwise.
  assert.deepEqual([named('Sector-1').standIn, named('Sector-1', planetFolders(null, root)).standIn, named('src', planetFolders(null, root)).standIn, planetFolders(null, root).all],
    [true, true, false, []]);

  // The system draws the planet folders that are not ignored; each of them is one a planet reads.
  assert.deepEqual(getSystem(model, 'p').planets.map((planet) => planet.name), ['src']);
  // A planet reads any planet folder: one with builds that is not drawn opens and is counted (Go to lists it).
  const read = async (name) => { const planet = await getPlanet(model, 'p', name); return [planet.name, planet.files, planet.builds, planet.folderRead, 'procedural' in planet]; };
  assert.deepEqual([await read('src'), await read('.github'), await read('node_modules')],
    [['src', 1, 0, 'full', false], ['.github', 2, 2, 'full', false], ['node_modules', 1, 1, 'full', false]]);
  assert.deepEqual([await read('linked'), await read('notes')], [['linked', 0, 1, 'none', false], ['notes', 0, 1, 'gone', false]]);
});

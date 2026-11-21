'use strict';

// src/main/live/system-view.js: what a planet's folder read counts, where it stops, and what it never opens.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getSystem, getPlanet } = require('../src/main/live/system-view');
const { countBuild } = require('../src/main/build-buckets');
const { linkTo, outsideFolder, projectOnDisk, refuseReads, spyReaddir } = require('./support/system-view');
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

  const lstat = fs.promises.lstat;
  t.mock.method(fs.promises, 'lstat', async (file, options) => {
    if (path.basename(String(file)) === 'a.js') throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    return lstat.call(fs.promises, file, options);
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
  // The listing decides: a folder it had that is gone by the time it is read is a folder that is gone, not a stand-in.
  refuseReads(t, (dir) => dir.endsWith('Sector-9'), 'ENOENT');
  const vanished = await getPlanet(model, 'p', 'Sector-9');
  assert.deepEqual([vanished.files, vanished.folderRead, 'procedural' in vanished], [0, 'gone', false]);
  t.mock.restoreAll();

  project.exists = false;
  assert.equal((await getPlanet(model, 'p', 'Sector-9')).procedural, true);
});

test('live system view: builds counted while a planet\'s folder is read are in the answer', async (t) => {
  const { root, project, model } = projectOnDisk(t, ['src/a.js', 'README.md'], { src: 1 });
  let during = () => {};
  spyReaddir(t, { before: (dir, options) => { if (dir === path.join(root, 'src') || (dir === root && options)) during(); } });
  during = () => { countBuild(project, 'src'); project.totalBuilds += 1; during = () => {}; };
  const planet = await getPlanet(model, 'p', 'src');
  assert.deepEqual([planet.builds, planet.project.totalBuilds, planet.files], [2, 1, 1], 'the build that came during the read counts');
  during = () => { countBuild(project, '(root)'); during = () => {}; };
  assert.equal((await getPlanet(model, 'p', '(root)')).builds, 1, 'and on the root planet');
  // A stand-in name that gains its first build during the read is a folder with builds, not a stand-in.
  during = () => { countBuild(project, 'Sector-3'); during = () => {}; };
  const formed = await getPlanet(model, 'p', 'Sector-3');
  assert.deepEqual([formed.builds, formed.folderRead, 'procedural' in formed], [1, 'gone', false]);
  t.mock.restoreAll();

  // A project forgotten during the read has no planet to answer with.
  spyReaddir(t, { before: () => model.projects.delete('p') });
  assert.equal(await getPlanet(model, 'p', 'src'), null);
});

test('live system view: a planet read never goes into a link', async (t) => {
  const { root, model } = projectOnDisk(t, ['src/a.js', 'README.md'], { linked: 1, src: 1 });
  const outside = outsideFolder(t, ['one.txt', 'two.txt', path.join('deep', 'three.txt')]);
  // A top-level link, with a build bucket of its name (one edit under it makes one).
  linkTo(outside, path.join(root, 'linked'));
  for (let reads = 0; reads < 2; reads++) {
    const seen = refuseReads(t, () => false);
    const linked = await getPlanet(model, 'p', 'linked');
    assert.deepEqual([linked.files, linked.sizeKb, linked.subdirs, linked.resources, linked.folderRead, linked.builds],
      [0, 0, 0, [], 'none', 1], 'nothing behind the link is listed');
    assert.deepEqual(seen.dirs, [root], 'the project folder is listed, and nothing else');
    linked.resources.push('MINE'); // the answer is its caller's own: nothing done to one shows in the next
    t.mock.restoreAll();
  }
  assert.equal(getSystem(model, 'p').planets.some((planet) => planet.name === 'linked'), false, 'the system lists folders, not links');

  // A link inside a planet's folder counts as the one file it is; its target is not opened.
  linkTo(outside, path.join(root, 'src', 'out'));
  t.mock.method(fs.promises, 'stat', async () => assert.fail('stat follows a link'));
  const inside = refuseReads(t, () => false);
  const src = await getPlanet(model, 'p', 'src');
  assert.deepEqual([src.files, src.subdirs, src.sizeKb, src.folderRead], [2, 0, 0, 'full']);
  assert.equal(inside.dirs.some((dir) => dir.startsWith(outside) || dir.endsWith('out')), false, inside.dirs.join(' | '));
  // The root planet counts the top-level link as a file too, and reads no folder below.
  const top = await getPlanet(model, 'p', '(root)');
  assert.deepEqual([top.files, top.subdirs, top.folderRead], [2, 1, 'full']);
});

test('live system view: a planet is what the project folder\'s listing calls a folder, whatever lstat would say', async (t) => {
  const { root, model } = projectOnDisk(t, ['vol/a.js', 'vol/deep/b.js', 'src/a.js', 'src/mount/b.js', 'src/deep/mount/c.js', 'notes'], { vol: 2, src: 1, notes: 1 });
  // Windows lists a junction to a volume as a link, and lstat calls it a folder: the listing decides.
  const asLink = (entry) => Object.assign(Object.create(entry), { isDirectory: () => false, isSymbolicLink: () => true, isFile: () => false });
  const dirs = spyReaddir(t, { entries: (list, options) => (options
    ? list.map((entry) => (entry.name === 'vol' || entry.name === 'mount' ? asLink(entry) : entry)) : list) });
  t.mock.method(fs.promises, 'lstat', async (file) => (/vol$|mount$/.test(String(file))
    ? { size: 0, isSymbolicLink: () => false, isDirectory: () => true } : fs.lstatSync(file)));
  const vol = await getPlanet(model, 'p', 'vol');
  assert.deepEqual([vol.name, vol.files, vol.subdirs, vol.resources, vol.folderRead, vol.builds], ['vol', 0, 0, [], 'none', 2]);
  assert.deepEqual(dirs.splice(0), [root], 'one listing of the project folder, and the planet is not opened');
  // At every level below the same holds: its parent's listing types it, and it counts as the one
  // file a link is (src/mount, src/deep/mount) and is never walked.
  const src = await getPlanet(model, 'p', 'src');
  assert.deepEqual([src.files, src.subdirs, src.folderRead], [3, 1, 'full']);
  assert.deepEqual(dirs.splice(0), [root, path.join(root, 'src'), path.join(root, 'src', 'deep')]);
  // A file of the planet's name is no folder; a name the listing lacks is one that is gone.
  assert.deepEqual([(await getPlanet(model, 'p', 'notes')).folderRead, (await getPlanet(model, 'p', 'lib')).folderRead], ['gone', 'gone']);
  assert.deepEqual(dirs, [root, root], 'neither is opened');
});

test('live system view: a project reached through a link is read like any other', async (t) => {
  const { root, project, model } = projectOnDisk(t, ['real/src/a.js', 'real/src/deep/b.js', 'real/README.md'], { src: 1 });
  // The folder the project is known by is a link to where it really is (a workspace on another drive).
  project.path = path.join(root, 'alias');
  linkTo(path.join(root, 'real'), project.path);
  const src = await getPlanet(model, 'p', 'src');
  assert.deepEqual([src.files, src.subdirs, src.folderRead, src.builds], [2, 1, 'full', 1]);
  const top = await getPlanet(model, 'p', '(root)');
  assert.deepEqual([top.files, top.subdirs, top.folderRead], [1, 1, 'full']);
});

test('live system view: a project folder that changes during the read is read once more; one that changes again has no answer', async (t) => {
  const { root, project, model } = projectOnDisk(t, ['a/src/x.js', 'b/src/x.js', 'b/src/y.js'], { src: 3 });
  const sides = [path.join(root, 'a'), path.join(root, 'b')];
  let reads = 0, moves = 0;
  // A read of the planet's folder finds the project at the other folder, `moves` times over.
  spyReaddir(t, { before: (dir) => { if (path.basename(dir) === 'src' && reads++ < moves) project.path = sides[reads % 2]; } });
  const read = (times) => { [project.path, reads, moves] = [sides[0], 0, times]; return getPlanet(model, 'p', 'src'); };
  const once = await read(1);
  assert.deepEqual([reads, once.files, once.folderRead, once.builds], [2, 2, 'full', 3], 'what the second folder holds');
  assert.deepEqual([await read(2), reads], [null, 2], 'the counts and the project never come from two folders');
  assert.deepEqual([await read(20), reads], [null, 2], 'and it is not read a third time');
  // A folder that went away during the read leaves stand-ins only.
  t.mock.restoreAll();
  spyReaddir(t, { before: () => { project.exists = false; } });
  project.path = sides[0];
  assert.equal((await getPlanet(model, 'p', 'src')).procedural, true);
});

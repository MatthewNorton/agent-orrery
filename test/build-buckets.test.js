'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_BUCKETS, addBuckets, bucketOf, bucketKey, bucketFor, countBuild, bucketBuilds, foldBuckets, isBucketName, matchingEntry, mergeBuckets, planetKey,
  setBucket, setProjectPath,
} = require('../src/main/build-buckets');
const { readCounts, own, KEPT_APART, KEPT_AS_ONE, KEPT_LARGER } = require('./support/bucket-cases');
const { SEC, T0, ofType, claude } = require('./support/transcripts');
const { runBoth } = require('./support/both-models');

// The name matchingEntry finds among names, as it finds a folder among a listing's entries.
const matchingName = (names, name, root) => matchingEntry(names.map((each) => ({ name: each })), name, root)?.name ?? null;

test('bucketOf names the top-level folder, or (root) for a file at the top level', () => {
  assert.equal(bucketOf('Docs/Guide.md', '/'), 'Docs');
  assert.equal(bucketOf('Src\\Deep\\A.js', '\\'), 'Src');
  assert.equal(bucketOf('README.md', '/'), '(root)');
});

test('a bucket is named as a planet is, with no control character: a build elsewhere starts none', () => {
  const project = { path: '/work/demo', buckets: {} };
  // Each of these is a folder some disk can hold, or what bucketOf makes of a path: its build counts in the totals only.
  for (const name of ['', '.', '..', 'a/b', 'a\\b', 'nul\0', 'tab\tname', 'esc\u001bdir', 'del\u007fdir', 'c1\u0085dir', 'x'.repeat(256)]) {
    assert.equal(countBuild(project, name), false, JSON.stringify(name));
  }
  assert.deepEqual(own(project.buckets), []);
  for (const name of ['(root)', 'src', '.github', 'with space', '__proto__', 'x'.repeat(255)]) assert.equal(isBucketName(name), true, name);
  // A merge starts no bucket that countBuild would not.
  addBuckets(project, { 'a/b': 2, 'tab\tname': 4, src: 3 }, Math.max);
  assert.deepEqual(own(project.buckets), [['src', 3]]);
});

test('a project keeps MAX_BUCKETS buckets at most: past them a new folder starts none, and one that has a bucket still counts', () => {
  const project = { path: 'C:\\Work\\Demo', buckets: {} };
  for (let index = 0; index < MAX_BUCKETS; index++) countBuild(project, `f${index}`);
  assert.deepEqual([countBuild(project, 'one-more'), countBuild(project, 'F0')], [false, false]);
  assert.deepEqual([Object.keys(project.buckets).length, project.buckets.f0, Object.hasOwn(project.buckets, 'one-more')], [MAX_BUCKETS, 2, false]);
  // A merge stops there too, so the state file it is saved to reads back whole (live/saved-project.js).
  const merged = { path: project.path, buckets: { ...project.buckets } };
  addBuckets(merged, { another: 1, f1: 5 }, Math.max);
  assert.deepEqual([Object.keys(merged.buckets).length, merged.buckets.f1, Object.hasOwn(merged.buckets, 'another')], [MAX_BUCKETS, 5, false]);
});

test('both models count a build whose folder can be no bucket in the totals only', async (t) => {
  const { live, replay } = await runBoth(t, {
    cwd: '/Orrery-Fixture-Missing/Demo',
    records: (dir) => [
      claude.prompt(dir, T0),
      claude.tool(dir, T0 + 2 * SEC, 'toolu_del', 'Write', { file_path: `${dir}/del\u007fdir/a.js` }),
      claude.tool(dir, T0 + 3 * SEC, 'toolu_src', 'Write', { file_path: `${dir}/src/a.js` }),
    ],
  });
  for (const side of [live, replay]) {
    assert.deepEqual(ofType(side.events, 'build').map((event) => [event.bucket, event.isNew]), [['del\u007fdir', false], ['src', true]]);
    assert.deepEqual([side.snapshot.projects[0].totalBuilds, side.snapshot.projects[0].planets, side.snapshot.ships[0].builds], [2, ['src'], 2]);
    assert.deepEqual(ofType(side.events, 'feed').map((event) => event.entry.text).filter((text) => text.startsWith('Planet formation')),
      ['Planet formation started: src in Demo']);
  }
});

test('under a Windows-style root a folder keeps one bucket across casings, under the first key', () => {
  const project = { path: 'C:\\Work\\Demo', buckets: { docs: 2 } };
  assert.deepEqual(['Docs', 'DOCS', 'Src', 'src'].map((bucket) => countBuild(project, bucket)),
    [false, false, true, false]);
  assert.deepEqual(project.buckets, { docs: 4, Src: 2 });
  assert.deepEqual(['Docs', 'docs', 'SRC', 'lib'].map((name) => bucketKey(project, name)), ['docs', 'docs', 'Src', null]);
  assert.deepEqual(['Docs', 'SRC', 'lib'].map((name) => bucketBuilds(project, name)), [4, 2, 0]);
});

test('under a POSIX root bucket names stay case-sensitive', () => {
  const project = { path: '/work/demo', buckets: { docs: 2 } };
  assert.equal(countBuild(project, 'Docs'), true);
  assert.deepEqual(project.buckets, { docs: 2, Docs: 1 });
  assert.deepEqual(['docs', 'Docs', 'DOCS'].map((name) => bucketBuilds(project, name)), [2, 1, 0]);
});

test('planetKey is one key for every casing main counts as the folder, and the name itself elsewhere', () => {
  const windows = { path: 'C:\\Work\\Demo' }, posix = { path: '/work/demo' };
  assert.deepEqual(['Docs', 'docs', 'DOCS', '(root)'].map((name) => planetKey(windows, name)), ['docs', 'docs', 'docs', '(root)']);
  assert.deepEqual(['Docs', 'docs', '(root)'].map((name) => planetKey(posix, name)), ['Docs', 'docs', '(root)']);
  assert.equal(planetKey({ path: null }, 'Docs'), 'Docs', 'a project without a path folds nothing');
  // The key and the bucket lookup are one rule: two names share a bucket exactly when they share a key.
  for (const project of [windows, posix, { path: 'relative\\dir' }, { path: null }]) {
    for (const [saved, asked] of [['Docs', 'docs'], ['docs', 'DOCS'], ['Docs', 'Docs'], ['src', 'Src2'], ['(root)', '(root)']]) {
      const shared = bucketKey({ ...project, buckets: { [saved]: 1 } }, asked) !== null;
      assert.equal(planetKey(project, saved) === planetKey(project, asked), shared, `${project.path}: ${saved} / ${asked}`);
    }
  }
});

test('matchingEntry finds a folder among names: itself first, another casing only where the root ignores case', () => {
  const names = ['docs', 'Docs2', 'src'];
  assert.equal(matchingName(names, 'docs', 'C:\\Work'), 'docs');
  assert.equal(matchingName(names, 'DOCS', 'C:\\Work'), 'docs');
  assert.equal(matchingName(['Docs', 'docs'], 'docs', 'C:\\Work'), 'docs', 'the exact name wins over another casing');
  assert.equal(matchingName(names, 'DOCS', '/work'), null);
  assert.equal(matchingName(names, 'src', '/work'), 'src');
  assert.equal(matchingName(names, 'lib', 'C:\\Work'), null);
  assert.equal(matchingName([], 'lib', null), null);
  assert.equal(matchingName(['DOCS', 'Docs', 'docs2'], 'docs', 'C:\\Work'), 'DOCS', 'of two other casings, the first');
  const entries = [{ name: 'Docs', kind: 'folder' }, { name: 'docs', kind: 'file' }];
  assert.equal(matchingEntry(entries, 'docs', 'C:\\Work'), entries[1], 'the entry itself is answered');
});

test('bucketFor answers a folder\'s key, builds and the name it goes by, in one lookup', () => {
  const project = { path: 'C:\\Work\\Demo', buckets: { docs: 2 } };
  assert.deepEqual(bucketFor(project, 'Docs'), { key: 'docs', name: 'docs', builds: 2 });
  assert.deepEqual(bucketFor(project, 'Lib'), { key: null, name: 'Lib', builds: 0 }, 'no bucket: the name as asked');
  assert.deepEqual(bucketFor(project, 'constructor'), { key: null, name: 'constructor', builds: 0 });
});

test('a folder named __proto__ is a bucket like any other, and stays one through the state file', () => {
  for (const root of ['/work/demo', 'C:\\Work\\Demo']) {
    const project = { path: root, buckets: {} };
    assert.deepEqual([1, 2, 3].map(() => countBuild(project, '__proto__')), [true, false, false], root);
    assert.deepEqual([Object.hasOwn(project.buckets, '__proto__'), bucketBuilds(project, '__proto__'), Object.keys(project.buckets)],
      [true, 3, ['__proto__']]);
    assert.equal(Object.getPrototypeOf(project.buckets), Object.prototype, 'the object keeps its prototype');
    // The state file is JSON: the key and its count come back, and counting goes on from them.
    const loaded = { path: root, buckets: JSON.parse(JSON.stringify(project.buckets)) };
    assert.deepEqual([countBuild(loaded, '__proto__'), bucketBuilds(loaded, '__proto__')], [false, 4]);
  }
  const others = { path: '/work/demo', buckets: {} };
  assert.deepEqual(['constructor', 'toString', 'constructor'].map((name) => countBuild(others, name)), [true, true, false]);
  assert.deepEqual(others.buckets, { constructor: 2, toString: 1 });
});

test('a miss under a case-sensitive root looks at no other bucket', () => {
  const keys = { asked: 0 };
  const watched = (buckets) => new Proxy(buckets, { ownKeys(target) { keys.asked++; return Reflect.ownKeys(target); } });
  const posix = { path: '/work/demo', buckets: watched({ Docs: 1, src: 2 }) };
  assert.deepEqual([bucketKey(posix, 'docs'), bucketKey(posix, 'Docs'), bucketBuilds(posix, 'lib')], [null, 'Docs', 0]);
  assert.equal(keys.asked, 0, 'no scan of the keys');
  assert.deepEqual([countBuild(posix, 'lib'), countBuild(posix, 'bin'), countBuild(posix, 'lib')], [true, true, false]);
  assert.equal(keys.asked, 1, 'a new folder counts the keys once (MAX_BUCKETS), and the count is kept');
  const windows = { path: 'C:\\Work\\Demo', buckets: watched({ Docs: 1 }) };
  assert.equal(bucketKey(windows, 'docs'), 'Docs');
  assert.equal(keys.asked, 2, 'a root that ignores case looks through them');
});

test('only own keys name a bucket', () => {
  const project = { path: 'C:\\Work\\Demo', buckets: {} };
  for (const name of ['constructor', 'toString', '__proto__']) {
    assert.equal(bucketKey(project, name), null, name);
    assert.equal(bucketBuilds(project, name), 0, name);
  }
  assert.equal(countBuild(project, 'constructor'), true);
  assert.deepEqual(project.buckets, { constructor: 1 });
});

test('a lookup answers as a search through the keys would, whatever was counted before it', () => {
  // The rule the index stands for: the exact key, else the first key in another casing.
  const searched = (project, name) => (Object.hasOwn(project.buckets, name) ? name
    : matchingName(Object.keys(project.buckets), name, project.path));
  const names = ['Docs', 'docs', 'DOCS', 'src', 'Src', '10', '2', 'lib', '__proto__', 'Constructor', 'constructor', '(root)'];
  for (const root of ['C:\\Work\\Demo', '/work/demo', null]) {
    let seed = 7;
    const pick = () => names[(seed = (seed * 1103515245 + 12345) % 2147483648) % names.length];
    // Two casings of one folder may both be there already: a file from a root that told them apart.
    const project = { path: root, buckets: JSON.parse('{ "docs": 2, "Docs": 1, "SRC": 4 }') };
    for (let step = 0; step < 400; step++) {
      const name = pick();
      assert.equal(bucketKey(project, name), searched(project, name), `${root}: ${name} at step ${step}`);
      if (step % 3 === 0) {
        const before = searched(project, name);
        assert.equal(countBuild(project, name), before === null, `${root}: counting ${name} at step ${step}`);
        assert.equal(Object.hasOwn(project.buckets, before ?? name), true);
      }
    }
    assert.equal(names.every((name) => bucketKey(project, name) === searched(project, name)), true, String(root));
  }
});

test('10,000 folders under a root that ignores case are counted and looked up without a search each', () => {
  const project = { path: 'C:\\Work\\Demo', buckets: {} };
  const started = performance.now();
  for (let n = 0; n < 10_000; n++) assert.equal(countBuild(project, 'Folder-' + n), true);
  for (let n = 0; n < 10_000; n++) assert.equal(countBuild(project, 'folder-' + n), false);
  for (let n = 0; n < 10_000; n++) assert.equal(bucketFor(project, 'absent-' + n).key, null);
  const took = performance.now() - started;
  assert.equal(Object.keys(project.buckets).length, 10_000);
  assert.deepEqual(bucketFor(project, 'FOLDER-9999'), { key: 'Folder-9999', name: 'Folder-9999', builds: 2 });
  // A search per miss took about six seconds for the first loop alone.
  assert.ok(took < 1500, `took ${Math.round(took)} ms`);
});

test('what a buckets object knows of its keys stays out of every copy of it', () => {
  const project = { path: 'C:\\Work\\Demo', buckets: { Docs: 1 } };
  assert.equal(bucketKey(project, 'docs'), 'Docs');
  assert.deepEqual([Object.keys(project.buckets), JSON.stringify(project.buckets)], [['Docs'], '{"Docs":1}']);
  const seen = [];
  for (const name in project.buckets) seen.push(name);
  assert.deepEqual([seen, Object.entries(project.buckets)], [['Docs'], [['Docs', 1]]]);
  const copies = {
    spread: { ...project.buckets },
    assigned: Object.assign(Object.create(null), project.buckets),
    json: JSON.parse(JSON.stringify(project.buckets)),
    cloned: structuredClone(project.buckets), // what an IPC message carries
  };
  for (const [how, buckets] of Object.entries(copies)) {
    assert.deepEqual([Reflect.ownKeys(buckets), buckets.Docs], [['Docs'], 1], how);
    // A copy answers for its own keys, and its counts stay its own.
    const copy = { path: project.path, buckets };
    assert.deepEqual([bucketKey(copy, 'DOCS'), countBuild(copy, 'Src'), bucketKey(copy, 'SRC')], ['Docs', true, 'Src'], how);
    assert.equal(bucketKey(project, 'src'), null, how);
  }
  assert.deepEqual([countBuild(project, 'LIB'), bucketKey(project, 'lib'), bucketKey({ ...project, buckets: copies.spread }, 'lib')],
    [true, 'LIB', null]);
});

test('addBuckets puts each count under the key its folder has, by the rule of the root', () => {
  const counts = () => JSON.parse('{ "docs": 7, "SRC": 1, "lib": 2, "LIB": 3, "__proto__": 4 }');
  const windows = { path: 'C:\\Work\\Demo', buckets: { Docs: 5, src: 2 } };
  addBuckets(windows, counts(), Math.max);
  assert.deepEqual(own(windows.buckets), [['Docs', 7], ['src', 2], ['lib', 3], ['__proto__', 4]]);
  for (const root of ['/work/demo', null]) {
    const exact = { path: root, buckets: { Docs: 5, src: 2 } };
    addBuckets(exact, counts(), Math.max);
    assert.deepEqual(own(exact.buckets), [['Docs', 5], ['src', 2], ['docs', 7], ['SRC', 1], ['lib', 2], ['LIB', 3], ['__proto__', 4]]);
  }
  const summed = { path: 'C:\\Work\\Demo', buckets: {} };
  addBuckets(summed, counts(), (held, added) => held + added);
  assert.deepEqual(own(summed.buckets), [['docs', 7], ['SRC', 1], ['lib', 5], ['__proto__', 4]]);
});

test('every bucket count stays a whole count, and no sum passes the largest one kept', () => {
  const MAX = Number.MAX_SAFE_INTEGER;
  // A saved project's counts come whole from its reader (test/live-saved-project.test.js); a fold keeps them so.
  const windows = foldBuckets('C:\\Work\\Demo', readCounts(), true);
  assert.deepEqual(own(windows), KEPT_AS_ONE, 'two full counts joined are one full count');
  assert.deepEqual(own(foldBuckets('/work/demo', readCounts(), true)), KEPT_APART);
  assert.equal(JSON.stringify(windows).includes('null'), false, 'nothing saves as null');
  assert.deepEqual(own(foldBuckets(null, readCounts(), true)), KEPT_APART, 'no path joins no two names');

  const project = { path: 'C:\\Work\\Demo', buckets: windows };
  assert.deepEqual([countBuild(project, 'BIG'), countBuild(project, 'big'), project.buckets.big], [false, false, MAX], 'a full count stays full');
  addBuckets(project, { DOCS: MAX, Src: 1 }, (held, added) => held + added);
  addBuckets(project, { docs: 3, SRC: 9 }, Math.max);
  assert.deepEqual(own(project.buckets), [['Docs', MAX], ['odd', 6], ['src', 9], ['big', MAX], ['__proto__', 3]]);
  // A count put there past the rule (an older state, read by other code) is made whole when it is next added to.
  const odd = { path: '/work/demo', buckets: {} };
  setBucket(odd.buckets, 'src', /** @type {any} */ ('5'));
  setBucket(odd.buckets, 'lib', NaN);
  assert.deepEqual([countBuild(odd, 'src'), countBuild(odd, 'lib'), own(odd.buckets)], [false, false, [['src', 1], ['lib', 1]]]);
});

test('setProjectPath writes the path and counts the buckets by it in one step', () => {
  const project = { path: null, buckets: JSON.parse('{ "Docs": 3, "docs": 2, "__proto__": 4 }'), bucketsCounted: true };
  setProjectPath(project, '/work/demo');
  assert.deepEqual([project.path, own(project.buckets)], ['/work/demo', [['Docs', 3], ['docs', 2], ['__proto__', 4]]]);
  setProjectPath(project, 'C:\\Work\\Demo');
  assert.deepEqual([project.path, own(project.buckets)], ['C:\\Work\\Demo', [['Docs', 5], ['__proto__', 4]]]);
  // The lookup of the new buckets goes by the new path at once: no index of the old ones is left.
  assert.deepEqual([bucketKey(project, 'DOCS'), countBuild(project, 'docs'), project.buckets.Docs], ['Docs', false, 6]);
  setProjectPath(project, null);
  assert.deepEqual([project.path, own(project.buckets), bucketKey(project, 'docs')], [null, [['Docs', 6], ['__proto__', 4]], null]);
});

test('casings counted under a path are added up, never past the project\'s builds; others keep the larger', () => {
  // Under a path each build is in one bucket, so two casings joined by a new path are all its builds.
  const counted = { path: '/work/demo', buckets: { Docs: 3, docs: 3, src: 1 }, bucketsCounted: true, totalBuilds: 7 };
  setProjectPath(counted, 'C:\\Work\\Demo');
  assert.deepEqual(own(counted.buckets), [['Docs', 6], ['src', 1]]);
  // A sum stops at the project's builds, and is never less than the larger casing.
  const over = { path: null, buckets: { Docs: 3, docs: 3 }, bucketsCounted: true, totalBuilds: 4 };
  const short = { path: null, buckets: { docs: 2, Docs: 3 }, bucketsCounted: true, totalBuilds: 1 };
  for (const project of [over, short]) setProjectPath(project, 'C:\\Work\\Demo');
  assert.deepEqual([own(over.buckets), own(short.buckets)], [[['Docs', 4]], [['docs', 3]]]);
  assert.deepEqual(own(foldBuckets('C:\\Work\\Demo', readCounts(), true, 10)), [['Docs', 10], ...KEPT_AS_ONE.slice(1)]);
  // Not counted under a path, they are records from files, maybe of the same builds: the larger stays.
  const pathless = { path: null, buckets: { Docs: 3, docs: 3, src: 1 }, bucketsCounted: false, totalBuilds: 7 };
  setProjectPath(pathless, '/work/demo');
  assert.deepEqual([own(pathless.buckets), pathless.bucketsCounted], [[['Docs', 3], ['docs', 3], ['src', 1]], false], 'a path that joins no casings');
  setProjectPath(pathless, 'C:\\Work\\Demo');
  assert.deepEqual(own(pathless.buckets), [['Docs', 3], ['src', 1]]);
  // Joined there, each folder has one bucket, and the builds after are counted under a path.
  assert.equal(pathless.bucketsCounted, true);
  setProjectPath(pathless, '/work/demo');
  countBuild(pathless, 'docs');
  setProjectPath(pathless, 'C:\\Work\\Demo');
  assert.deepEqual(own(pathless.buckets), [['Docs', 4], ['src', 1]]);
  assert.deepEqual(own(foldBuckets('C:\\Work\\Demo', readCounts(), false)), KEPT_LARGER);
  assert.deepEqual(own(foldBuckets(null, readCounts(), false)), KEPT_APART);
});

test('mergeBuckets joins the saved casings by the saved side\'s flag and total, and keeps the larger of each folder', () => {
  const merged = (project, saved) => {
    mergeBuckets(project, { bucketsCounted: false, totalBuilds: 3, ...saved });
    return [own(project.buckets), project.bucketsCounted];
  };
  const uncounted = { buckets: { Docs: 3, docs: 3 } };
  // The buckets are counted under a path after it if either side's were; a side with no buckets has no say.
  assert.deepEqual(merged({ path: '/work/demo', buckets: { src: 1 }, bucketsCounted: true }, uncounted), [[['src', 1], ['Docs', 3], ['docs', 3]], true]);
  assert.deepEqual(merged({ path: null, buckets: {}, bucketsCounted: true }, uncounted), [[['Docs', 3], ['docs', 3]], false]);
  assert.deepEqual(merged({ path: null, buckets: { src: 1 }, bucketsCounted: false }, { buckets: {}, bucketsCounted: true }), [[['src', 1]], false]);
  assert.deepEqual(merged({ path: null, buckets: { src: 1 }, bucketsCounted: false }, { buckets: { src: 2 }, bucketsCounted: true }), [[['src', 2]], true]);
  // A path that makes casings one leaves each folder one bucket: counted from then on.
  assert.deepEqual(merged({ path: 'C:\\Work\\Demo', buckets: {}, bucketsCounted: true }, uncounted), [[['Docs', 3]], true]);
  // Counted casings are added up, but never past the saved side's total; then the larger of the two sides stays.
  assert.deepEqual(merged({ path: 'C:\\Work\\Demo', buckets: { docs: 4 }, bucketsCounted: true }, { buckets: { Docs: 5, docs: 7 }, bucketsCounted: true, totalBuilds: 9 }),
    [[['docs', 9]], true]);
});

test('a buckets object that takes no new property is looked up all the same', () => {
  for (const close of [Object.freeze, Object.seal, Object.preventExtensions]) {
    const project = { path: 'C:\\Work\\Demo', buckets: close({ Docs: 3, src: 1 }) };
    assert.deepEqual([bucketKey(project, 'docs'), bucketBuilds(project, 'DOCS'), bucketFor(project, 'lib'), bucketKey(project, 'SRC')],
      ['Docs', 3, { key: null, name: 'lib', builds: 0 }, 'src'], close.name);
    assert.deepEqual(Object.getOwnPropertySymbols(project.buckets), [], 'no index is hung on it');
  }
  // One that does take it keeps the index, out of its keys and its JSON.
  const open = { path: 'C:\\Work\\Demo', buckets: { Docs: 3 } };
  assert.equal(bucketKey(open, 'docs'), 'Docs');
  assert.deepEqual([Object.getOwnPropertySymbols(open.buckets).length, Object.keys(open.buckets), JSON.stringify(open.buckets)], [1, ['Docs'], '{"Docs":3}']);
});

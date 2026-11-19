'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bucketOf, bucketKey, bucketFor, countBuild, bucketBuilds, matchingName, planetKey } = require('../src/main/build-buckets');

test('bucketOf names the top-level folder, or (root) for a file at the top level', () => {
  assert.equal(bucketOf('Docs/Guide.md', '/'), 'Docs');
  assert.equal(bucketOf('Src\\Deep\\A.js', '\\'), 'Src');
  assert.equal(bucketOf('README.md', '/'), '(root)');
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

test('matchingName finds a folder among names: itself first, another casing only where the root ignores case', () => {
  const names = ['docs', 'Docs2', 'src'];
  assert.equal(matchingName(names, 'docs', 'C:\\Work'), 'docs');
  assert.equal(matchingName(names, 'DOCS', 'C:\\Work'), 'docs');
  assert.equal(matchingName(['Docs', 'docs'], 'docs', 'C:\\Work'), 'docs', 'the exact name wins over another casing');
  assert.equal(matchingName(names, 'DOCS', '/work'), null);
  assert.equal(matchingName(names, 'src', '/work'), 'src');
  assert.equal(matchingName(names, 'lib', 'C:\\Work'), null);
  assert.equal(matchingName([], 'lib', null), null);
});

test('bucketFor answers a folder\'s key, builds and the name it goes by, in one lookup', () => {
  const project = { path: 'C:\\Work\\Demo', buckets: { docs: 2 } };
  assert.deepEqual(bucketFor(project, 'Docs'), { key: 'docs', name: 'docs', builds: 2 });
  assert.deepEqual(bucketFor(project, 'Lib'), { key: null, name: 'Lib', builds: 0 }, 'no bucket: the name as asked');
  assert.deepEqual(bucketFor(project, 'constructor'), { key: null, name: 'constructor', builds: 0 });
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

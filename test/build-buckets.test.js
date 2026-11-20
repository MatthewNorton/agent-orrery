'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  addBuckets, bucketOf, bucketKey, bucketFor, countBuild, bucketBuilds, foldBuckets, matchingName, planetKey, setBucket,
} = require('../src/main/build-buckets');

const own = (buckets) => Object.keys(buckets).map((name) => [name, Object.getOwnPropertyDescriptor(buckets, name).value]);

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
  assert.deepEqual([bucketKey(posix, 'docs'), bucketKey(posix, 'Docs'), bucketBuilds(posix, 'lib'), countBuild(posix, 'lib')], [null, 'Docs', 0, true]);
  assert.equal(keys.asked, 0, 'no scan of the keys');
  const windows = { path: 'C:\\Work\\Demo', buckets: watched({ Docs: 1 }) };
  assert.equal(bucketKey(windows, 'docs'), 'Docs');
  assert.equal(keys.asked, 1, 'a root that ignores case looks through them');
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

test('every bucket count is a whole count, and no sum passes the largest one kept', () => {
  const MAX = Number.MAX_SAFE_INTEGER;
  // As a state file may hold them: a string, a fraction, a negative, null, zero, and two casings of 1e308.
  const counts = () => JSON.parse('{ "Docs": "5", "docs": 7, "src": 2.9, "neg": -1, "none": null, "zero": 0, "big": 1e308, "BIG": 1e308, "__proto__": 3 }');
  const windows = foldBuckets('C:\\Work\\Demo', counts());
  assert.deepEqual(own(windows), [['docs', 7], ['src', 2], ['big', MAX], ['__proto__', 3]], 'the string is no count, so it is no bucket and is not joined to 7');
  assert.deepEqual(own(foldBuckets('/work/demo', counts())), [['docs', 7], ['src', 2], ['big', MAX], ['BIG', MAX], ['__proto__', 3]]);
  assert.equal(JSON.stringify(windows).includes('null'), false, 'nothing saves as null');
  assert.deepEqual(own(foldBuckets(null, { Docs: 5, docs: 7 })), [['Docs', 5], ['docs', 7]], 'no path joins no two names');

  const project = { path: 'C:\\Work\\Demo', buckets: windows };
  assert.deepEqual([countBuild(project, 'BIG'), countBuild(project, 'big'), project.buckets.big], [false, false, MAX], 'a full count stays full');
  addBuckets(project, { DOCS: MAX, Src: 1 }, (held, added) => held + added);
  addBuckets(project, { docs: 3, SRC: 9, lib: '4' }, Math.max);
  assert.deepEqual(own(project.buckets), [['docs', MAX], ['src', 9], ['big', MAX], ['__proto__', 3]]);
  // A count put there past the rule (an older state, read by other code) is made whole when it is next added to.
  const odd = { path: '/work/demo', buckets: {} };
  setBucket(odd.buckets, 'src', /** @type {any} */ ('5'));
  setBucket(odd.buckets, 'lib', NaN);
  assert.deepEqual([countBuild(odd, 'src'), countBuild(odd, 'lib'), own(odd.buckets)], [false, false, [['src', 1], ['lib', 1]]]);
});

test('a key removed past setBucket is not answered from the index of the keys', () => {
  const project = { path: 'C:\\Work\\Demo', buckets: {} };
  countBuild(project, 'Docs');
  countBuild(project, 'src');
  assert.equal(bucketKey(project, 'docs'), 'Docs');
  delete project.buckets.Docs; // not how src/main removes one (it never does): the scan below sees to that
  assert.deepEqual([bucketKey(project, 'docs'), bucketKey(project, 'DOCS'), bucketKey(project, 'SRC')], [null, null, 'src']);
  assert.equal(countBuild(project, 'docs'), true, 'the folder starts again');
  assert.deepEqual([bucketKey(project, 'DOCS'), own(project.buckets)], ['docs', [['src', 1], ['docs', 1]]]);
  // Removed, with another casing put in its place: the index is built again from what is there.
  delete project.buckets.docs;
  Object.defineProperty(project.buckets, 'DOCS', { value: 4, writable: true, enumerable: true, configurable: true });
  assert.deepEqual([bucketKey(project, 'docs'), bucketBuilds(project, 'Docs')], ['DOCS', 4]);
});

// The lines of `source` that write a key of a buckets object: through a name that ends in
// `buckets`, or through another name the object was given (`const b = project.buckets`,
// `{ buckets: b }`, and a name given one of those).
function bucketWrites(source) {
  const lines = source.split('\n').map((line) => (/^\s*(\/\/|\/?\*)/.test(line) ? '' : line));
  const ASSIGN = '(?:=(?![=>])|\\+=|-=|\\*=|\\+\\+|--|\\|\\|=|&&=|\\?\\?=)';
  const TO = '(?:assign|defineProperty|defineProperties|setPrototypeOf|set|deleteProperty)';
  // Through a name that ends in `buckets`, with anything before it (project.buckets, a call's result).
  const writes = [
    new RegExp(`buckets\\s*(?:\\[[^\\]]*\\]|\\.[\\w$]+)\\s*${ASSIGN}`),
    /(?:\+\+|--)\s*[\w.$#]*buckets\s*[[.]/,
    /\bdelete\s+[^;]*buckets\s*[[.]/,
    new RegExp(`\\b(?:Object|Reflect)\\.${TO}\\(\\s*[^,()]*buckets\\b[^,()]*[,)]`),
  ];
  // Through another name the object was given.
  const writesOf = (name) => [
    new RegExp(`(?<![\\w.$])${name}\\s*(?:\\[[^\\]]*\\]|\\.[\\w$]+)\\s*${ASSIGN}`),
    new RegExp(`(?:\\+\\+|--)\\s*${name}\\s*[\\[.]`),
    new RegExp(`\\bdelete\\s+${name}\\s*[\\[.]`),
    new RegExp(`\\b(?:Object|Reflect)\\.${TO}\\(\\s*${name}\\b[^,()]*[,)]`),
  ];
  const names = new Set();
  for (const line of lines) {
    const given = line.match(/\b(?:const|let|var)\s+(\w+)\s*=\s*[^;]*\bbuckets\b\s*(?:(?:\|\||\?\?)\s*\{\s*\})?\s*;?\s*$/) || line.match(/\bbuckets\s*:\s*(\w+)\s*[,}]/);
    if (given && !given[1].endsWith('buckets')) names.add(given[1]);
  }
  for (let size = -1; size !== names.size;) {
    size = names.size;
    for (const line of lines) {
      const given = line.match(/\b(?:const|let|var)\s+(\w+)\s*=\s*(\w+)\s*;/);
      if (given && names.has(given[2])) names.add(given[1]);
    }
  }
  for (const name of names) writes.push(...writesOf(name));
  return lines.map((line, index) => [index + 1, line.trim()]).filter(([, line]) => line && writes.some((write) => write.test(line)));
}

test('every write of a bucket in src/main goes through setBucket', () => {
  // setBucket keeps the index of a buckets object in step; a write past it would leave a key the
  // lookups under a root that ignores case never find.
  const main = path.join(__dirname, '..', 'src', 'main');
  const files = fs.readdirSync(main, { recursive: true }).map(String).filter((file) => file.endsWith('.js'));
  assert.ok(files.length > 50, 'src/main was read');
  const found = files.flatMap((file) => bucketWrites(fs.readFileSync(path.join(main, file), 'utf8'))
    .map(([, line]) => `${file.replace(/\\/g, '/')}: ${line.replace(/\{.*$/, '')}`));
  // build-buckets.js has two: the index it hangs on the object, and setBucket's own.
  assert.deepEqual(found, [
    'build-buckets.js: if (Object.isExtensible(buckets) || Object.hasOwn(buckets, FOLDED)) Object.defineProperty(buckets, FOLDED, ',
    'build-buckets.js: Object.defineProperty(buckets, key, ',
  ]);
  // And the scan does see a write: through the name, and through another name for the object.
  const seen = (source) => bucketWrites(source).map(([line]) => line);
  for (const line of ['project.buckets[name] = 1;', 'p.buckets[key] += n', 'buckets[k]++', 'delete project.buckets[key]', 'delete (model.projects.get(id)).buckets[key];',
    'Object.assign(project.buckets, more)', 'Object.assign(existing.buckets ?? {}, saved)', '++buckets[name]', 'buckets.docs = 2;', 'Reflect.set(project.buckets, key, 1)']) {
    assert.deepEqual(seen(line), [1], line);
  }
  assert.deepEqual(seen('const b = project.buckets;\nb[key] = 1;\nconst c = b;\ndelete c[key];\nObject.assign(c, more);\nb.docs++;'), [2, 4, 5, 6], 'an alias, and an alias of it');
  assert.deepEqual(seen('const held = saved.buckets || {};\nheld[name] ??= 0;'), [2]);
  assert.deepEqual(seen('const target = { path: root, buckets: folded };\nfolded[name] = 1;\nfolded.x = 2;'), [2, 3], 'an object given as some project\'s buckets');
  for (const source of ['if (project.buckets[key] === 1) return;', 'Object.assign(Object.create(null), project.buckets)', 'const n = buckets[key] || 0;',
    'project.buckets = foldBuckets(root, project.buckets);', 'const counted = project.buckets;\nfor (const key of Object.keys(counted)) total += counted[key];',
    'const same = (key) => a.buckets[key] === b.buckets[key];', '// project.buckets[name] = 1;', 'const b = project.buckets;\nconst n = b[key];\nother[key] = n;']) {
    assert.deepEqual(seen(source), [], source);
  }
  const buckets = {};
  setBucket(buckets, 'src', 3);
  assert.deepEqual(own(buckets), [['src', 3]]);
});

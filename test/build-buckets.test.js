'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  addBuckets, bucketOf, bucketKey, bucketFor, countBuild, bucketBuilds, foldBuckets, matchingEntry, planetKey, setBucket, setProjectPath,
} = require('../src/main/build-buckets');
const { readCounts, own, KEPT_APART, KEPT_AS_ONE, KEPT_LARGER } = require('./support/bucket-cases');

// The name matchingEntry finds among names, as it finds a folder among a listing's entries.
const matchingName = (names, name, root) => matchingEntry(names.map((each) => ({ name: each })), name, root)?.name ?? null;

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

test('every bucket count stays a whole count, and no sum passes the largest one kept', () => {
  const MAX = Number.MAX_SAFE_INTEGER;
  // A saved project's counts come whole from its reader (test/live-saved-project.test.js); a fold keeps them so.
  const windows = foldBuckets('C:\\Work\\Demo', readCounts());
  assert.deepEqual(own(windows), KEPT_AS_ONE, 'two full counts joined are one full count');
  assert.deepEqual(own(foldBuckets('/work/demo', readCounts())), KEPT_APART);
  assert.equal(JSON.stringify(windows).includes('null'), false, 'nothing saves as null');
  assert.deepEqual(own(foldBuckets(null, readCounts())), KEPT_APART, 'no path joins no two names');

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
  const project = { path: null, buckets: JSON.parse('{ "Docs": 3, "docs": 2, "__proto__": 4 }') };
  setProjectPath(project, '/work/demo');
  assert.deepEqual([project.path, own(project.buckets)], ['/work/demo', [['Docs', 3], ['docs', 2], ['__proto__', 4]]]);
  setProjectPath(project, 'C:\\Work\\Demo');
  assert.deepEqual([project.path, own(project.buckets)], ['C:\\Work\\Demo', [['Docs', 5], ['__proto__', 4]]]);
  // The lookup of the new buckets goes by the new path at once: no index of the old ones is left.
  assert.deepEqual([bucketKey(project, 'DOCS'), countBuild(project, 'docs'), project.buckets.Docs], ['Docs', false, 6]);
  setProjectPath(project, null);
  assert.deepEqual([project.path, own(project.buckets), bucketKey(project, 'docs')], [null, [['Docs', 6], ['__proto__', 4]], null]);
});

test('casings counted under a path are added up; those of a project that had no path keep the larger', () => {
  // Under a path each build is in one bucket, so two casings joined by a new path are all its builds.
  const counted = { path: '/work/demo', buckets: { Docs: 3, docs: 3, src: 1 } };
  setProjectPath(counted, 'C:\\Work\\Demo');
  assert.deepEqual(own(counted.buckets), [['Docs', 6], ['src', 1]]);
  // With no path a project counts no build: its casings are records from files, maybe of the same builds.
  const pathless = { path: null, buckets: { Docs: 3, docs: 3, src: 1 } };
  setProjectPath(pathless, 'C:\\Work\\Demo');
  assert.deepEqual(own(pathless.buckets), [['Docs', 3], ['src', 1]]);
  // The caller says so where the project's own path does not: a saved record, a backup's entry.
  assert.deepEqual(own(foldBuckets('C:\\Work\\Demo', readCounts(), false)), KEPT_LARGER);
  assert.deepEqual(own(foldBuckets(null, readCounts(), false)), KEPT_APART);
  const restored = { path: null, buckets: { docs: 2, Docs: 5 } };
  setProjectPath(restored, 'C:\\Work\\Demo', true);
  assert.deepEqual(own(restored.buckets), [['docs', 7]]);
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

// What the scans below read: a source's lines, with the lines that are comments emptied.
const codeLines = (source) => source.split('\n').map((line) => (/^\s*(\/\/|\/?\*)/.test(line) ? '' : line));
const ASSIGN = '(?:=(?![=>])|\\+=|-=|\\*=|\\+\\+|--|\\|\\|=|&&=|\\?\\?=)';
/** @param {string[]} lines @param {RegExp[]} writes @returns {[number, string][]} the lines one of `writes` matches, numbered from 1 */
const matched = (lines, writes) => lines.map((line, index) => /** @type {[number, string]} */ ([index + 1, line.trim()]))
  .filter(([, line]) => line && writes.some((write) => write.test(line)));

// Every line of src/main that `scan` finds in its file, as `file: line`.
function mainLines(scan) {
  const main = path.join(__dirname, '..', 'src', 'main');
  const files = fs.readdirSync(main, { recursive: true }).map((file) => String(file).replaceAll('\\', '/')).filter((file) => file.endsWith('.js')).sort();
  assert.ok(files.length > 50, 'src/main was read');
  return files.flatMap((file) => scan(fs.readFileSync(path.join(main, file), 'utf8')).map(([, line]) => `${file}: ${line}`));
}

// The lines of `source` that write the `path` of an object: by assignment through any name, so a
// project under another name (`const p = project`) is seen as it is, or by a call that sets it.
function pathWrites(source) {
  return matched(codeLines(source), [
    new RegExp(`(?:\\.path|\\[\\s*['"\`]path['"\`]\\s*\\])\\s*${ASSIGN}`),
    /\b(?:Object|Reflect)\.(?:assign|defineProperty|defineProperties|set)\([^;]*\bpath\b(?!\s*\.)/,
  ]);
}

test('every write of a project\'s path in src/main goes through setProjectPath', () => {
  // setProjectPath folds the buckets by the path in the same step; a write past it leaves them as
  // another path counted them.
  assert.deepEqual(mainLines(pathWrites), [
    'build-buckets.js: project.path = projectPath;',
    // Not a project: a transcript tail's file, and a state file's entry before it is one.
    'live/codex-source.js: tail.path = fp;',
    'live/state-file.js: try { saved.path = path.normalize(fs.realpathSync.native(p)); } catch { saved.path = p; }',
  ]);
  const seen = (source) => pathWrites(source).map(([line]) => line);
  for (const line of ['project.path = next;', 'existing.path ??= saved.path;', 'model.projects.get(id).path = real', 'project[\'path\'] = next;', 'project["path"] ||= next',
    'Object.assign(project, { path: next });', 'Object.assign(project, { name, path })', 'Object.defineProperty(project, \'path\', { value: next });', 'Reflect.set(project, \'path\', next)']) {
    assert.deepEqual(seen(line), [1], line);
  }
  assert.deepEqual(seen('const p = project;\nconst q = p;\nq.path = next;'), [3], 'under another name');
  for (const line of ['if (project.path === next) return;', 'const held = project.path;', 'const project = { id, path: null };', '// project.path = next;',
    'Object.assign(out, { name: path.basename(dir) });', 'const same = (a, b) => a.path == b.path;', 'return { ...project, path: project.path };']) {
    assert.deepEqual(seen(line), [], line);
  }
});

test('in the live model one function sets a project\'s path: takeProjectPath', () => {
  // It sets the name, the folder check and the path index with the path; a call past it leaves one of them behind.
  const calls = (source) => matched(codeLines(source), [/\bsetProjectPath\s*\(/]);
  assert.deepEqual(mainLines(calls).filter((line) => line.startsWith('live/')), [
    'live/projects.js: setProjectPath(project, projPath, counted);',
    'live/projects.js: setProjectPath(project, was.path);', // giving the path back
  ]);
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'live', 'projects.js'), 'utf8');
  const taken = source.slice(source.indexOf('\nfunction takeProjectPath('), source.indexOf('\n}\n', source.indexOf('\nfunction takeProjectPath(')));
  assert.equal(calls(taken).length, 2, 'both inside takeProjectPath');
});

// The lines of `source` that write or remove a key of a buckets object: through a name that ends
// in `buckets`, or through another name the object was given (`const b = project.buckets`,
// `{ buckets: b }`, and a name given one of those).
function bucketWrites(source) {
  const lines = codeLines(source);
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
  return matched(lines, writes);
}

test('every write of a bucket in src/main goes through setBucket, and none is removed', () => {
  // setBucket keeps the index of a buckets object in step. A write past it would leave a key the
  // lookups under a root that ignores case never find, and a removal one they still answer with.
  // build-buckets.js has two: the index it hangs on the object, and setBucket's own.
  assert.deepEqual(mainLines(bucketWrites).map((line) => line.replace(/\{.*$/, '')), [
    'build-buckets.js: if (Object.isExtensible(buckets)) Object.defineProperty(buckets, FOLDED, ',
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

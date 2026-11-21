'use strict';

// src/main/build-buckets.js: every write of a project's path and of a bucket in src/main goes through
// the one function that keeps the buckets in step, found by scanning the sources.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setBucket } = require('../src/main/build-buckets');
const { own } = require('./support/bucket-cases');

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
    'live/projects.js: setProjectPath(project, projPath);',
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
  // build-buckets.js has three: the index and the count it hangs on the object, and setBucket's own.
  assert.deepEqual(mainLines(bucketWrites).map((line) => line.replace(/\{.*$/, '')), [
    'build-buckets.js: if (Object.isExtensible(buckets)) Object.defineProperty(buckets, FOLDED, ',
    'build-buckets.js: if (Object.isExtensible(buckets)) Object.defineProperty(buckets, SIZE, ',
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

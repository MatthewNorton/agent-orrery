// @ts-check
'use strict';

// Build counts per top-level project folder; '(root)' counts files at the top level. Under a
// case-insensitive root, one folder written in several casings keeps a single bucket: the
// first key recorded for it, which may be a lower-cased key saved by an earlier version.

const { ignoresCase } = require('./path-safety');

/** @typedef {{ path: string | null, buckets: Record<string, number> }} BucketedProject */

// Where a buckets object keeps its keys by their lower case (foldedKeys). Not enumerable and not a
// string key, so it is in no JSON, spread, Object.assign copy or IPC message: a copy builds its own.
const FOLDED = Symbol('bucket keys by lower case');
// A name as every casing of it compares where the root ignores case: the one place that says how.
const fold = (/** @type {string} */ name) => name.toLowerCase();

/**
 * The bucket of a project-relative path.
 * @param {string} rel
 * @param {string} separator
 */
function bucketOf(rel, separator) {
  return rel.includes(separator) ? rel.split(separator)[0] : '(root)';
}

/**
 * What a planet is compared by: one key for a folder, its bucket and every build in it, in whatever
 * casing each was written. The renderer matches planets and build events on it and reads nothing
 * into it.
 * @param {{ path: string | null }} project
 * @param {string} name
 */
function planetKey(project, name) {
  return ignoresCase(project.path) ? fold(name) : name;
}

/**
 * The one of `names` that is folder `name` under `root`: itself, or where the root ignores case
 * another casing of it. Null when none is.
 * @param {string[]} names
 * @param {string} name
 * @param {string | null} root
 * @returns {string | null}
 */
function matchingName(names, name, root) {
  if (names.includes(name)) return name;
  if (!ignoresCase(root)) return null;
  const project = { path: root }, key = planetKey(project, name);
  return names.find((entry) => planetKey(project, entry) === key) ?? null;
}

/**
 * The key holding the builds of folder `name`, or null when none does. Own keys only.
 * @param {BucketedProject} project
 * @param {string} name
 * @returns {string | null}
 */
function bucketKey(project, name) {
  if (Object.hasOwn(project.buckets, name)) return name;
  // Security: a transcript can start a bucket per edit. A case-sensitive root has the exact key
  // or none, so a miss there looks nothing up; a root that ignores case asks the index of the
  // keys, which is one lookup however many buckets there are.
  return ignoresCase(project.path) ? foldedKeys(project.buckets).get(fold(name)) ?? null : null;
}

/**
 * The first key of `buckets` for each folded key, as matchingName would find it. Built on the
 * first miss and kept on the object, where setBucket adds each new key: so every write of a bucket
 * goes through setBucket (test/build-buckets.test.js looks for one that does not).
 * @param {Record<string, number>} buckets
 * @returns {Map<string, string>}
 */
function foldedKeys(buckets) {
  /** @type {Map<string, string> | undefined} */
  let index = /** @type {any} */ (buckets)[FOLDED];
  if (index) return index;
  index = new Map();
  for (const key of Object.keys(buckets)) addFolded(index, key);
  if (Object.isExtensible(buckets)) Object.defineProperty(buckets, FOLDED, { value: index });
  return index;
}

/** @param {Map<string, string>} index @param {string} key */
function addFolded(index, key) {
  if (!index.has(fold(key))) index.set(fold(key), key);
}

/**
 * Folder `name`'s bucket, looked up once: the key holding its builds (null when none does), how
 * many, and the name it goes by where no folder on disk spells it: that key, or `name` as asked.
 * @param {BucketedProject} project
 * @param {string} name
 */
function bucketFor(project, name) {
  const key = bucketKey(project, name);
  return { key, name: key ?? name, builds: key === null ? 0 : project.buckets[key] || 0 };
}

/**
 * Security: writes a bucket's count. A folder may be named '__proto__', and assigning that key to
 * a plain object sets its prototype and records nothing, so every build there would start the
 * planet again. Defining the key makes it an own count like any other; JSON keeps it through the
 * state file.
 * @param {Record<string, number>} buckets
 * @param {string} key
 * @param {number} count
 */
function setBucket(buckets, key, count) {
  Object.defineProperty(buckets, key, { value: count, writable: true, enumerable: true, configurable: true });
  const index = /** @type {any} */ (buckets)[FOLDED];
  if (index) addFolded(index, key);
}

/**
 * Counts one build of `bucket`; true when it starts a new bucket.
 * @param {BucketedProject} project
 * @param {string} bucket
 */
function countBuild(project, bucket) {
  const key = bucketKey(project, bucket);
  setBucket(project.buckets, key ?? bucket, (key === null ? 0 : project.buckets[key] || 0) + 1);
  return key === null;
}

/**
 * Adds `counts` to the project's buckets, each under the key its folder has there (bucketKey), so
 * a folder keeps one bucket whatever casing the counts name it by. Where the folder has a count
 * already, `both` makes one of the two.
 * @param {BucketedProject} project
 * @param {Record<string, number>} counts
 * @param {(held: number, added: number) => number} both
 */
function addBuckets(project, counts, both) {
  for (const [name, builds] of Object.entries(counts)) {
    const key = bucketKey(project, name);
    // Security: an own count read and written, whatever the bucket is called.
    setBucket(project.buckets, key ?? name, key === null ? builds : both(project.buckets[key], builds));
  }
}

/**
 * The builds counted for folder `name`.
 * @param {BucketedProject} project
 * @param {string} name
 */
function bucketBuilds(project, name) {
  return bucketFor(project, name).builds;
}

module.exports = { addBuckets, bucketOf, bucketKey, bucketFor, countBuild, bucketBuilds, matchingName, planetKey, setBucket };

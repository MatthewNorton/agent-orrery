// @ts-check
'use strict';

// Build counts per top-level project folder; '(root)' counts files at the top level. Under a
// case-insensitive root, one folder written in several casings keeps a single bucket: the
// first key recorded for it, which may be a lower-cased key saved by an earlier version. A
// bucket is named as a planet is, with no control character (isBucketName), and a project keeps
// MAX_BUCKETS of them at most.

const { ignoresCase } = require('./path-safety');
const { hasControlChars } = require('./shared/ids');
const { wholeCount } = require('./shared/values');

/** @typedef {{ path: string | null, buckets: Record<string, number> }} BucketedProject */

// The most buckets a project keeps, and its files hold (live/saved-project.js). A transcript can
// name a new folder per edit.
const MAX_BUCKETS = 10_000;

// Where a buckets object keeps its keys by their lower case (foldedKeys). Not enumerable and not a
// string key, so it is in no JSON, spread, Object.assign copy or IPC message: a copy builds its own.
const FOLDED = Symbol('bucket keys by lower case');
// Where it keeps how many keys it has (bucketCount), by the same rules.
const SIZE = Symbol('bucket key count');
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
 * Whether `value` can name a planet: one plain path segment, so a planet read stays inside its
 * project's folder. '(root)' is one.
 * @param {unknown} value
 * @returns {value is string}
 */
function isPlanetSegment(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 255 &&
    value !== '.' && value !== '..' && !/[\\/\0]/.test(value);
}

/**
 * Whether `name` can be a bucket: a planet's name (isPlanetSegment) with no control character. The
 * one rule for a bucket, where a build is counted (both models) and where a file is read
 * (live/saved-project.js), so a bucket that is counted is saved, read back, listed by Go to and
 * opened as it was.
 * @param {unknown} name
 * @returns {name is string}
 */
function isBucketName(name) {
  return isPlanetSegment(name) && !hasControlChars(name);
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
 * The one of `entries` that is folder `name` under `root`: the one named so, or where the root
 * ignores case the first in another casing of it. Null when none is. One pass.
 * @template {{ name: string }} T
 * @param {T[]} entries
 * @param {string} name
 * @param {string | null} root
 * @returns {T | null}
 */
function matchingEntry(entries, name, root) {
  const folded = ignoresCase(root) ? fold(name) : null;
  let other = null;
  for (const entry of entries) {
    if (entry.name === name) return entry;
    if (other === null && folded !== null && fold(entry.name) === folded) other = entry;
  }
  return other;
}

/**
 * The first of `names` for each folded spelling: the one name a folder goes by where case is ignored.
 * @param {string[]} names
 * @returns {Map<string, string>}
 */
function firstByFold(names) {
  const first = new Map();
  for (const name of names) addFolded(first, name);
  return first;
}

/** @param {Map<string, string>} first @param {string} name */
function addFolded(first, name) {
  const folded = fold(name);
  if (!first.has(folded)) first.set(folded, name);
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
  if (!ignoresCase(project.path)) return null;
  return foldedKeys(project.buckets).get(fold(name)) ?? null;
}

/**
 * The first key of `buckets` for each folded key, as matchingEntry would find it. Built on the
 * first miss and kept on the object, where setBucket adds each new key: so every write of a bucket
 * goes through setBucket, and none is removed (test/build-buckets.test.js looks for a line that
 * does either). An object that takes no new property (a frozen one) is searched each time.
 * @param {Record<string, number>} buckets
 * @returns {Map<string, string>}
 */
function foldedKeys(buckets) {
  /** @type {Map<string, string> | undefined} */
  const kept = /** @type {any} */ (buckets)[FOLDED];
  if (kept) return kept;
  const index = firstByFold(Object.keys(buckets));
  if (Object.isExtensible(buckets)) Object.defineProperty(buckets, FOLDED, { value: index });
  return index;
}

/**
 * Folder `name`'s bucket, looked up once: the key holding its builds (null when none does), how
 * many, and the name it goes by where no folder on disk spells it: that key, or `name` as asked.
 * @param {BucketedProject} project
 * @param {string} name
 */
function bucketFor(project, name) {
  const key = bucketKey(project, name);
  return { key, name: key ?? name, builds: key === null ? 0 : wholeCount(project.buckets[key]) };
}

/**
 * How many buckets `buckets` holds. Counted on the first ask and kept on the object, where
 * setBucket counts each new key, as foldedKeys keeps its index: one lookup however many there are.
 * @param {Record<string, number>} buckets
 */
function bucketCount(buckets) {
  /** @type {{ keys: number } | undefined} */
  const kept = /** @type {any} */ (buckets)[SIZE];
  if (kept) return kept.keys;
  const size = { keys: Object.keys(buckets).length };
  if (Object.isExtensible(buckets)) Object.defineProperty(buckets, SIZE, { value: size });
  return size.keys;
}

/**
 * Whether folder `name`, which has no bucket in `buckets`, may start one: its name can be a
 * bucket's and there is room for one more. A build in a folder that may not counts in its
 * project's and ship's totals only.
 * @param {Record<string, number>} buckets
 * @param {string} name
 */
function canStart(buckets, name) {
  return isBucketName(name) && bucketCount(buckets) < MAX_BUCKETS;
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
  const size = /** @type {any} */ (buckets)[SIZE];
  if (size && !Object.hasOwn(buckets, key)) size.keys++;
  Object.defineProperty(buckets, key, { value: count, writable: true, enumerable: true, configurable: true });
  const index = /** @type {any} */ (buckets)[FOLDED];
  if (index) addFolded(index, key);
}

/**
 * Counts one build of `bucket`; true when it starts a new bucket. A folder that has no bucket and
 * may not start one (canStart) gets none, and its build counts in the totals its caller keeps.
 * @param {BucketedProject} project
 * @param {string} bucket
 */
function countBuild(project, bucket) {
  const { key, name, builds } = bucketFor(project, bucket);
  if (key === null && !canStart(project.buckets, name)) return false;
  setBucket(project.buckets, name, wholeCount(builds + 1));
  return key === null;
}

/**
 * Adds `counts` to the project's buckets, each under the key its folder has there (bucketKey), so
 * a folder keeps one bucket whatever casing the counts name it by. Where the folder has a count
 * already, `both` makes one of the two, and no sum passes the largest count kept (shared/values.js).
 * A folder that has no bucket starts one only as countBuild would (canStart).
 * `counts` are whole counts above none: a project's own, or a saved project's from its reader
 * (live/saved-project.js), which is where a count from a file is made one.
 * @param {BucketedProject} project
 * @param {Record<string, number>} counts
 * @param {(held: number, added: number) => number} both
 */
function addBuckets(project, counts, both) {
  for (const [name, builds] of Object.entries(counts)) {
    const held = bucketFor(project, name);
    if (held.key === null && !canStart(project.buckets, held.name)) continue;
    // Security: an own count read and written, whatever the bucket is called.
    setBucket(project.buckets, held.name, held.key === null ? builds : wholeCount(both(held.builds, builds)));
  }
}

/**
 * `counts` as the buckets of a project at `root`: one bucket per folder by that root's rule, under
 * the first key that names it. What a saved project's counts (a state file's, a backup's) go through
 * before they are a project's. Counts made under a path (`counted`) hold each build once, so the casings
 * of a folder are added up. A project with no path counts no build, since a build is bucketed
 * relative to the path: what it holds came from files, merged name by name, where two casings can
 * be two records of the same builds. Of those the larger is kept, so a folder never gets more
 * builds than its project has.
 * @param {string | null} root
 * @param {Record<string, number>} counts
 * @param {boolean} [counted] whether the counts were made under a path
 * @returns {Record<string, number>}
 */
function foldBuckets(root, counts, counted = true) {
  const project = { path: root, buckets: {} };
  addBuckets(project, counts, counted ? (held, added) => held + added : Math.max);
  return project.buckets;
}

/**
 * Gives a project its path: the one way a project's path is written. The path decides which names
 * are one folder, so the buckets are folded by it in the same step, and are always as their
 * project's path counts them. `counted` says whether they were counted under a path (foldBuckets);
 * left out, it is whether the project has a path now.
 * @param {BucketedProject} project
 * @param {string | null} projectPath
 * @param {boolean} [counted]
 */
function setProjectPath(project, projectPath, counted = project.path !== null) {
  project.path = projectPath;
  project.buckets = foldBuckets(projectPath, project.buckets, counted);
}

/**
 * The builds counted for folder `name`.
 * @param {BucketedProject} project
 * @param {string} name
 */
function bucketBuilds(project, name) {
  return bucketFor(project, name).builds;
}

module.exports = {
  MAX_BUCKETS, addBuckets, bucketOf, bucketKey, bucketFor, countBuild, bucketBuilds, foldBuckets, isBucketName, isPlanetSegment,
  matchingEntry, planetKey, setBucket, setProjectPath,
};

// @ts-check
'use strict';

// Build counts per top-level project folder; '(root)' counts files at the top level. Under a
// case-insensitive root, one folder written in several casings keeps a single bucket: the
// first key recorded for it, which may be a lower-cased key saved by an earlier version.

const { pathFlavor } = require('./path-safety');
const { hasControlChars } = require('./shared/ids');
const { wholeCount } = require('./shared/values');

/**
 * A project as the buckets see it. `bucketsCounted` and `totalBuilds` say how its folder's casings
 * join when a path makes them one (foldBuckets).
 * @typedef {{ path: string | null, buckets: Record<string, number>, bucketsCounted?: boolean, totalBuilds?: number }} BucketedProject
 */

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
 * Whether `project` takes every casing of a folder's name for one folder: the one place that says
 * when. A path in Windows syntax does (path-safety.js pathFlavor), on every host, as containment
 * (relativeInside) ignores case under it; a path in POSIX syntax, or in none, does not.
 * @param {{ path: string | null }} project
 */
function namesIgnoreCase(project) {
  return pathFlavor(project.path) === 'win32';
}

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
 * Whether `name` can be a bucket: a planet's name (isPlanetSegment) with no control character.
 * @param {unknown} name
 * @returns {name is string}
 */
function isBucketName(name) {
  return isPlanetSegment(name) && !hasControlChars(name);
}

/**
 * What a planet is compared by: one key for a folder, its bucket and every build the bucket holds,
 * in whatever casing each was written. A build no bucket holds (isBucketName refuses its name, or
 * the project is at MAX_BUCKETS) is counted under no key (countBuild), so it is on no planet, not
 * even the one its folder names. The renderer matches planets and build events on it and reads
 * nothing into it.
 * @param {{ path: string | null }} project
 * @param {string} name
 */
function planetKey(project, name) {
  return namesIgnoreCase(project) ? fold(name) : name;
}

/**
 * The one of `entries` that is folder `name` in `project`'s folder: the one named so, or where its
 * names ignore case the first in another casing of it. Null when none is. One pass.
 * @template {{ name: string }} T
 * @param {T[]} entries
 * @param {string} name
 * @param {{ path: string | null }} project
 * @returns {T | null}
 */
function matchingEntry(entries, name, project) {
  const folded = namesIgnoreCase(project) ? fold(name) : null;
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
  if (!namesIgnoreCase(project)) return null;
  return foldedKeys(project.buckets).get(fold(name)) ?? null;
}

/**
 * The first key of `buckets` for each folded key, as matchingEntry would find it. Built on the
 * first miss and kept on the object, where setBucket adds each new key: so every write of a bucket
 * goes through setBucket, and none is removed (test/build-buckets-writes.test.js looks for a line
 * that does either). An object that takes no new property (a frozen one) is searched each time.
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
 * Counts one build of `bucket`: `key` is the planet key it was counted under (planetKey), null when
 * no bucket holds it, so it is on no planet; `isNew` when that bucket starts with it. A folder that
 * has no bucket and may not start one (canStart) holds none.
 * @param {BucketedProject} project
 * @param {string} bucket
 * @returns {{ key: string | null, isNew: boolean }}
 */
function countBuild(project, bucket) {
  const held = bucketFor(project, bucket);
  if (held.key === null && !canStart(project.buckets, held.name)) return { key: null, isNew: false };
  setBucket(project.buckets, held.name, wholeCount(held.builds + 1));
  return { key: planetKey(project, held.name), isNew: held.key === null };
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
 * How two casings of one folder join into one count (foldBuckets): added up when they were counted
 * under a path, but never past `total` nor below the larger of them; otherwise the larger.
 * @param {boolean} counted
 * @param {number | undefined} total
 * @returns {(held: number, added: number) => number}
 */
function joinCasings(counted, total) {
  const limit = typeof total === 'number' && total >= 0 ? total : Infinity;
  return counted ? (held, added) => Math.max(held, added, Math.min(wholeCount(held + added), limit)) : Math.max;
}

/**
 * `counts` as the buckets of a project at `root`: one bucket per folder by that root's rule, under
 * the first key that names it. How a folder's casings join is decided here, and every other place
 * that joins them cites this:
 * - Counted under a path (`counted`: a project's bucketsCounted), each build was counted once, in
 *   the casing its edit wrote, so the casings of a folder are added up.
 * - Not counted under one, they came from files merged name by name with no path to bucket a build
 *   by, where two casings can be two records of the same builds. The larger is kept.
 * - Either way a folder never has more builds than its project: no sum passes `total` (the
 *   project's totalBuilds), and none is lowered below the larger casing. That also bounds a
 *   project whose buckets merged a counted side with one that was not, which one flag cannot
 *   tell apart.
 * @param {string | null} root
 * @param {Record<string, number>} counts
 * @param {boolean} counted whether the counts were made under a path
 * @param {number} [total] the project's builds, which no folder passes
 * @returns {Record<string, number>}
 */
function foldBuckets(root, counts, counted, total) {
  const project = { path: root, buckets: {} };
  addBuckets(project, counts, joinCasings(counted, total));
  return project.buckets;
}

/**
 * Gives a project its path: the one way a project's path is written. The path decides which names
 * are one folder, so the buckets are folded by it in the same step (foldBuckets, as the project's
 * bucketsCounted and totalBuilds say), and are always as their project's path counts them. A path
 * that joins a folder's casings (namesIgnoreCase) marks the buckets counted under a path from then
 * on: after the fold each folder is one bucket, and each build after it is counted once, in it.
 * @param {BucketedProject} project
 * @param {string | null} projectPath
 */
function setProjectPath(project, projectPath) {
  project.path = projectPath;
  project.buckets = foldBuckets(projectPath, project.buckets, project.bucketsCounted === true, project.totalBuilds);
  if (namesIgnoreCase(project)) project.bucketsCounted = true;
}

/**
 * Adds a saved project's counts to `project`'s, as an import does: the saved casings joined by the
 * project's path as foldBuckets joins them (by the saved side's own flag and total), then the
 * larger of each folder's two counts kept, since both sides can hold the same builds. The buckets
 * are counted under a path after it if either side's were, or if the project's path has joined
 * every folder's casings; a side with no buckets has no say.
 * @param {BucketedProject} project
 * @param {{ buckets: Record<string, number>, bucketsCounted: boolean, totalBuilds: number }} saved
 */
function mergeBuckets(project, saved) {
  if (bucketCount(saved.buckets) > 0) {
    project.bucketsCounted = namesIgnoreCase(project) || saved.bucketsCounted
      || (project.bucketsCounted === true && bucketCount(project.buckets) > 0);
  }
  addBuckets(project, foldBuckets(project.path, saved.buckets, saved.bucketsCounted, saved.totalBuilds), Math.max);
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
  matchingEntry, mergeBuckets, namesIgnoreCase, planetKey, setBucket, setProjectPath,
};

// @ts-check
'use strict';

// Build counts per top-level project folder; '(root)' counts files at the top level. Under a
// case-insensitive root, one folder written in several casings keeps a single bucket: the
// first key recorded for it, which may be a lower-cased key saved by an earlier version.

const { ignoresCase } = require('./path-safety');

/** @typedef {{ path: string | null, buckets: Record<string, number> }} BucketedProject */

/**
 * The bucket of a project-relative path.
 * @param {string} rel
 * @param {string} separator
 */
function bucketOf(rel, separator) {
  return rel.includes(separator) ? rel.split(separator)[0] : '(root)';
}

/**
 * The key holding the builds of folder `name`, or null when none does. Own keys only.
 * @param {BucketedProject} project
 * @param {string} name
 * @returns {string | null}
 */
function bucketKey(project, name) {
  if (Object.hasOwn(project.buckets, name)) return name;
  if (!ignoresCase(project.path)) return null;
  const folded = name.toLowerCase();
  return Object.keys(project.buckets).find((key) => key.toLowerCase() === folded) ?? null;
}

/**
 * Counts one build of `bucket`; true when it starts a new bucket.
 * @param {BucketedProject} project
 * @param {string} bucket
 */
function countBuild(project, bucket) {
  const key = bucketKey(project, bucket);
  project.buckets[key ?? bucket] = (key === null ? 0 : project.buckets[key] || 0) + 1;
  return key === null;
}

/**
 * The builds counted for folder `name`.
 * @param {BucketedProject} project
 * @param {string} name
 */
function bucketBuilds(project, name) {
  const key = bucketKey(project, name);
  return key === null ? 0 : project.buckets[key] || 0;
}

module.exports = { bucketOf, bucketKey, countBuild, bucketBuilds };

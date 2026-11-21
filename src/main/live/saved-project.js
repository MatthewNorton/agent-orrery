// @ts-check
'use strict';

// The one reader of a saved project: an entry of `projects` in universe-state.json or in a
// backup. Either file may hold anything, so each field is checked here, once, and the code past
// this reader takes what it gives as it is.

const { MAX_BUCKETS, isBucketName, setBucket } = require('../build-buckets');
const { hasControlChars } = require('../shared/ids');
const { wholeCount } = require('../shared/values');
const { plainObject } = require('../transcripts/fields');

/** @import { SavedProject } from '../../types/live-model' */

const MAX_TEXT_LENGTH = 4096;
// Security: keys that would reach an object's prototype. A bucket (setBucket) and a project id are not held to them.
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** @param {unknown} value @returns {value is string} */
function plainText(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT_LENGTH && !hasControlChars(value);
}

/**
 * Security: a key or name from a file becomes an object key and reaches the screen.
 * @param {unknown} value
 * @returns {value is string}
 */
function validKey(value) {
  return plainText(value) && !RESERVED_KEYS.has(value);
}

/**
 * A saved project, read: null for an entry that is not a record. Only a string is a path, and
 * each file's own rule then says whether the app may use it. A name is plain text of a length that
 * fits the screen, or none. Every count and time is a whole count (shared/values.js), and a bucket
 * is a folder name build-buckets.js would count (isBucketName) with a count above none,
 * MAX_BUCKETS of them at most. No folder has more builds than its project, so the total is at
 * least the largest bucket. `bucketsCounted` (build-buckets.js foldBuckets) is the file's, or for
 * a file written before it, whether the record had a path, whatever became of the path. A record
 * with no buckets has no casings to join, and counts as counted.
 * @param {unknown} raw
 * @returns {SavedProject | null}
 */
function savedProject(raw) {
  if (!plainObject(raw)) return null;
  const savedPath = typeof raw.path === 'string' && raw.path ? raw.path : null;
  const buckets = savedBuckets(raw.buckets);
  const counts = Object.values(buckets);
  return {
    path: savedPath,
    bucketsCounted: counts.length === 0 || (typeof raw.bucketsCounted === 'boolean' ? raw.bucketsCounted : savedPath !== null),
    name: validKey(raw.name) ? raw.name : undefined,
    lastActivity: wholeCount(raw.lastActivity),
    firstSeen: wholeCount(raw.firstSeen),
    totalBuilds: counts.reduce((most, count) => Math.max(most, count), wholeCount(raw.totalBuilds)),
    buckets,
  };
}

/** @param {unknown} value */
function savedBuckets(value) {
  /** @type {Record<string, number>} */
  const out = {};
  if (!plainObject(value)) return out;
  for (const [name, saved] of Object.entries(value).slice(0, MAX_BUCKETS)) {
    const builds = wholeCount(saved);
    if (isBucketName(name) && builds > 0) setBucket(out, name, builds);
  }
  return out;
}

module.exports = { savedProject, validKey };

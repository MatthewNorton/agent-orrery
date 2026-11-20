// @ts-check
'use strict';

// The one reader of a saved project: an entry of `projects` in universe-state.json or in a
// backup. Either file may hold anything, so each field is checked here, once, and the code past
// this reader takes what it gives as it is.

const { setBucket } = require('../build-buckets');
const { hasControlChars } = require('../shared/ids');
const { wholeCount } = require('../shared/values');
const { plainObject } = require('../transcripts/fields');

/** @import { SavedProject } from '../../types/live-model' */

const MAX_TEXT_LENGTH = 4096;
const MAX_BUCKETS = 10_000;
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
 * each file's own rule then says whether the app may use it; `counted` is whether the record had
 * one, so whether its builds were counted under a path (build-buckets.js). A name is plain text
 * of a length that fits the screen, or none. Every count and time is a whole count
 * (shared/values.js), and a bucket is a plain-text folder name with a count above none.
 * @param {unknown} raw
 * @returns {SavedProject | null}
 */
function savedProject(raw) {
  if (!plainObject(raw)) return null;
  const savedPath = typeof raw.path === 'string' && raw.path ? raw.path : null;
  return {
    path: savedPath,
    counted: savedPath !== null,
    name: validKey(raw.name) ? raw.name : undefined,
    lastActivity: wholeCount(raw.lastActivity),
    firstSeen: wholeCount(raw.firstSeen),
    totalBuilds: wholeCount(raw.totalBuilds),
    buckets: savedBuckets(raw.buckets),
  };
}

/** @param {unknown} value */
function savedBuckets(value) {
  /** @type {Record<string, number>} */
  const out = {};
  if (!plainObject(value)) return out;
  for (const [name, saved] of Object.entries(value).slice(0, MAX_BUCKETS)) {
    const builds = wholeCount(saved);
    if (plainText(name) && builds > 0) setBucket(out, name, builds);
  }
  return out;
}

module.exports = { savedProject, validKey };

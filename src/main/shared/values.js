// @ts-check
'use strict';

function boundedInteger(value, fallback, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

/**
 * A count as the app keeps one: a whole number from 0 to Number.MAX_SAFE_INTEGER. A fraction
 * keeps its whole part, a larger number is the largest kept, and anything else (a string, NaN, a
 * negative, Infinity) is 0: the one rule for a count from a file and for every sum of counts.
 * @param {unknown} value
 * @returns {number}
 */
function wholeCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return 0;
  return Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER);
}

/**
 * Security: a copy of `from` with no prototype, for a map keyed by names from outside (a project id,
 * a path key, a folder): any of them is an own key there, '__proto__' too, in writes and deletes alike.
 * @template T
 * @param {Record<string, T>} [from]
 * @returns {Record<string, T>}
 */
function bareCopy(from = {}) {
  return Object.assign(Object.create(null), from);
}

// Reads only an own data property, so getters and inherited values are never invoked.
function ownString(value, key) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, key)) {
    return '';
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string'
    ? descriptor.value.trim() : '';
}

function bufferValue(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (value == null) return Buffer.alloc(0);
  return Buffer.from(String(value), 'utf8');
}

module.exports = { bareCopy, boundedInteger, ownString, bufferValue, wholeCount };

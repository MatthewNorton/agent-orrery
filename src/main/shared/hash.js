// @ts-check
'use strict';

// The renderer keeps hash-pinned copies in src/renderer/util.js and galaxy-layout.js, so
// seeds agree across processes; test/shared-hash.test.js holds util.js to this one.

/**
 * 32-bit FNV-1a over the UTF-16 code units of String(value).
 * @param {unknown} value
 * @returns {number}
 */
function fnv1a(value) {
  const input = String(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * fnv1a as 8 lower-case hex digits.
 * @param {unknown} value
 * @returns {string}
 */
function hex8(value) {
  return fnv1a(value).toString(16).padStart(8, '0');
}

/**
 * A deterministic generator of floats in [0, 1).
 * @param {number} seed
 * @returns {() => number}
 */
function mulberry32(seed) {
  let state = seed >>> 0;
  return function random() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { fnv1a, hex8, mulberry32 };

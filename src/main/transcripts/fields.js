// @ts-check
'use strict';

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;
const MAX_ID_LENGTH = 256;
const MAX_PATH_LENGTH = 4096;

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A trimmed session or call id made of safe characters, or null.
 * @param {unknown} value
 * @returns {string | null}
 */
function safeId(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  if (!id || id.length > MAX_ID_LENGTH || !SAFE_ID_RE.test(id)) return null;
  return id;
}

/**
 * A trimmed path of at most 4096 characters without NUL, CR or LF, or null.
 * @param {unknown} value
 * @returns {string | null}
 */
function safePath(value) {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  if (!candidate || candidate.length > MAX_PATH_LENGTH || /[\0\r\n]/.test(candidate)) return null;
  return candidate;
}

/**
 * The first non-blank string, trimmed, or null.
 * @param {...unknown} values
 * @returns {string | null}
 */
function firstTrimmed(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

module.exports = { MAX_PATH_LENGTH, plainObject, safeId, safePath, firstTrimmed };

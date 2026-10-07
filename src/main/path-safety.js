// @ts-check
'use strict';

// One shared local-path classifier for the main-process launchers (kit 13, task C).
// Where the launchers' former private copies disagreed, the stricter rule wins.
// tracker.js and replay-source.js keep their own relativeInside (frozen files).

const path = require('node:path');
const { isLocalProjectPath, canonicalProjectPath } = require('./provider-adapters');

const MAX_PATH_LENGTH = 4096;
// NUL and every other C0 control character, plus DEL.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Path syntax from the value itself: 'win32' for a drive-rooted `X:\…` / `X:/…`,
 * 'posix' for `/…`, otherwise null. UNC (`\\host\share`) and `//host/share` are null.
 */
function pathFlavor(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (/^[A-Za-z]:[\\/]/.test(value)) return 'win32';
  if (value.startsWith('/') && !value.startsWith('//')) return 'posix';
  return null;
}

/** Non-empty string of at most 4096 characters without NUL or other control characters. */
function validPathString(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PATH_LENGTH &&
    !CONTROL_CHARS.test(value);
}

function isDriveRoot(value) {
  return /^[A-Za-z]:\\$/.test(value);
}

/**
 * Absolute local path already in its flavor's normalized form: no trailing separator
 * (drive roots excepted) and no `.` / `..` segments.
 */
function isCanonicalPath(value) {
  if (!validPathString(value)) return false;
  const flavorName = pathFlavor(value);
  if (!flavorName) return false;
  const flavor = path[flavorName];
  if (!flavor.isAbsolute(value) || flavor.normalize(value) !== value) return false;
  if (!isDriveRoot(value) && /[\\/]$/.test(value)) return false;
  const segments = value.split(flavorName === 'win32' ? /[\\/]/ : '/');
  return !segments.some((segment) => segment === '.' || segment === '..');
}

/** isCanonicalPath and the flavor matches the platform (`win32` ↔ 'win32', else 'posix'). */
function isCanonicalPathFor(value, platform) {
  return isCanonicalPath(value) && pathFlavor(value) === (platform === 'win32' ? 'win32' : 'posix');
}

/** A normalized POSIX-flavored absolute path (`//host/share` is not POSIX-flavored). */
function isAbsolutePosixPath(value) {
  return validPathString(value) && pathFlavor(value) === 'posix' &&
    path.posix.normalize(value) === value;
}

/** candidate equals or lies beneath root; both canonical and of the same flavor. */
function isInsidePath(root, candidate) {
  if (!isCanonicalPath(root) || !isCanonicalPath(candidate)) return false;
  const flavorName = pathFlavor(root);
  if (pathFlavor(candidate) !== flavorName) return false;
  const flavor = path[flavorName];
  // Fold case for every flavor: Windows and the default macOS volume format are
  // case-insensitive, and folding on a case-sensitive host only fails closed.
  const relative = flavor.relative(root.toLowerCase(), candidate.toLowerCase());
  return relative === '' || (!flavor.isAbsolute(relative) && relative !== '..' &&
    !relative.startsWith(`..${flavor.sep}`));
}

module.exports = {
  pathFlavor,
  validPathString,
  isCanonicalPath,
  isCanonicalPathFor,
  isAbsolutePosixPath,
  isInsidePath,
  // Re-exported unchanged; provider-adapters.js is frozen.
  isLocalProjectPath,
  canonicalProjectPath,
};

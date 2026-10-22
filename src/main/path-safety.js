// @ts-check
'use strict';

// One shared local-path classifier for the main process (kit 13, task C).
// Where the launchers' former private copies disagreed, the stricter rule wins.

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

/**
 * A path the app may stat or open, normalized: absolute and on a local disk. Null for UNC and
 * device paths (see isLocalProjectPath), relative paths and non-strings.
 * @param {unknown} value
 * @returns {string | null}
 */
function localAbsolutePath(value) {
  if (typeof value !== 'string' || !isLocalProjectPath(value)) return null;
  const normalized = path.normalize(value);
  return isLocalProjectPath(normalized) && path.isAbsolute(normalized) ? normalized : null;
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

/**
 * Whether names under root compare case-insensitively: a Windows-style root (a drive letter
 * or a backslash), on every host.
 * @param {string | null | undefined} root
 */
function ignoresCase(root) {
  return typeof root === 'string' && (/^[a-z]:[\\/]/i.test(root) || root.includes('\\'));
}

/**
 * file relative to root, joined with `separator`, or null unless it lies strictly beneath
 * root. The flavor, and Windows case folding, come from root's syntax, so every host agrees.
 * Case folding only decides containment: the result keeps the file's own casing.
 * Without `requireAbsolute` a relative file resolves against the process cwd.
 * @param {string | null | undefined} root
 * @param {string | null | undefined} file
 * @param {{ separator?: string, requireAbsolute?: boolean }} [options]
 * @returns {string | null}
 */
function relativeInside(root, file, { separator = path.sep, requireAbsolute = false } = {}) {
  if (!root || !file) return null;
  const windows = ignoresCase(root);
  const flavor = windows ? path.win32 : path.posix;
  if (requireAbsolute && (!flavor.isAbsolute(root) || !flavor.isAbsolute(file))) return null;
  const normalizedRoot = flavor.normalize(root);
  const normalizedFile = flavor.normalize(file);
  const comparableRoot = windows ? normalizedRoot.toLowerCase() : normalizedRoot;
  const comparableFile = windows ? normalizedFile.toLowerCase() : normalizedFile;
  const rel = flavor.relative(comparableRoot, comparableFile);
  if (!rel || rel === '..' || rel.startsWith(`..${flavor.sep}`) || flavor.isAbsolute(rel)) return null;
  // win32.relative also ignores case and answers in the file's casing; use it only if it agrees.
  const cased = windows ? flavor.relative(normalizedRoot, normalizedFile) : rel;
  return (cased.toLowerCase() === rel.toLowerCase() ? cased : rel).replace(/[\\/]+/g, separator);
}

module.exports = {
  pathFlavor,
  validPathString,
  isCanonicalPath,
  isCanonicalPathFor,
  isAbsolutePosixPath,
  localAbsolutePath,
  isInsidePath,
  ignoresCase,
  relativeInside,
  // Re-exported unchanged from provider-adapters.js, which owns them.
  isLocalProjectPath,
  canonicalProjectPath,
};

// @ts-check
'use strict';

const os = require('os');
const path = require('path');

const DEFAULT_CLAUDE_ROOT = path.join(os.homedir(), '.claude', 'projects');
const DEFAULT_CODEX_ROOTS = [
  path.join(os.homedir(), '.codex', 'sessions'),
  path.join(os.homedir(), '.codex', 'archived_sessions'),
];
const MAX_FILES = 50000;
const MAX_BATCH = 256;

const DEFAULT_SCHEDULER = Object.freeze({
  setTimeout: (fn, delay) => setTimeout(fn, delay),
  clearTimeout: (timer) => clearTimeout(timer),
});

/**
 * ReplaySource's transcript roots, clock, timer scheduler and bounds. Roots default to the
 * user's Claude and Codex folders; each accepts several spellings.
 * @param {Record<string, any>} options
 */
function resolveReplayOptions(options) {
  const roots = options.roots && typeof options.roots === 'object' ? options.roots : {};
  const claudeProjectsDir = firstResolvedPath(
    options.claudeProjectsDir,
    options.claudeRoot,
    roots.claudeProjectsDir,
    roots.claude,
    DEFAULT_CLAUDE_ROOT
  );

  let codexSessionDirs;
  const suppliedCodexRoots = firstArray(
    options.codexSessionDirs,
    options.codexRoots,
    roots.codexSessionDirs,
    roots.codex
  );
  if (suppliedCodexRoots) {
    codexSessionDirs = suppliedCodexRoots.filter(isNonemptyString).map((item) => path.resolve(item));
  } else {
    const active = firstResolvedPath(
      options.codexSessionsDir,
      options.codexSessionDir,
      options.codexActiveRoot,
      roots.codexSessionsDir,
      roots.codexActive
    );
    const archived = firstResolvedPath(
      options.codexArchivedSessionsDir,
      options.codexArchiveRoot,
      roots.codexArchivedSessionsDir,
      roots.codexArchive
    );
    codexSessionDirs = active || archived
      ? [active, archived].filter(Boolean).map((item) => path.resolve(item))
      : DEFAULT_CODEX_ROOTS.slice();
  }

  /** @type {() => number} */
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const scheduler = options.scheduler && typeof options.scheduler === 'object'
    ? options.scheduler : DEFAULT_SCHEDULER;
  return {
    claudeProjectsDir,
    codexSessionDirs,
    now,
    scheduler: {
      setTimeout: typeof scheduler.setTimeout === 'function'
        ? scheduler.setTimeout.bind(scheduler) : DEFAULT_SCHEDULER.setTimeout,
      clearTimeout: typeof scheduler.clearTimeout === 'function'
        ? scheduler.clearTimeout.bind(scheduler) : DEFAULT_SCHEDULER.clearTimeout,
    },
    maxFiles: Math.min(MAX_FILES, positiveInteger(options.maxFiles, MAX_FILES)),
    maxBatch: Math.min(MAX_BATCH, positiveInteger(options.maxBatch, MAX_BATCH)),
    tickMs: positiveInteger(options.tickMs, 100),
  };
}

/** @param {() => number} now */
function finiteNow(now) {
  const value = Number(now());
  return Number.isFinite(value) ? value : Date.now();
}

function firstResolvedPath(...values) {
  for (const value of values) if (isNonemptyString(value)) return path.resolve(value);
  return null;
}

function firstArray(...values) {
  for (const value of values) if (Array.isArray(value)) return value;
  return null;
}

function isNonemptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

module.exports = { resolveReplayOptions, finiteNow };

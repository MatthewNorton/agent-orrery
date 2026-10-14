// @ts-check
'use strict';

// universe-state.json: every project the app has ever seen, with its path, name, last activity
// and build counts per folder; which id each project path maps to; and the paths the user
// recovered by hand. Ships and the feed are never saved. A project stays in the file after its
// transcripts are pruned: the providers keep those on their own schedule, the universe keeps the file.

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('../shared/atomic-write');
const { pathFromKey } = require('../provider-adapters');

/** @import { LiveModel, PersistedState } from '../../types/live-model' */

const STATE_VERSION = 2;

/** @returns {PersistedState | null} */
function readState(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!state || typeof state !== 'object') return null;
    if (!state.projects || typeof state.projects !== 'object') state.projects = {};
    return state;
  } catch {
    return null;
  }
}

/**
 * Files before version 2 kept a project's path only as a key of pathIds, lower-cased on Windows;
 * the folder's own casing comes back through realpath while it still exists.
 * @param {PersistedState} state
 */
function migrate(state) {
  const pathsById = new Map();
  for (const [key, id] of Object.entries(state.pathIds || {})) {
    if (!pathsById.has(id)) pathsById.set(id, pathFromKey(key));
  }
  for (const [id, saved] of Object.entries(state.projects)) {
    if (saved.path || !pathsById.get(id)) continue;
    const p = pathsById.get(id);
    try { saved.path = path.normalize(fs.realpathSync.native(p)); } catch { saved.path = p; }
  }
  state.version = STATE_VERSION;
}

/**
 * Reads the file, or its backup when the file is missing or unreadable, and keeps what it read as
 * universe-state.json.bak: the state this run started from, until the next run.
 * @param {string} statePath
 * @returns {PersistedState}
 */
function loadState(statePath) {
  let state = readState(statePath);
  if (state) {
    try { fs.copyFileSync(statePath, statePath + '.bak'); } catch { /* the backup is best effort */ }
  } else {
    state = readState(statePath + '.bak') || { projects: {} };
  }
  if (!(state.version >= STATE_VERSION)) migrate(state);
  return state;
}

/**
 * @param {LiveModel} model
 * @param {boolean} [throwOnError]
 * @returns {boolean} whether the file was written
 */
function saveState(model, throwOnError = false) {
  /** @type {PersistedState} */
  const out = {
    version: STATE_VERSION,
    projects: {},
    pathIds: { ...model.pathIds },
    pathOverrides: { ...model.pathOverrides },
  };
  for (const [id, p] of model.projects) {
    out.projects[id] = {
      path: p.path, name: p.name, lastActivity: p.lastActivity,
      buckets: p.buckets, totalBuilds: p.totalBuilds, firstSeen: p.firstSeen,
    };
  }
  try {
    fs.mkdirSync(path.dirname(model.statePath), { recursive: true });
    writeFileAtomic(model.statePath, JSON.stringify(out));
    return true;
  } catch (e) {
    if (throwOnError) throw e;
    console.error('state save failed', e.message);
    return false;
  }
}

module.exports = { loadState, saveState };

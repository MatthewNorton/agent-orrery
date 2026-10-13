// @ts-check
'use strict';

// universe-state.json: build counts per project, which id each project path maps to, and the
// paths the user recovered by hand. Ships and the feed are never saved.

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('../shared/atomic-write');

/** @import { LiveModel, PersistedState } from '../../types/live-model' */

/**
 * @param {string} statePath
 * @returns {PersistedState}
 */
function loadState(statePath) {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return { projects: {} };
  }
}

/**
 * @param {LiveModel} model
 * @param {boolean} [throwOnError]
 * @returns {boolean} whether the file was written
 */
function saveState(model, throwOnError = false) {
  const out = {
    projects: {},
    pathIds: { ...model.pathIds },
    pathOverrides: { ...model.pathOverrides },
  };
  for (const [slug, p] of model.projects) {
    out.projects[slug] = { buckets: p.buckets, totalBuilds: p.totalBuilds, firstSeen: p.firstSeen };
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

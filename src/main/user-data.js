// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic } = require('./shared/atomic-write');

// Until October 2026 the app was Agent Universe Lite, and Electron named its data folder after
// that package. universe-state.json goes last: once it exists here, the copy is complete.
const LEGACY_FOLDER = 'agent-universe-lite';
const STATE_FILES = ['providers.json', 'root-tasks.json', 'task-runs.json', 'universe-state.json'];
const COMPLETE_MARKER = 'universe-state.json';

/**
 * Copies the app's own state files from the legacy data folder the first time the app runs under
 * its new name. Reads the legacy folder only, so a checkout still running under the old name keeps
 * its data.
 * @param {{ getPath(name: 'userData' | 'appData'): string }} app
 * @param {{ fsImpl?: typeof fs }} [options]
 * @returns {string[]} the files copied
 */
function adoptLegacyUserData(app, { fsImpl = fs } = {}) {
  const target = app.getPath('userData');
  const legacy = path.join(app.getPath('appData'), LEGACY_FOLDER);
  if (path.resolve(legacy) === path.resolve(target)) return [];
  if (fsImpl.existsSync(path.join(target, COMPLETE_MARKER))) return [];
  if (!fsImpl.existsSync(path.join(legacy, COMPLETE_MARKER))) return [];
  fsImpl.mkdirSync(target, { recursive: true });
  const copied = [];
  for (const name of STATE_FILES) {
    const from = path.join(legacy, name);
    if (!fsImpl.existsSync(from)) continue;
    writeFileAtomic(path.join(target, name), fsImpl.readFileSync(from, 'utf8'), { fsImpl });
    copied.push(name);
  }
  return copied;
}

module.exports = { adoptLegacyUserData, LEGACY_FOLDER };

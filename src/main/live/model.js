// @ts-check
'use strict';

const { createHistogram } = require('../shared/build-histogram');

// The live model: every map and counter the live modules share, with its time windows and read
// limits. The Tracker creates one and passes it to each live function.

const os = require('os');
const path = require('path');
const { loadState } = require('./state-file');

/**
 * @import { AUEvent } from '../../types/contract'
 * @import { LiveModel, LiveModelOptions } from '../../types/live-model'
 */

const ACTIVE_WINDOW_MS = 5 * 60 * 1000;   // ship visible this long after last write
const HOT_WINDOW_MS = 15 * 60 * 1000;     // only files this fresh get tailed
const READ_LIMIT_BYTES = 8 * 1024 * 1024; // most read from one file per poll
const LINE_LIMIT_BYTES = 1024 * 1024;     // longer lines are skipped, never parsed

const DEFAULT_CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const DEFAULT_CODEX_SESSION_DIRS = [
  path.join(os.homedir(), '.codex', 'sessions'),
  path.join(os.homedir(), '.codex', 'archived_sessions'),
];

/**
 * @param {string} statePath universe-state.json, read once here
 * @param {LiveModelOptions} options
 * @param {(batch: AUEvent[]) => void} publish
 * @returns {LiveModel}
 */
function createLiveModel(statePath, options, publish) {
  const codexSessionDirs = options.codexSessionsDir
    ? [options.codexSessionsDir]
    : options.codexSessionDir
      ? [options.codexSessionDir]
      : Array.isArray(options.codexSessionDirs)
        ? options.codexSessionDirs.slice()
        : DEFAULT_CODEX_SESSION_DIRS.slice();
  const providerConfigPath = options.providerConfigPath ||
    process.env.AGENT_UNIVERSE_PROVIDER_CONFIG ||
    path.join(path.dirname(statePath), 'providers.json');
  const persisted = loadState(statePath);
  const pathOverrides = Object.create(null);
  for (const [projectId, projectPath] of Object.entries(persisted.pathOverrides || {})) {
    if (typeof projectId === 'string' && projectId && typeof projectPath === 'string' &&
        path.isAbsolute(projectPath)) {
      pathOverrides[projectId] = path.normalize(projectPath);
    }
  }
  return {
    statePath,
    claudeProjectsDir: options.claudeProjectsDir || DEFAULT_CLAUDE_PROJECTS_DIR,
    codexSessionDirs,
    providerConfigPath,
    projects: new Map(),
    ships: new Map(),
    files: new Map(),
    claudeTails: new Map(),
    persisted,
    pathIds: Object.assign(Object.create(null), persisted.pathIds || {}),
    pathOverrides,
    projectPathIndex: new Map(),
    codexTailsBySession: new Map(),
    codexMetaCache: new Map(),
    signalFiles: new Map(),
    providerWarnings: new Set(),
    shipCounter: 0,
    providerCounters: new Map(),
    systemCache: new Map(),
    pendingIndex: new Map(),
    pending: [],
    feed: [],
    buildHistogram: createHistogram(Date.now()),
    eventSequence: 0,
    publish,
  };
}

module.exports = {
  ACTIVE_WINDOW_MS,
  HOT_WINDOW_MS,
  READ_LIMIT_BYTES,
  LINE_LIMIT_BYTES,
  createLiveModel,
};

// @ts-check
// Watches ~/.claude/projects transcript JSONL files and turns them into
// universe events: projects (solar systems), sessions (ships), tool calls
// (activity), file edits (planet growth). Zero-config: works with any
// terminal because Claude Code always writes transcripts there.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const {
  normalizeProvider,
  canonicalProjectPath,
  isLocalProjectPath,
  codexSessionIdFromFilename,
  classifyTool,
  codexRecordToSignals,
  readGenericWatchConfig,
  createAdapterState,
  splitCompleteLines,
  adaptLine,
} = require('./provider-adapters');
const { claudeRecordToSignals, claudeTool } = require('./transcripts/claude');
const { codexParentSessionId } = require('./transcripts/codex');
const { fnv1a, hex8, mulberry32 } = require('./shared/hash');
const { relativeInside } = require('./path-safety');
const { signalSources, watchedFiles } = require('./signal-sources');
const { bucketOf, countBuild, bucketBuilds } = require('./build-buckets');
const { deriveGalaxy } = require('./universe/galaxy');
const { liveProject, liveShip } = require('./universe/public-shape');
const { createShipRecord } = require('./universe/ships');
const { queue, pushFeed, flush, recentFeed } = require('./live/events');
const { classifyAttention, evaluateAttention } = require('./live/attention');
const { loadState, saveState } = require('./live/state-file');
const { getSystem, getPlanet } = require('./live/system-view');
const {
  isProjectDirectory, updateProjectExists, refreshProjectExistence, indexProjectPath,
  preferredProjectPath, remapProjectPath, ensureProjectForPath,
} = require('./live/projects');
const { ACTIVE_WINDOW_MS, HOT_WINDOW_MS } = require('./live/model');
const {
  ensureShip, spawnDrone, setLocal, ensureProviderShip, addPending, clearPending, departIdleShips,
} = require('./live/ships');
const { addBuild } = require('./live/builds');
const { pollProviderFile, applyProviderSignals } = require('./live/provider-records');
const { pollClaudeFile, parseLine } = require('./live/claude-records');
const { scanClaude, readCwd } = require('./live/claude-source');
const { scanCodex } = require('./live/codex-source');
const { scanSignals } = require('./live/signal-source');

/**
 * @import { Attention, FeedEntry, PlanetData, Project, Ship, ShipStatus, SystemData }
 *   from '../types/contract'
 * @import { LiveProject, LiveShip } from '../types/live-model'
 * @import { ClaudeMessage, ClaudeSession, ClaudeToolStart } from './transcripts/claude'
 */

const DEFAULT_CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const DEFAULT_CODEX_SESSION_DIRS = [
  path.join(os.homedir(), '.codex', 'sessions'),
  path.join(os.homedir(), '.codex', 'archived_sessions'),
];

const SCAN_INTERVAL_MS = 3000;   // discover new projects / session files
const POLL_INTERVAL_MS = 1000;   // tail active session files
const TICK_INTERVAL_MS = 5000;   // ship departure sweep

class Tracker extends EventEmitter {
  constructor(statePath, options = {}) {
    super();
    this.statePath = statePath;
    this.claudeProjectsDir = options.claudeProjectsDir || DEFAULT_CLAUDE_PROJECTS_DIR;
    this.codexSessionDirs = options.codexSessionsDir
      ? [options.codexSessionsDir]
      : options.codexSessionDir
        ? [options.codexSessionDir]
        : Array.isArray(options.codexSessionDirs)
          ? options.codexSessionDirs.slice()
          : DEFAULT_CODEX_SESSION_DIRS.slice();
    this.providerConfigPath = options.providerConfigPath ||
      process.env.AGENT_UNIVERSE_PROVIDER_CONFIG ||
      path.join(path.dirname(statePath), 'providers.json');
    /** @type {Map<string, LiveProject>} */
    this.projects = new Map();   // slug -> project record
    this.files = new Map();      // abs jsonl path -> tail state
    this.claudeTails = new Map(); // abs Claude jsonl path -> its tail, kept while cold
    /** @type {Map<string, LiveShip>} */
    this.ships = new Map();      // shipId -> ship record
    /** @type {FeedEntry[]} */
    this.feed = [];              // ring buffer of recent feed entries
    this.shipCounter = 0;
    this.persisted = loadState(statePath);
    this.pathIds = Object.assign(Object.create(null), this.persisted.pathIds || {});
    this.pathOverrides = Object.create(null);
    for (const [projectId, projectPath] of Object.entries(this.persisted.pathOverrides || {})) {
      if (typeof projectId === 'string' && projectId && typeof projectPath === 'string' &&
          path.isAbsolute(projectPath)) {
        this.pathOverrides[projectId] = path.normalize(projectPath);
      }
    }
    this.projectPathIndex = new Map();
    this.codexTailsBySession = new Map();
    this.codexMetaCache = new Map();
    this.signalFiles = new Map();
    this.providerWarnings = new Set();
    this.providerCounters = new Map();
    this.systemCache = new Map(); // slug -> {at, planets}
    this.pending = [];           // event batch flushed once per poll
    this.pendingIndex = new Map(); // toolUseId -> shipId
    this.eventSequence = 0;      // additive event cursor for snapshot reconciliation
    this.publish = (batch) => this.emit('events', batch);
    this.timers = [];
  }

  // ---------- lifecycle ----------

  start() {
    this.scan(true);
    this.timers.push(setInterval(() => this.scan(false), SCAN_INTERVAL_MS));
    this.timers.push(setInterval(() => this.pollFiles(), POLL_INTERVAL_MS));
    this.timers.push(setInterval(() => this.sweepShips(), TICK_INTERVAL_MS));
    this.timers.push(setInterval(() => this.saveState(), 60000));
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.saveState();
  }

  saveState(throwOnError = false) {
    return saveState(this, throwOnError);
  }

  // ---------- discovery ----------

  scan(isStartup) {
    scanClaude(this, isStartup);
    scanCodex(this, isStartup);
    scanSignals(this, isStartup);
    refreshProjectExistence(this);
    flush(this);
  }

  remapProjectPath(projectId, nextPath) {
    return remapProjectPath(this, projectId, nextPath);
  }

  ensureProjectForPath(projectPath, fallbackId, activity, totalBytes = 0) {
    return ensureProjectForPath(this, projectPath, fallbackId, activity, totalBytes);
  }

  preferredProjectPath(projectId, discoveredPath) {
    return preferredProjectPath(this, projectId, discoveredPath);
  }

  scanSignals(isStartup) {
    scanSignals(this, isStartup);
  }

  readCwd(file) {
    return readCwd(file);
  }

  // ---------- tailing ----------

  pollFiles() {
    const now = Date.now();
    for (const [fp, tail] of this.files) {
      let st;
      try {
        st = fs.statSync(fp);
      } catch {
        this.files.delete(fp);
        this.claudeTails.delete(fp);
        continue;
      }
      if (now - st.mtimeMs > HOT_WINDOW_MS) {
        this.files.delete(fp);
        continue;
      }
      if (tail.provider && tail.provider !== 'claude') {
        pollProviderFile(this, fp, tail, st);
        continue;
      }
      pollClaudeFile(this, fp, tail, st);
    }
    evaluateAttention(this, now);
    flush(this);
  }

  applyProviderSignals(signals, tail) {
    applyProviderSignals(this, signals, tail);
  }

  parseLine(line, tail) {
    parseLine(this, line, tail);
  }

  sweepShips() {
    const now = Date.now();
    evaluateAttention(this, now);
    departIdleShips(this, now);
    flush(this);
  }

  // ---------- derived views ----------

  /** @returns {{ projects: Project[], ships: Ship[], feed: FeedEntry[], eventSequence: number }} */
  snapshot() {
    return {
      projects: [...this.projects.values()].map(liveProject),
      ships: [...this.ships.values()].map(liveShip),
      feed: recentFeed(this),
      eventSequence: this.eventSequence,
    };
  }

  /**
   * @param {string} projectId
   * @returns {SystemData | null}
   */
  getSystem(projectId) {
    return getSystem(this, projectId);
  }

  /**
   * @param {string} projectId
   * @param {string} planetName
   * @returns {PlanetData | null}
   */
  getPlanet(projectId, planetName) {
    return getPlanet(this, projectId, planetName);
  }

  flush() {
    flush(this);
  }
}

module.exports = { Tracker, classifyAttention, deriveGalaxy };

// @ts-check
// Watches ~/.claude/projects transcript JSONL files and turns them into
// universe events: projects (solar systems), sessions (ships), tool calls
// (activity), file edits (planet growth). Zero-config: works with any
// terminal because Claude Code always writes transcripts there.
// The Tracker owns the timers and the public API; the work lives in src/main/live/.
'use strict';

const { snapshotHistogram } = require('./shared/build-histogram');

const fs = require('fs');
const { EventEmitter } = require('events');
const { deriveGalaxy } = require('./universe/galaxy');
const { liveProject, liveShip } = require('./universe/public-shape');
const { HOT_WINDOW_MS, createLiveModel } = require('./live/model');
const { flush, recentFeed } = require('./live/events');
const { classifyAttention, evaluateAttention } = require('./live/attention');
const { saveState } = require('./live/state-file');
const { getSystem, getPlanet } = require('./live/system-view');
const {
  refreshProjectExistence, preferredProjectPath, remapProjectPath, ensureProjectForPath,
  restoreRememberedProjects,
} = require('./live/projects');
const { departIdleShips } = require('./live/ships');
const { pollProviderFile, applyProviderSignals } = require('./live/provider-records');
const { pollClaudeFile, parseLine } = require('./live/claude-records');
const { scanClaude, readCwd } = require('./live/claude-source');
const { scanCodex } = require('./live/codex-source');
const { scanSignals } = require('./live/signal-source');

/**
 * @import { BuildHistogram, FeedEntry, PlanetData, Project, Ship, SystemData } from '../types/contract'
 * @import { LiveModel, LiveModelOptions } from '../types/live-model'
 */

const SCAN_INTERVAL_MS = 3000;   // discover new projects / session files
const POLL_INTERVAL_MS = 1000;   // tail active session files
const TICK_INTERVAL_MS = 5000;   // ship departure sweep
const SAVE_INTERVAL_MS = 60000;  // write universe-state.json

class Tracker extends EventEmitter {
  /**
   * @param {string} statePath
   * @param {LiveModelOptions} [options]
   */
  constructor(statePath, options = {}) {
    super();
    this.statePath = statePath;
    /** @type {LiveModel} */
    this.model = createLiveModel(statePath, options, (batch) => this.emit('events', batch));
    // Other main-process modules read these: the model's own Maps, never replaced.
    this.projects = this.model.projects;
    this.ships = this.model.ships;
    this.files = this.model.files;
    this.persisted = this.model.persisted;
    this.timers = [];
    restoreRememberedProjects(this.model);
  }

  // ---------- lifecycle ----------

  start() {
    this.scan(true);
    this.timers.push(setInterval(() => this.scan(false), SCAN_INTERVAL_MS));
    this.timers.push(setInterval(() => this.pollFiles(), POLL_INTERVAL_MS));
    this.timers.push(setInterval(() => this.sweepShips(), TICK_INTERVAL_MS));
    this.timers.push(setInterval(() => this.saveState(), SAVE_INTERVAL_MS));
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.saveState();
  }

  saveState(throwOnError = false) {
    return saveState(this.model, throwOnError);
  }

  // ---------- ticks ----------

  scan(isStartup) {
    scanClaude(this.model, isStartup);
    scanCodex(this.model, isStartup);
    scanSignals(this.model, isStartup);
    refreshProjectExistence(this.model);
    flush(this.model);
  }

  pollFiles() {
    const now = Date.now();
    for (const [fp, tail] of this.files) {
      let st;
      try {
        st = fs.statSync(fp);
      } catch {
        this.files.delete(fp);
        this.model.claudeTails.delete(fp);
        continue;
      }
      if (now - st.mtimeMs > HOT_WINDOW_MS) {
        this.files.delete(fp);
        continue;
      }
      if (tail.provider && tail.provider !== 'claude') pollProviderFile(this.model, fp, tail, st);
      else pollClaudeFile(this.model, fp, tail, st);
    }
    evaluateAttention(this.model, now);
    flush(this.model);
  }

  sweepShips() {
    const now = Date.now();
    evaluateAttention(this.model, now);
    departIdleShips(this.model, now);
    flush(this.model);
  }

  // ---------- views ----------

  /** @returns {{ projects: Project[], ships: Ship[], feed: FeedEntry[], eventSequence: number, buildHistogram: BuildHistogram }} */
  snapshot() {
    return {
      projects: [...this.projects.values()].map(liveProject),
      ships: [...this.ships.values()].map(liveShip),
      feed: recentFeed(this.model),
      eventSequence: this.model.eventSequence,
      buildHistogram: snapshotHistogram(this.model.buildHistogram, Date.now()),
    };
  }

  /**
   * @param {string} projectId
   * @returns {SystemData | null}
   */
  getSystem(projectId) {
    return getSystem(this.model, projectId);
  }

  /**
   * @param {string} projectId
   * @param {string} planetName
   * @returns {PlanetData | null}
   */
  getPlanet(projectId, planetName) {
    return getPlanet(this.model, projectId, planetName);
  }

  // ---------- projects ----------

  remapProjectPath(projectId, nextPath) {
    return remapProjectPath(this.model, projectId, nextPath);
  }

  ensureProjectForPath(projectPath, fallbackId, activity, totalBytes = 0) {
    return ensureProjectForPath(this.model, projectPath, fallbackId, activity, totalBytes);
  }

  preferredProjectPath(projectId, discoveredPath) {
    return preferredProjectPath(this.model, projectId, discoveredPath);
  }

  // ---------- single steps (path-safety tests, galaxy gate) ----------

  scanSignals(isStartup) {
    scanSignals(this.model, isStartup);
  }

  readCwd(file) {
    return readCwd(file);
  }

  applyProviderSignals(signals, tail) {
    applyProviderSignals(this.model, signals, tail);
  }

  parseLine(line, tail) {
    parseLine(this.model, line, tail);
  }

  flush() {
    flush(this.model);
  }
}

module.exports = { Tracker, classifyAttention, deriveGalaxy };

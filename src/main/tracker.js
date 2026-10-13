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
    this.scanCodex(isStartup);
    this.scanSignals(isStartup);
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

  scanCodex(isStartup) {
    const now = Date.now();
    const candidates = [];
    for (let priority = 0; priority < this.codexSessionDirs.length; priority++) {
      for (const fp of listFilesRecursive(this.codexSessionDirs[priority], '.jsonl')) {
        candidates.push({ fp, priority });
      }
    }
    candidates.sort((a, b) => a.priority - b.priority || a.fp.localeCompare(b.fp));
    const candidatePaths = new Set(candidates.map((item) => item.fp));

    const seenSessions = new Set();
    const totals = new Map();
    for (const { fp } of candidates) {
      const filenameSessionId = codexSessionIdFromFilename(fp) || path.basename(fp, '.jsonl');
      let st;
      try { st = fs.statSync(fp); } catch { continue; }
      const meta = this.readCodexMetadata(fp, filenameSessionId, st);
      if (!meta || !meta.cwd) continue;
      const projectKey = canonicalProjectPath(meta.cwd);
      if (!projectKey) continue;
      const sessionId = meta.sessionId || filenameSessionId;
      if (seenSessions.has(sessionId)) continue;
      seenSessions.add(sessionId);

      const fallbackId = `project:${hex8(projectKey)}`;
      const project = ensureProjectForPath(this, meta.cwd, fallbackId, st.mtimeMs, 0);
      if (!project) continue;
      totals.set(project.id, (totals.get(project.id) || 0) + st.size);
      if (st.mtimeMs > project.lastActivity) project.lastActivity = st.mtimeMs;

      if (now - st.mtimeMs > HOT_WINDOW_MS) continue;
      let tail = this.codexTailsBySession.get(sessionId);
      if (tail && tail.path !== fp) {
        this.files.delete(tail.path);
        tail.path = fp;
        tail.project = project.id;
        if (tail.offset > st.size) {
          tail.offset = 0;
          tail.remainder = Buffer.alloc(0);
          tail.catchup = true;
          tail.adapterState = createAdapterState('codex', {
            sessionId,
          });
        }
        this.files.set(fp, tail);
      } else if (!tail) {
        let adapterState = createAdapterState('codex', {
          sessionId,
        });
        if (isStartup) {
          const safeMetaLine = JSON.stringify({
            timestamp: meta.timestamp || st.mtimeMs,
            type: 'session_meta',
            payload: {
              id: sessionId, session_id: sessionId, cwd: meta.cwd,
              thread_source: meta.kind === 'drone' ? 'subagent' : 'user',
              ...(meta.parentSessionId ? { parent_thread_id: meta.parentSessionId } : {}),
            },
          });
          const primed = adaptLine('codex', safeMetaLine, adapterState, { lineOffset: 0, now: st.mtimeMs });
          if (primed && primed.state) adapterState = primed.state;
        }
        tail = {
          provider: 'codex', path: fp, project: project.id, session: sessionId,
          offset: isStartup ? st.size : 0,
          catchup: !isStartup,
          remainder: Buffer.alloc(0),
          adapterState,
          kind: meta.kind,
          parentSessionId: meta.parentSessionId || null,
          local: meta.local,
        };
        this.files.set(fp, tail);
        this.codexTailsBySession.set(sessionId, tail);
        if (isStartup && now - st.mtimeMs < ACTIVE_WINDOW_MS) {
          setLocal(this, ensureProviderShip(this, 'codex', project.id, sessionId, meta.kind, st.mtimeMs, meta.parentSessionId), meta.local);
        }
      } else {
        tail.project = project.id;
        this.files.set(fp, tail);
      }
    }

    for (const [projectId, bytes] of totals) {
      const project = this.projects.get(projectId);
      if (!project) continue;
      project.codexBytes = bytes;
      project.totalBytes = (project.claudeBytes || 0) + bytes;
    }
    for (const fp of this.codexMetaCache.keys()) {
      if (!candidatePaths.has(fp)) this.codexMetaCache.delete(fp);
    }
    for (const [sessionId, tail] of this.codexTailsBySession) {
      if (candidatePaths.has(tail.path)) {
        tail.missingScans = 0;
        continue;
      }
      tail.missingScans = (tail.missingScans || 0) + 1;
      if (tail.missingScans < 3) continue;
      this.files.delete(tail.path);
      this.codexTailsBySession.delete(sessionId);
    }
  }

  readCodexMetadata(fp, sessionId, stat) {
    const cached = this.codexMetaCache.get(fp);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.meta;
    const meta = readCodexOwnMetadata(fp, sessionId);
    this.codexMetaCache.set(fp, { size: stat.size, mtimeMs: stat.mtimeMs, meta });
    return meta;
  }

  scanSignals(isStartup) {
    const config = readGenericWatchConfig(this.providerConfigPath);
    for (const warning of config.warnings || []) {
      if (this.providerWarnings.has(warning)) continue;
      this.providerWarnings.add(warning);
      console.warn(`[providers] ${warning}`);
    }
    const now = Date.now();
    const seenFiles = new Set();
    for (const source of signalSources(config.watch || [])) {
      // Security follow-up: a UNC/device projectPath has no project key; skip it instead of fnv1a(null).
      const projectKey = canonicalProjectPath(source.projectPath);
      if (!projectKey) continue;
      for (const { fp, st } of watchedFiles(source)) {
        seenFiles.add(fp);
        const project = ensureProjectForPath(this, 
          source.projectPath,
          `project:${hex8(projectKey)}`,
          st.mtimeMs,
          0
        );
        if (!project || now - st.mtimeMs > HOT_WINDOW_MS) continue;
        const previous = this.signalFiles.get(fp);
        // Security follow-up: a POSIX file name containing `\` has no canonical key; hash the raw path instead.
        const sessionId = `${source.id}:${hex8(canonicalProjectPath(fp) || fp)}`;
        const changed = !previous || previous.size !== st.size || previous.mtimeMs !== st.mtimeMs;
        this.signalFiles.set(fp, { size: st.size, mtimeMs: st.mtimeMs, sessionId });
        // sweepShips departs a ship idle past the active window; docking one here would flap.
        if (now - st.mtimeMs > ACTIVE_WINDOW_MS) continue;
        const ship = ensureProviderShip(this, 'signal', project.id, sessionId, 'main', st.mtimeMs, null);
        if (!isStartup && changed) {
          ship.lastEvent = Math.max(ship.lastEvent, st.mtimeMs);
          ship.status = 'Working';
          ship.detail = null;
          queue(this, { type: 'ship-updated', ship: liveShip(ship) });
          queue(this, {
            type: 'activity', project: project.id, shipId: ship.id,
            tool: 'signal', status: 'Working', detail: null, ts: st.mtimeMs,
          });
        }
      }
    }
    for (const [fp, previous] of this.signalFiles) {
      if (seenFiles.has(fp)) continue;
      this.signalFiles.delete(fp);
      const shipId = `ship:generic:${previous.sessionId}`;
      const ship = this.ships.get(shipId);
      if (!ship) continue;
      this.ships.delete(shipId);
      queue(this, { type: 'ship-departed', shipId, ts: now });
      pushFeed(this, 'depart', `${ship.name} signal disappeared`, ship.project);
    }
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

function listFilesRecursive(root, extension) {
  const out = [];
  const queue = [root];
  while (queue.length) {
    const dir = queue.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const fp = path.join(dir, entry.name);
      if (entry.isDirectory()) queue.push(fp);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(extension)) out.push(fp);
    }
  }
  return out;
}

function readCodexOwnMetadata(file, sessionId) {
  try {
    const fd = fs.openSync(file, 'r');
    const size = Math.min(fs.fstatSync(fd).size, 256 * 1024);
    const buf = Buffer.alloc(size);
    const n = fs.readSync(fd, buf, 0, size, 0);
    fs.closeSync(fd);
    let fallback = null;
    for (const line of buf.toString('utf8', 0, n).split(/\r?\n/)) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const payload = record && record.payload;
      if (record.type !== 'session_meta' || !payload) continue;
      const session = codexRecordToSignals(record).find((item) => item.type === 'session');
      if (!session) continue;
      const recordSessionId = session.sessionId;
      const result = {
        sessionId: recordSessionId,
        cwd: session.cwd,
        parentSessionId: codexParentSessionId(payload),
        kind: session.kind,
        local: session.local,
        timestamp: session.ts || 0,
      };
      if (recordSessionId === sessionId) return result;
      if (!fallback) fallback = result;
    }
    const strictFilenameId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId);
    return strictFilenameId ? null : fallback;
  } catch { /* unreadable or locked sessions are retried on the next scan */ }
  return null;
}

module.exports = { Tracker, classifyAttention, deriveGalaxy };

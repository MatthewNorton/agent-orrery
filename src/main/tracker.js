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
const { proceduralSystem } = require('./universe/planets');
const { liveProject, liveShip } = require('./universe/public-shape');
const { createShipRecord } = require('./universe/ships');
const { queue, pushFeed, flush, recentFeed } = require('./live/events');
const { classifyAttention, evaluateAttention } = require('./live/attention');
const { loadState, saveState } = require('./live/state-file');

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
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;   // ship visible this long after last write
const HOT_WINDOW_MS = 15 * 60 * 1000;     // only files this fresh get tailed
const DRONE_TIMEOUT_MS = 15 * 60 * 1000;
const ATTENTION_LINGER_MS = 60 * 60 * 1000;

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.next', '.venv', 'venv', 'dist', 'build', 'out',
  'release', 'coverage', 'target', '__pycache__', '.idea', '.vscode', 'bin', 'obj',
]);

// Live reads a typed prompt, assistant blocks, or user blocks that answer no tool call as the
// agent working again. History has its own rule (historicalClaudeSignals).
/** @param {ClaudeMessage} message */
function resumesTurn(message) {
  return (message.user && message.prompt) ||
    (message.blocks && (message.assistant || (message.user && !message.toolResult)));
}

function trackerPathError(code, message) {
  const error = /** @type {NodeJS.ErrnoException} */ (new Error(message));
  error.code = code;
  return error;
}

function isProjectDirectory(projectPath) {
  // Security: transcript-derived paths reach the filesystem here on every scan.
  // Never stat a UNC or device path (forced SMB authentication), see isLocalProjectPath.
  if (!isLocalProjectPath(projectPath) || !path.isAbsolute(projectPath)) return false;
  try {
    return fs.statSync(projectPath).isDirectory();
  } catch {
    return false;
  }
}

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
    this.scanClaude(isStartup);
    this.scanCodex(isStartup);
    this.scanSignals(isStartup);
    this.refreshProjectExistence();
    flush(this);
  }

  refreshProjectExistence() {
    for (const project of this.projects.values()) {
      const exists = isProjectDirectory(project.path);
      if (exists === project.exists) continue;
      project.exists = exists;
      this.systemCache.delete(project.id);
      queue(this, { type: 'project-updated', project: liveProject(project) });
    }
  }

  scanClaude(isStartup) {
    let dirs;
    try {
      dirs = fs.readdirSync(this.claudeProjectsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      return; // no ~/.claude/projects yet
    }
    const now = Date.now();
    for (const d of dirs) {
      const slug = d.name;
      const dirPath = path.join(this.claudeProjectsDir, slug);
      let entries;
      try {
        entries = fs.readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      if (entries.length === 0) continue;

      let project = this.projects.get(slug);
      let totalBytes = 0;
      let newest = 0;
      let newestFile = null;
      const stats = [];
      for (const f of entries) {
        const fp = path.join(dirPath, f);
        let st;
        try { st = fs.statSync(fp); } catch { continue; }
        totalBytes += st.size;
        stats.push({ fp, st });
        if (st.mtimeMs > newest) { newest = st.mtimeMs; newestFile = fp; }
      }

      if (!project) {
        const discoveredPath = newestFile ? this.readCwd(newestFile) : null;
        const pathKey = canonicalProjectPath(discoveredPath);
        const mappedId = pathKey && (this.projectPathIndex.get(pathKey) || this.pathIds[pathKey]);
        if (mappedId) project = this.projects.get(mappedId);
        const projectId = project ? project.id : (mappedId || slug);
        const projPath = this.preferredProjectPath(projectId, discoveredPath);
        const saved = this.persisted.projects[projectId] || {};
        if (!project) {
          project = {
            id: projectId,
            path: projPath,
            name: projPath ? path.basename(projPath) : slug,
            exists: isProjectDirectory(projPath),
            lastActivity: newest,
            totalBytes,
            claudeBytes: totalBytes,
            codexBytes: 0,
            buckets: saved.buckets || {},
            totalBuilds: saved.totalBuilds || 0,
            firstSeen: saved.firstSeen || now,
          };
          this.projects.set(projectId, project);
          this.indexProjectPath(project);
          queue(this, { type: 'project-added', project: liveProject(project) });
          if (!isStartup) pushFeed(this, 'discover', `New system discovered: ${project.name}`, project.id);
        }
        if (pathKey) {
          this.projectPathIndex.set(pathKey, project.id);
          this.pathIds[pathKey] = project.id;
        }
      }
      project.claudeBytes = totalBytes;
      project.totalBytes = totalBytes + (project.codexBytes || 0);
      if (newest > project.lastActivity) project.lastActivity = newest;
      if (project.path) {
        const exists = isProjectDirectory(project.path);
        if (exists !== project.exists) {
          project.exists = exists;
          this.systemCache.delete(project.id);
          queue(this, { type: 'project-updated', project: liveProject(project) });
        }
      }

      // Tail any file fresh enough to matter; at startup, note where every file ends.
      for (const { fp, st } of stats) {
        const hot = now - st.mtimeMs <= HOT_WINDOW_MS;
        if (this.files.has(fp) || !(hot || isStartup)) continue;
        const tail = this.claudeTail(fp, project.id, st.size, isStartup);
        if (!hot) continue;
        this.files.set(fp, tail);
        if (isStartup && now - st.mtimeMs < ACTIVE_WINDOW_MS) {
          this.ensureShip(project.id, tail.session, false, st.mtimeMs);
        }
      }
    }
  }

  /**
   * A transcript keeps one tail for the whole run, so a session that goes cold and resumes
   * reads on from where it stopped. Startup doesn't replay history: it tails from the end. A
   * file appearing while we run (or replacing a longer one) is a new session: replay it from
   * zero in catchup mode so its ship materializes with correct state.
   * @param {string} fp
   * @param {string} projectId
   * @param {number} size
   * @param {boolean} isStartup
   */
  claudeTail(fp, projectId, size, isStartup) {
    const known = this.claudeTails.get(fp);
    if (known && known.offset <= size) return known;
    const tail = {
      provider: 'claude', project: projectId, session: path.basename(fp, '.jsonl'),
      offset: isStartup ? size : 0, catchup: !isStartup, remainder: '',
    };
    this.claudeTails.set(fp, tail);
    return tail;
  }

  indexProjectPath(project) {
    const key = canonicalProjectPath(project && project.path);
    if (!key) return;
    this.projectPathIndex.set(key, project.id);
    this.pathIds[key] = project.id;
  }

  preferredProjectPath(projectId, discoveredPath) {
    const override = this.pathOverrides[projectId];
    if (typeof override === 'string' && path.isAbsolute(override) && isLocalProjectPath(override)) {
      return path.normalize(override);
    }
    return isLocalProjectPath(discoveredPath) ? discoveredPath : null;
  }

  remapProjectPath(projectId, nextPath) {
    const project = this.projects.get(projectId);
    if (!project) throw trackerPathError('NOT_FOUND', 'project was not found');
    if (project.exists === true) {
      throw trackerPathError('NOT_MISSING', 'only missing project paths can be recovered');
    }
    if (typeof nextPath !== 'string' || !path.isAbsolute(nextPath)) {
      throw trackerPathError('INVALID', 'project path must be absolute');
    }

    let real;
    try {
      real = path.normalize(fs.realpathSync.native(nextPath));
      if (!fs.statSync(real).isDirectory()) {
        throw trackerPathError('INVALID', 'project path must be a directory');
      }
    } catch (error) {
      if (error && error.code === 'INVALID') throw error;
      throw trackerPathError('NOT_FOUND', 'project directory is unavailable');
    }

    const key = canonicalProjectPath(real);
    if (!key) throw trackerPathError('INVALID', 'project path is invalid');
    const owner = this.projectPathIndex.get(key) || this.pathIds[key];
    if (owner && owner !== projectId) {
      throw trackerPathError('IN_USE', 'project path is already assigned');
    }
    for (const other of this.projects.values()) {
      if (!other || other.id === projectId || !isProjectDirectory(other.path)) continue;
      try {
        if (canonicalProjectPath(fs.realpathSync.native(other.path)) === key) {
          throw trackerPathError('IN_USE', 'project path is already assigned');
        }
      } catch (error) {
        if (error && error.code === 'IN_USE') throw error;
      }
    }

    const previous = {
      path: project.path,
      name: project.name,
      exists: project.exists,
      hadOverride: Object.prototype.hasOwnProperty.call(this.pathOverrides, projectId),
      override: this.pathOverrides[projectId],
      hadIndex: this.projectPathIndex.has(key),
      indexOwner: this.projectPathIndex.get(key),
      hadPathId: Object.prototype.hasOwnProperty.call(this.pathIds, key),
      pathIdOwner: this.pathIds[key],
    };
    project.path = real;
    project.name = path.basename(real) || project.name;
    project.exists = true;
    this.pathOverrides[projectId] = real;
    this.projectPathIndex.set(key, projectId);
    this.pathIds[key] = projectId;
    this.systemCache.delete(projectId);
    try {
      this.saveState(true);
    } catch {
      project.path = previous.path;
      project.name = previous.name;
      project.exists = previous.exists;
      if (previous.hadOverride) this.pathOverrides[projectId] = previous.override;
      else delete this.pathOverrides[projectId];
      if (previous.hadIndex) this.projectPathIndex.set(key, previous.indexOwner);
      else this.projectPathIndex.delete(key);
      if (previous.hadPathId) this.pathIds[key] = previous.pathIdOwner;
      else delete this.pathIds[key];
      throw trackerPathError('FAILED', 'project path could not be saved');
    }
    const visible = liveProject(project);
    queue(this, { type: 'project-updated', project: visible });
    pushFeed(this, 'discover', `Project path recovered: ${project.name}`, projectId);
    flush(this);
    return visible;
  }

  ensureProjectForPath(projectPath, fallbackId, activity, totalBytes = 0) {
    // Security follow-up: canonicalProjectPath trims; trim here too so every later check sees the same path.
    if (typeof projectPath === 'string') projectPath = projectPath.trim();
    const key = canonicalProjectPath(projectPath);
    if (!key) return null;
    let id = this.projectPathIndex.get(key) || this.pathIds[key];
    if (!id) {
      const legacyClaudeId = String(projectPath).replace(/[^A-Za-z0-9]/g, '-');
      if (this.projects.has(legacyClaudeId) && !this.projects.get(legacyClaudeId).path) {
        id = legacyClaudeId;
      }
    }
    if (!id) {
      id = fallbackId || `project:${hex8(key)}`;
      if (this.projects.has(id) && canonicalProjectPath(this.projects.get(id).path) !== key) {
        id = `${id}:${hex8(key)}`;
      }
    }
    let project = this.projects.get(id);
    const preferredPath = this.preferredProjectPath(id, projectPath);
    if (!project) {
      const saved = this.persisted.projects[id] || {};
      project = {
        id,
        path: preferredPath,
        // Security follow-up: never hand a null path to path.basename (throws in the poll tick).
        name: preferredPath ? path.basename(preferredPath) || id : id,
        exists: isProjectDirectory(preferredPath),
        lastActivity: activity || 0,
        totalBytes,
        claudeBytes: 0,
        codexBytes: totalBytes,
        buckets: saved.buckets || {},
        totalBuilds: saved.totalBuilds || 0,
        firstSeen: saved.firstSeen || Date.now(),
      };
      this.projects.set(id, project);
      queue(this, { type: 'project-added', project: liveProject(project) });
    } else {
      let changed = false;
      // Security follow-up: only adopt a path that survived preferredProjectPath (never null).
      if (!project.path && preferredPath) {
        project.path = preferredPath;
        project.name = path.basename(preferredPath) || project.name;
        project.exists = isProjectDirectory(preferredPath);
        changed = true;
      }
      if (activity > project.lastActivity) project.lastActivity = activity;
      if (changed) queue(this, { type: 'project-updated', project: liveProject(project) });
    }
    this.projectPathIndex.set(key, id);
    this.pathIds[key] = id;
    return project;
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
      const project = this.ensureProjectForPath(meta.cwd, fallbackId, st.mtimeMs, 0);
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
          this.setLocal(this.ensureProviderShip('codex', project.id, sessionId, meta.kind, st.mtimeMs, meta.parentSessionId), meta.local);
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
        const project = this.ensureProjectForPath(
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
        const ship = this.ensureProviderShip('signal', project.id, sessionId, 'main', st.mtimeMs, null);
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

  // Reads the head of a transcript to find the project's real cwd.
  readCwd(file) {
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(32768);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const m = buf.toString('utf8', 0, n).match(/"cwd":"((?:[^"\\]|\\.)*)"/);
      if (m) {
        const cwd = JSON.parse(`"${m[1]}"`);
        return isLocalProjectPath(cwd) ? cwd : null;
      }
    } catch { /* unreadable head is fine */ }
    return null;
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
        this.pollProviderFile(fp, tail, st);
        continue;
      }
      if (st.size <= tail.offset) continue;
      let chunk;
      try {
        const fd = fs.openSync(fp, 'r');
        const len = st.size - tail.offset;
        const buf = Buffer.alloc(Math.min(len, 8 * 1024 * 1024));
        const n = fs.readSync(fd, buf, 0, buf.length, tail.offset);
        fs.closeSync(fd);
        chunk = buf.toString('utf8', 0, n);
        tail.offset += n;
      } catch {
        continue;
      }
      if (tail.discardOversized) {
        const newline = chunk.indexOf('\n');
        if (newline < 0) continue;
        chunk = chunk.slice(newline + 1);
        tail.discardOversized = false;
      }
      const text = tail.remainder + chunk;
      const lines = text.split('\n');
      tail.remainder = lines.pop();
      if (Buffer.byteLength(tail.remainder, 'utf8') > 1024 * 1024) {
        tail.remainder = '';
        tail.discardOversized = true;
      }
      for (const line of lines) {
        if (Buffer.byteLength(line, 'utf8') <= 1024 * 1024 && line.trim()) this.parseLine(line, tail);
      }
      if (tail.catchup && tail.offset >= st.size) tail.catchup = false;
    }
    evaluateAttention(this, now);
    flush(this);
  }

  pollProviderFile(fp, tail, st) {
    if (st.size < tail.offset) {
      tail.offset = 0;
      tail.remainder = Buffer.alloc(0);
      tail.catchup = true;
      tail.adapterState = createAdapterState(tail.provider, {
        sessionId: tail.session,
      });
    }
    if (st.size <= tail.offset) return;
    let chunk;
    const startOffset = tail.offset;
    try {
      const fd = fs.openSync(fp, 'r');
      const len = Math.min(st.size - tail.offset, 8 * 1024 * 1024);
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, tail.offset);
      fs.closeSync(fd);
      chunk = buf.subarray(0, n);
      tail.offset += n;
    } catch {
      return;
    }
    const touchedShip = this.ensureProviderShip(
      tail.provider, tail.project, tail.session,
      tail.kind || 'main', st.mtimeMs, tail.parentSessionId
    );
    if (touchedShip) touchedShip.lastEvent = Math.max(touchedShip.lastEvent, st.mtimeMs);
    const touchedProject = this.projects.get(tail.project);
    if (touchedProject && st.mtimeMs > touchedProject.lastActivity) touchedProject.lastActivity = st.mtimeMs;
    if (tail.discardOversized) {
      const newline = chunk.indexOf(0x0a);
      if (newline < 0) return;
      chunk = chunk.subarray(newline + 1);
      tail.discardOversized = false;
    }
    const split = splitCompleteLines(
      Buffer.isBuffer(tail.remainder) ? tail.remainder : Buffer.from(tail.remainder || ''),
      chunk
    );
    tail.remainder = split.remainder.length <= 1024 * 1024 ? split.remainder : Buffer.alloc(0);
    if (split.remainder.length > 1024 * 1024) tail.discardOversized = true;
    let lineOffset = startOffset;
    for (const line of split.lines) {
      if (line.length > 1024 * 1024) {
        lineOffset += line.length + 1;
        continue;
      }
      const result = adaptLine(tail.provider, line.toString('utf8'), tail.adapterState, {
        lineOffset, now: st.mtimeMs,
      });
      if (result && result.state) tail.adapterState = result.state;
      this.applyProviderSignals(result && Array.isArray(result.signals) ? result.signals : [], tail);
      lineOffset += line.length + 1;
    }
    if (tail.catchup && tail.offset >= st.size) tail.catchup = false;
  }

  applyProviderSignals(signals, tail) {
    for (const signal of signals) {
      if (!signal || typeof signal !== 'object') continue;
      const dedupeKey = signal.key ||
        ((signal.type === 'build-files' || signal.type === 'build')
          ? `build:${signal.callId || fnv1a(JSON.stringify([signal.ts, signal.files || []])).toString(16)}`
          : null);
      if (dedupeKey) {
        tail.seenSignals = tail.seenSignals || new Set();
        if (tail.seenSignals.has(dedupeKey)) continue;
        tail.seenSignals.add(dedupeKey);
        while (tail.seenSignals.size > 2048) tail.seenSignals.delete(tail.seenSignals.values().next().value);
      }
      const provider = normalizeProvider(signal.provider || tail.provider);
      const sessionId = signal.sessionId || tail.session;
      const ts = Number.isFinite(signal.ts) ? signal.ts : Date.now();

      if (signal.type === 'session' || signal.type === 'project') {
        // Security follow-up: UNC/relative cwds have no project key; skip the association, never fnv1a(null).
        const projectKey = signal.cwd ? canonicalProjectPath(signal.cwd) : null;
        if (projectKey) {
          const project = this.ensureProjectForPath(
            signal.cwd,
            `project:${hex8(projectKey)}`,
            ts,
            0
          );
          if (project) tail.project = project.id;
        }
        if (typeof signal.local === 'boolean') tail.local = signal.local;
        if (tail.project) {
          this.setLocal(this.ensureProviderShip(
            provider, tail.project, sessionId,
            signal.kind || tail.kind || 'main', ts,
            signal.parentSessionId || tail.parentSessionId
          ), tail.local);
        }
        continue;
      }

      const ship = this.ensureProviderShip(
        provider, tail.project, sessionId,
        signal.kind || tail.kind || 'main', ts,
        signal.parentSessionId || tail.parentSessionId
      );
      if (!ship) continue;
      this.setLocal(ship, tail.local);
      ship.lastEvent = Math.max(ship.lastEvent, ts);

      if (signal.type === 'task-claim') {
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(signal.taskId || '')) {
          ship.taskId = signal.taskId.toLowerCase();
          queue(this, { type: 'ship-updated', ship: liveShip(ship) });
        }
      } else if (signal.type === 'turn-start') {
        ship.turnDone = false;
        ship.turnOutcome = 'running';
        ship.status = 'Working';
        ship.detail = null;
        queue(this, { type: 'ship-updated', ship: liveShip(ship) });
      } else if (signal.type === 'turn-done' || signal.type === 'turn-complete' || signal.type === 'turn-end') {
        ship.turnDone = true;
        ship.turnOutcome = 'completed';
        ship.detail = null;
        queue(this, { type: 'ship-updated', ship: liveShip(ship) });
      } else if (signal.type === 'turn-aborted') {
        ship.turnDone = false;
        ship.turnOutcome = 'aborted';
        ship.status = 'Working';
        ship.detail = null;
        queue(this, { type: 'ship-updated', ship: liveShip(ship) });
      } else if (signal.type === 'tool-use' || signal.type === 'tool-start') {
        const pendingId = `${provider}:${sessionId}:${signal.id || signal.callId || signal.key || ts}`;
        const classified = classifyTool(signal.tool);
        const tool = classified.tool;
        ship.status = signal.status || classified.status;
        ship.detail = null;
        ship.turnDone = false;
        this.addPending(ship, pendingId, tool, ts);
        queue(this, { type: 'ship-updated', ship: liveShip(ship) });
        if (!tail.catchup) {
          queue(this, {
            type: 'activity', project: ship.project, shipId: ship.id,
            tool, status: ship.status, detail: null, ts,
          });
        }
      } else if (signal.type === 'tool-result' || signal.type === 'tool-end') {
        const pendingId = `${provider}:${sessionId}:${signal.id || signal.callId || ''}`;
        this.clearPending(pendingId, ts);
      } else if (signal.type === 'build-files' || signal.type === 'build') {
        if (signal.success !== false) this.applyProviderBuildFiles(ship, signal.files, ts, tail.catchup);
      } else if (signal.type === 'activity' || signal.type === 'heartbeat' || signal.type === 'status') {
        if (signal.status) ship.status = signal.status;
        ship.detail = null;
        queue(this, { type: 'ship-updated', ship: liveShip(ship) });
        if (!tail.catchup && signal.type !== 'heartbeat') {
          queue(this, {
            type: 'activity', project: ship.project, shipId: ship.id,
            tool: signal.tool || 'Activity', status: ship.status, detail: null, ts,
          });
        }
      }
    }
  }

  clearPending(pendingId, ts) {
    const ownerId = this.pendingIndex.get(pendingId);
    if (!ownerId) return;
    const owner = this.ships.get(ownerId);
    if (owner) {
      owner.pending.delete(pendingId);
      owner.lastEvent = Math.max(owner.lastEvent, ts);
      queue(this, { type: 'ship-updated', ship: liveShip(owner) });
    }
    this.pendingIndex.delete(pendingId);
  }

  applyProviderBuildFiles(ship, files, ts, catchup) {
    const project = this.projects.get(ship.project);
    if (!project || !Array.isArray(files)) return;
    const seen = new Set();
    for (const item of files.slice(0, 64)) {
      const filePath = typeof item === 'string' ? item : (item && (item.movePath || item.path));
      const rel = relativeInside(project.path, filePath);
      if (!rel || seen.has(rel)) continue;
      seen.add(rel);
      this.addBuild(project, ship, rel, ts, catchup);
    }
  }

  // Counts an edit to a file inside the project; catchup counts it without announcing it.
  addBuild(project, ship, rel, ts, catchup) {
    const bucket = bucketOf(rel, path.sep);
    const isNew = countBuild(project, bucket);
    project.totalBuilds += 1;
    ship.builds += 1;
    this.systemCache.delete(project.id);
    if (catchup) return;
    queue(this, {
      type: 'build', project: project.id, bucket, file: rel,
      shipId: ship.id, isNew, ts,
    });
    if (isNew) pushFeed(this, 'form', `Planet formation started: ${bucket} in ${project.name}`, project.id);
    pushFeed(this, 'build', `${ship.name} building ${rel} in ${project.name}`, project.id);
  }

  addPending(ship, pendingId, tool, ts) {
    ship.pending.set(pendingId, { tool, ts });
    this.pendingIndex.set(pendingId, ship.id);
    while (ship.pending.size > 12) {
      const oldestId = ship.pending.keys().next().value;
      ship.pending.delete(oldestId);
      if (this.pendingIndex.get(oldestId) === ship.id) this.pendingIndex.delete(oldestId);
    }
  }

  parseLine(line, tail) {
    let record;
    try { record = JSON.parse(line); } catch { return; }
    const project = this.projects.get(tail.project);
    if (!project) return;
    // Live stamps an undated record with the time it was read.
    const parsedTs = record.timestamp ? Date.parse(record.timestamp) : NaN;
    const ts = Number.isFinite(parsedTs) ? parsedTs : Date.now();
    let ship = null;
    let message = null;
    for (const signal of claudeRecordToSignals(record)) {
      if (signal.type === 'session') {
        ship = this.applyClaudeSession(project, tail, signal, ts);
      } else if (signal.type === 'turn-end') {
        ship.turnDone = true;
      } else if (signal.type === 'message') {
        message = signal;
        if (resumesTurn(signal)) ship.turnDone = false;
        this.setLocal(ship, signal.local);
      } else if (signal.type === 'tool-start') {
        if (message.assistant && signal.callId) {
          // A tool_use id belongs to the ship that issued it last.
          const previousOwnerId = this.pendingIndex.get(signal.callId);
          if (previousOwnerId && previousOwnerId !== ship.id) {
            const previousOwner = this.ships.get(previousOwnerId);
            if (previousOwner) previousOwner.pending.delete(signal.callId);
          }
          this.addPending(ship, signal.callId, signal.tool, ts);
        }
        this.onToolUse(project, ship, signal, ts, tail.catchup);
      } else if (signal.type === 'tool-end' && signal.callId) {
        this.onToolResult(signal.callId, ts);
      }
    }
  }

  /**
   * @param {LiveProject} project
   * @param {{ project: string, session: string }} tail
   * @param {ClaudeSession} session
   * @param {number} ts
   * @returns {LiveShip}
   */
  applyClaudeSession(project, tail, session, ts) {
    if (!project.path && canonicalProjectPath(session.cwd)) {
      project.path = session.cwd;
      project.name = path.basename(session.cwd);
      project.exists = isProjectDirectory(session.cwd);
      this.indexProjectPath(project);
      this.systemCache.delete(project.id);
      queue(this, { type: 'project-updated', project: liveProject(project) });
    }
    if (ts > project.lastActivity) project.lastActivity = ts;
    const ship = this.ensureShip(tail.project, tail.session, session.kind === 'drone', ts);
    ship.lastEvent = Math.max(ship.lastEvent, ts);
    return ship;
  }

  /**
   * @param {LiveProject} project
   * @param {LiveShip} ship
   * @param {ClaudeToolStart} signal
   * @param {number} ts
   * @param {boolean} catchup
   */
  onToolUse(project, ship, signal, ts, catchup) {
    const tool = signal.tool || '?';
    const { status, build, spawn } = claudeTool(tool);
    ship.status = status;
    const rel = signal.filePath === null ? null : relativeInside(project.path, signal.filePath);
    ship.detail = signal.filePath === null ? signal.detail : rel || path.basename(signal.filePath);
    queue(this, { type: 'ship-updated', ship: liveShip(ship) });

    if (build && rel) {
      this.addBuild(project, ship, rel, ts, catchup);
    } else if (!catchup) {
      queue(this, {
        type: 'activity',
        project: project.id, shipId: ship.id, tool, status: ship.status, detail: ship.detail, ts,
      });
      if (spawn) {
        this.spawnDrone(project, ship, signal.callId, ts);
      } else if (Math.random() < 0.12) {
        // Sample non-build activity into the feed so it stays readable.
        pushFeed(this, 'info', `${ship.name} ${ship.status.toLowerCase()} in ${project.name}`, project.id);
      }
    }
  }

  onToolResult(toolUseId, ts) {
    const ownerId = this.pendingIndex.get(toolUseId);
    if (ownerId) {
      const owner = this.ships.get(ownerId);
      if (owner) owner.pending.delete(toolUseId);
      this.pendingIndex.delete(toolUseId);
    }

    const droneId = `drone:${toolUseId}`;
    const drone = this.ships.get(droneId);
    if (drone) {
      this.ships.delete(droneId);
      queue(this, { type: 'ship-departed', shipId: droneId, ts });
      pushFeed(this, 'depart', `${drone.name} returned to ${drone.parentName}`, drone.project);
    }
  }

  spawnDrone(project, parent, toolUseId, ts) {
    if (!toolUseId) return;
    const id = `drone:${toolUseId}`;
    if (this.ships.has(id)) return;
    const drone = createShipRecord({
      id, name: `Claude-${++this.shipCounter}`, provider: 'claude', project: project.id, kind: 'drone',
      parentName: parent.name, lastEvent: ts, local: parent.local === true,
    });
    this.ships.set(id, drone);
    queue(this, { type: 'ship-spawned', ship: liveShip(drone) });
    pushFeed(this, 'spawn', `${parent.name} launched ${drone.name} in ${project.name}`, project.id);
  }

  ensureShip(projectId, session, sidechain, ts) {
    const id = `ship:${projectId}:${session}`;
    let ship = this.ships.get(id);
    if (!ship) {
      const project = this.projects.get(projectId);
      ship = createShipRecord({
        id, name: `Claude-${++this.shipCounter}`, provider: 'claude', project: projectId,
        kind: sidechain ? 'drone' : 'main', lastEvent: ts,
      });
      this.ships.set(id, ship);
      queue(this, { type: 'ship-spawned', ship: liveShip(ship) });
      pushFeed(this, 'spawn', `${ship.name} entered ${project ? project.name : projectId}`, projectId);
    }
    return ship;
  }

  /**
   * Records whether a ship runs a local model, learned from its transcript, and announces a change.
   * @param {LiveShip | null} ship
   * @param {unknown} local
   */
  setLocal(ship, local) {
    if (!ship || typeof local !== 'boolean' || ship.local === local) return;
    ship.local = local;
    queue(this, { type: 'ship-updated', ship: liveShip(ship) });
  }

  ensureProviderShip(providerValue, projectId, sessionId, kind, ts, parentSessionId) {
    const provider = normalizeProvider(providerValue);
    if (!projectId || !sessionId || !this.projects.has(projectId)) return null;
    const id = `ship:${provider}:${sessionId}`;
    let ship = this.ships.get(id);
    if (!ship) {
      const labels = { claude: 'Claude', codex: 'Codex', signal: 'Signal' };
      const next = (this.providerCounters.get(provider) || 0) + 1;
      this.providerCounters.set(provider, next);
      const parent = parentSessionId ? this.ships.get(`ship:${provider}:${parentSessionId}`) : null;
      ship = createShipRecord({
        id, name: `${labels[provider] || 'Signal'}-${next}`, provider, project: projectId,
        kind: kind === 'drone' ? 'drone' : 'main', parentName: parent ? parent.name : null, lastEvent: ts,
      });
      this.ships.set(id, ship);
      queue(this, { type: 'ship-spawned', ship: liveShip(ship) });
      const project = this.projects.get(projectId);
      pushFeed(this, 'spawn', `${ship.name} entered ${project ? project.name : projectId}`, projectId);
    } else {
      ship.project = projectId;
      if (kind === 'drone') ship.kind = 'drone';
    }
    return ship;
  }

  sweepShips() {
    const now = Date.now();
    evaluateAttention(this, now);
    for (const [id, ship] of this.ships) {
      const needsAttention = ship.attention === 'question' || ship.attention === 'permission';
      if (ship.kind !== 'drone' && needsAttention && now - ship.lastEvent <= ATTENTION_LINGER_MS) {
        continue;
      }
      const timeout = ship.kind === 'drone' ? DRONE_TIMEOUT_MS : ACTIVE_WINDOW_MS;
      if (now - ship.lastEvent > timeout) {
        for (const toolUseId of ship.pending.keys()) {
          if (this.pendingIndex.get(toolUseId) === id) this.pendingIndex.delete(toolUseId);
        }
        this.ships.delete(id);
        queue(this, { type: 'ship-departed', shipId: id, ts: now });
        pushFeed(this, 'depart', `${ship.name} warped out`, ship.project);
      }
    }
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

  // Planets = top-level directories of the real project on disk, sized by a
  // shallow file count, enriched by accumulated build counts. Missing paths
  // (deleted/temp projects) get deterministic procedural planets instead.
  /**
   * @param {string} projectId
   * @returns {SystemData | null}
   */
  getSystem(projectId) {
    const project = this.projects.get(projectId);
    if (!project) return null;
    const cached = this.systemCache.get(projectId);
    if (cached && Date.now() - cached.at < 30000) return cached.data;

    let planets = [];
    let beltDensity = 0;
    if (project.path && project.exists) {
      try {
        const entries = fs.readdirSync(project.path, { withFileTypes: true });
        beltDensity = entries.filter((e) => e.isFile()).length;
        const dirs = entries.filter(
          (e) => e.isDirectory() && !IGNORE_DIRS.has(e.name) && !e.name.startsWith('.')
        );
        planets = dirs.map((d) => ({
          name: d.name,
          files: shallowCount(path.join(project.path, d.name)),
          builds: bucketBuilds(project, d.name),
        }));
        if (project.buckets['(root)']) {
          planets.push({ name: '(root)', files: beltDensity, builds: project.buckets['(root)'] });
        }
        planets.sort((a, b) => b.files + b.builds * 5 - (a.files + a.builds * 5));
        planets = planets.slice(0, 8);
      } catch { /* fall through to procedural */ }
    }
    if (planets.length === 0) ({ planets, beltDensity } = proceduralSystem(projectId));
    const data = { project: liveProject(project), planets, beltDensity };
    this.systemCache.set(projectId, { at: Date.now(), data });
    return data;
  }

  // Planet close-up stats: honest numbers under fantasy labels.
  /**
   * @param {string} projectId
   * @param {string} planetName
   * @returns {PlanetData | null}
   */
  getPlanet(projectId, planetName) {
    const project = this.projects.get(projectId);
    if (!project) return null;
    const base = {
      name: planetName,
      project: liveProject(project),
      // Security follow-up: own keys only; 'constructor'/'__proto__' must not return a non-cloneable prototype value.
      builds: bucketBuilds(project, planetName),
    };
    if (!project.path || !project.exists || planetName.startsWith('Sector-')) {
      const rand = mulberry32(fnv1a(projectId + planetName));
      return { ...base, files: Math.floor(rand() * 200), sizeKb: Math.floor(rand() * 4000), subdirs: Math.floor(rand() * 9), resources: ['Unknown'], procedural: true };
    }
    // Security: planetName arrives over IPC. Only a single plain directory segment
    // is a planet; anything with separators or dot-segments could walk outside the project.
    if (planetName !== '(root)' && !isPlanetSegment(planetName)) return null;
    const dir = planetName === '(root)' ? project.path : path.join(project.path, planetName);
    if (planetName !== '(root)' && relativeInside(project.path, dir) === null) return null;
    let files = 0, sizeKb = 0, subdirs = 0;
    const exts = new Map();
    try {
      const walk = (d, depth) => {
        const entries = fs.readdirSync(d, { withFileTypes: true });
        for (const e of entries) {
          if (files > 600) return;
          if (e.isDirectory()) {
            if (IGNORE_DIRS.has(e.name) || e.name.startsWith('.')) continue;
            if (depth === 0) subdirs++;
            if (depth < 2) walk(path.join(d, e.name), depth + 1);
          } else {
            if (planetName === '(root)' && depth !== 0) continue;
            files++;
            const ext = path.extname(e.name).slice(1).toUpperCase() || 'MISC';
            exts.set(ext, (exts.get(ext) || 0) + 1);
            try { sizeKb += Math.round(fs.statSync(path.join(d, e.name)).size / 1024); } catch { /* ignore */ }
          }
        }
      };
      walk(dir, 0);
    } catch { /* partial data is fine */ }
    const resources = [...exts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k]) => k);
    return { ...base, files, sizeKb, subdirs, resources };
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

function isPlanetSegment(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 255 &&
    value !== '.' && value !== '..' && !/[\\/\0]/.test(value);
}

function shallowCount(dir) {
  let count = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (count > 400) break;
      if (e.isFile()) count++;
      else if (e.isDirectory() && !IGNORE_DIRS.has(e.name) && !e.name.startsWith('.')) {
        try {
          count += fs.readdirSync(path.join(dir, e.name)).length;
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  return count;
}

module.exports = { Tracker, classifyAttention, deriveGalaxy };

'use strict';

// Historical transcript playback. ReplaySource is deliberately independent of
// Tracker: it never starts live watchers, writes persistent state, opens a
// process, or exposes transcript contents. Only structural transcript facts
// cross this module's public boundary.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const {
  adaptLine,
  canonicalProjectPath,
  isLocalProjectPath,
  classifyTool,
  codexRecordToSignals,
  codexSessionIdFromFilename,
  createAdapterState,
} = require('./provider-adapters');
const { claudeRecordToSignals } = require('./transcripts/claude');

const DEFAULT_CLAUDE_ROOT = path.join(os.homedir(), '.claude', 'projects');
const DEFAULT_CODEX_ROOTS = [
  path.join(os.homedir(), '.codex', 'sessions'),
  path.join(os.homedir(), '.codex', 'archived_sessions'),
];

const INDEX_BLOCK_BYTES = 256 * 1024;
const STREAM_READ_CHUNK_BYTES = 16 * 1024;
const MAX_OPEN_STREAM_HANDLES = 64;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_FILES = 50000;
const MAX_BATCH = 256;
const FEED_LIMIT = 60;
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
const DRONE_WINDOW_MS = 15 * 60 * 1000;
const MIN_TIMESTAMP_MS = Date.UTC(2000, 0, 1);
const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;

const DEFAULT_SCHEDULER = Object.freeze({
  setTimeout: (fn, delay) => setTimeout(fn, delay),
  clearTimeout: (timer) => clearTimeout(timer),
});

class ReplaySource extends EventEmitter {
  constructor(options = {}) {
    super();
    const roots = options.roots && typeof options.roots === 'object' ? options.roots : {};
    this.claudeProjectsDir = firstString(
      options.claudeProjectsDir,
      options.claudeRoot,
      roots.claudeProjectsDir,
      roots.claude,
      DEFAULT_CLAUDE_ROOT
    );

    const suppliedCodexRoots = firstArray(
      options.codexSessionDirs,
      options.codexRoots,
      roots.codexSessionDirs,
      roots.codex
    );
    if (suppliedCodexRoots) {
      this.codexSessionDirs = suppliedCodexRoots.filter(isNonemptyString).map((item) => path.resolve(item));
    } else {
      const active = firstString(
        options.codexSessionsDir,
        options.codexSessionDir,
        options.codexActiveRoot,
        roots.codexSessionsDir,
        roots.codexActive
      );
      const archived = firstString(
        options.codexArchivedSessionsDir,
        options.codexArchiveRoot,
        roots.codexArchivedSessionsDir,
        roots.codexArchive
      );
      this.codexSessionDirs = active || archived
        ? [active, archived].filter(Boolean).map((item) => path.resolve(item))
        : DEFAULT_CODEX_ROOTS.slice();
    }

    this.now = typeof options.now === 'function' ? options.now : Date.now;
    const scheduler = options.scheduler && typeof options.scheduler === 'object'
      ? options.scheduler : DEFAULT_SCHEDULER;
    this.scheduler = {
      setTimeout: typeof scheduler.setTimeout === 'function'
        ? scheduler.setTimeout.bind(scheduler) : DEFAULT_SCHEDULER.setTimeout,
      clearTimeout: typeof scheduler.clearTimeout === 'function'
        ? scheduler.clearTimeout.bind(scheduler) : DEFAULT_SCHEDULER.clearTimeout,
    };

    this.maxFiles = Math.min(MAX_FILES, positiveInteger(options.maxFiles, MAX_FILES));
    this.maxBatch = Math.min(MAX_BATCH, positiveInteger(options.maxBatch, MAX_BATCH));
    this.tickMs = positiveInteger(options.tickMs, 100);

    this._phase = 'idle';
    this._speed = 1;
    this._cursorMs = null;
    this._minMs = null;
    this._maxMs = null;
    this._partial = false;
    this._hasIndex = false;
    this._indexNow = finiteNow(this.now);
    this._indexEntries = [];
    this._preferredProjectIds = new Map();
    this._sourceCursors = new Map();
    this._lastDrainPeakRecords = 0;
    this._epoch = 0;
    this._timer = null;
    this._tickBusy = false;
    this._playWallStart = 0;
    this._playCursorStart = 0;
    this._resetModel();
  }

  /** Build a bounded file/time index. Raw lines and source paths stay private. */
  async index() {
    this._cancelPlayback();
    const token = ++this._epoch;
    await this._buildIndex(token);
    return this.status();
  }

  status() {
    return {
      mode: 'replay',
      available: this._hasIndex && this._minMs !== null && this._maxMs !== null,
      indexing: this._phase === 'indexing',
      minTs: this._minMs,
      maxTs: this._maxMs,
      cursorTs: this._cursorMs,
      playing: this._phase === 'playing',
      speed: this._speed,
      sourceCount: this._indexEntries.length,
      truncated: this._partial,
    };
  }

  /** Rebuild the deterministic universe at an absolute historical timestamp. */
  async seek(timestampMs) {
    this._cancelPlayback();
    const token = ++this._epoch;
    if (!this._hasIndex) await this._buildIndex(token);
    this._assertCurrent(token);

    const requested = parseTimestamp(timestampMs);
    if (requested === null) throw new TypeError('replay timestamp must be finite');
    const beforeRange = this._minMs !== null && requested < this._minMs;
    const target = this._clampTimestamp(requested);
    // Every seek owns fresh per-source cursors. This guarantees that a
    // backward scrub cannot retain a future record while keeping memory
    // bounded to the selected prefix rather than the whole history corpus.
    this._sourceCursors = new Map();
    this._resetModel();
    this._cursorMs = this._minMs;
    if (!beforeRange) {
      await this._advanceThrough(token, target, false);
    } else {
      this._cursorMs = target;
    }
    this._eventSequence = 0;
    this._pendingEvents = [];
    // A seek is an atomic scrub operation, never an implicit play/end action.
    this._phase = 'paused';
    this._emitState();
    return this.snapshot();
  }

  /** Advance forward; moving backward is defined as a deterministic seek. */
  async advanceTo(timestampMs, { emit = true } = {}) {
    if (!this._hasIndex) {
      const token = this._epoch;
      const preservePlaying = this._phase === 'playing';
      await this._buildIndex(token, { preservePlaying });
    }
    const token = this._epoch;
    const target = this._clampTimestamp(timestampMs);
    if (target === null) return this.snapshot();
    if (this._cursorMs !== null && target < this._cursorMs) return this.seek(target);
    await this._advanceThrough(token, target, emit !== false);
    if (this._maxMs !== null && target >= this._maxMs && this._phase === 'playing') {
      this._cancelTimer();
      this._phase = 'paused';
    }
    this._emitState();
    return this.snapshot();
  }

  play() {
    if (this._phase === 'stopped') return this.status();
    if (!this.status().available) {
      this._phase = 'paused';
      this._emitState();
      return this.status();
    }
    if (this._maxMs !== null && this._cursorMs !== null && this._cursorMs >= this._maxMs) {
      this._phase = 'paused';
      this._emitState();
      return this.status();
    }
    this._cancelTimer();
    const token = ++this._epoch;
    this._phase = 'playing';
    this._playWallStart = finiteNow(this.now);
    this._playCursorStart = this._cursorMs === null ? (this._minMs || 0) : this._cursorMs;
    this._emitState();
    this._scheduleTick(token, 0);
    return this.status();
  }

  pause() {
    if (this._phase === 'stopped') return this.status();
    if (this._phase === 'idle') return this.status();
    this._cancelPlayback();
    this._phase = 'paused';
    this._emitState();
    return this.status();
  }

  setSpeed(value) {
    const speed = Number(value);
    if (![1, 10, 100, 1000].includes(speed)) {
      throw new RangeError('replay speed must be 1, 10, 100, or 1000');
    }
    if (this._phase === 'playing') {
      this._playCursorStart = this._cursorMs === null ? (this._minMs || 0) : this._cursorMs;
      this._playWallStart = finiteNow(this.now);
    }
    this._speed = speed;
    this._emitState();
    return this.status();
  }

  snapshot() {
    return {
      projects: [...this._projects.values()].map(publicProject),
      ships: [...this._ships.values()].map(publicShip),
      feed: this._feed.slice(-FEED_LIMIT).map((entry) => ({ ...entry })),
      eventSequence: this._eventSequence,
    };
  }

  getSystem(projectId) {
    const project = this._projects.get(projectId);
    if (!project) return null;
    let planets = Object.entries(project.buckets)
      .map(([name, builds]) => ({ name, files: 0, builds }))
      .sort((a, b) => b.builds - a.builds || a.name.localeCompare(b.name))
      .slice(0, 8);
    if (planets.length === 0) planets = proceduralPlanets(projectId);
    return { project: publicProject(project), planets, beltDensity: 0 };
  }

  getPlanet(projectId, planetName) {
    const project = this._projects.get(projectId);
    if (!project || typeof planetName !== 'string') return null;
    const builds = project.buckets[planetName] || 0;
    const procedural = !Object.hasOwn(project.buckets, planetName);
    const rand = mulberry32(fnv1a(`${projectId}:${planetName}`));
    return {
      name: planetName,
      project: publicProject(project),
      builds,
      files: procedural ? Math.floor(rand() * 160) : 0,
      sizeKb: procedural ? Math.floor(rand() * 3200) : 0,
      subdirs: procedural ? Math.floor(rand() * 8) : 0,
      resources: procedural ? ['Unknown'] : [],
      procedural,
    };
  }

  stop() {
    this._cancelPlayback();
    this._phase = 'stopped';
    this._hasIndex = false;
    this._sourceCursors = new Map();
    this._indexEntries = [];
    this._preferredProjectIds = new Map();
    this._minMs = null;
    this._maxMs = null;
    this._cursorMs = null;
    this._resetModel();
    this._emitState();
  }

  async _buildIndex(token, { preservePlaying = false } = {}) {
    this._phase = 'indexing';
    this._hasIndex = false;
    this._indexNow = finiteNow(this.now);
    this._emitState();
    let entries = [];
    let partial = false;
    let inspectedCount = 0;

    for await (const item of iterateClaudeFiles(
      this.claudeProjectsDir, () => this._assertCurrent(token)
    )) {
      this._assertCurrent(token);
      const entry = await this._inspectClaudeFile(item.filePath, item.slug);
      if (entry) entries.push(entry);
      inspectedCount++;
      if (inspectedCount % 32 === 0) await new Promise((resolve) => setImmediate(resolve));
    }

    const codexBySession = new Map();
    for (let priority = 0; priority < this.codexSessionDirs.length; priority++) {
      for await (const filePath of iterateFilesRecursive(
        this.codexSessionDirs[priority], '.jsonl', () => this._assertCurrent(token)
      )) {
        this._assertCurrent(token);
        const entry = await this._inspectCodexFile(filePath, priority);
        inspectedCount++;
        if (inspectedCount % 32 === 0) await new Promise((resolve) => setImmediate(resolve));
        if (!entry) continue;
        const previous = codexBySession.get(entry.sessionId);
        if (!previous || priority < previous.priority ||
            (priority === previous.priority && filePath.localeCompare(previous.filePath) < 0)) {
          codexBySession.set(entry.sessionId, entry);
        }
      }
    }
    entries.push(...codexBySession.values());
    entries.sort((a, b) => b.endMs - a.endMs || b.startMs - a.startMs ||
      providerRank(a.provider) - providerRank(b.provider) || a.sourceKey.localeCompare(b.sourceKey));
    if (entries.length > this.maxFiles) {
      entries = entries.slice(0, this.maxFiles);
      partial = true;
    }
    entries.sort(compareIndexEntries);
    this._assertCurrent(token);
    this._indexEntries = entries;
    this._preferredProjectIds = new Map();
    for (const entry of entries) {
      if (entry.provider !== 'claude' || !entry.projectIdHint) continue;
      const key = canonicalProjectPath(entry.projectPath);
      if (key && !this._preferredProjectIds.has(key)) {
        this._preferredProjectIds.set(key, entry.projectIdHint);
      }
    }
    this._sourceCursors = new Map();
    this._partial = partial;
    this._minMs = entries.length ? Math.min(...entries.map((entry) => entry.startMs)) : null;
    this._maxMs = entries.length ? Math.max(...entries.map((entry) => entry.endMs)) : null;
    this._cursorMs = this._minMs;
    this._hasIndex = true;
    this._phase = preservePlaying ? 'playing' : 'paused';
    this._resetModel();
    if (preservePlaying) {
      this._playCursorStart = this._minMs || 0;
      this._playWallStart = finiteNow(this.now);
    }
    this._emitState();
  }

  async _inspectClaudeFile(filePath, slug) {
    const inspected = await inspectBlocks(filePath);
    if (!inspected) return null;
    let cwd = null;
    let startMs = null;
    for (const line of inspected.headLines) {
      const record = parseJsonLine(line);
      if (!record) continue;
      const ts = this._safeTimestamp(record.timestamp);
      if (ts !== null && startMs === null) startMs = ts;
      if (!cwd && safePath(record.cwd)) cwd = record.cwd.trim();
      if (cwd && startMs !== null) break;
    }
    if (!cwd || startMs === null) return null;
    let endMs = startMs;
    for (const line of inspected.tailLines) {
      const record = parseJsonLine(line);
      const ts = record ? this._safeTimestamp(record.timestamp) : null;
      if (ts !== null && ts > endMs) endMs = ts;
    }
    // Security follow-up: skip UNC/relative cwds instead of indexing a bogus `claude:null:<id>` source.
    const projectKey = canonicalProjectPath(cwd);
    if (!projectKey) return null;
    const sessionId = safeId(path.basename(filePath, '.jsonl')) || `claude-${fnv1a(filePath).toString(16)}`;
    return {
      provider: 'claude',
      sourceKey: `claude:${projectKey}:${sessionId}`,
      filePath,
      sessionId,
      projectPath: cwd,
      projectName: path.basename(cwd) || slug,
      projectIdHint: slug,
      kind: 'main',
      parentSessionId: null,
      startMs,
      endMs,
      size: inspected.size,
      priority: 0,
    };
  }

  async _inspectCodexFile(filePath, priority) {
    const inspected = await inspectBlocks(filePath);
    if (!inspected) return null;
    const filenameId = codexSessionIdFromFilename(filePath);
    let metadata = null;
    let startMs = null;
    for (const line of inspected.headLines) {
      const record = parseJsonLine(line);
      if (!record) continue;
      const ts = this._safeTimestamp(record.timestamp);
      if (ts !== null && startMs === null) startMs = ts;
      if (record.type !== 'session_meta') continue;
      const signal = codexRecordToSignals(record).find((item) => item.type === 'session');
      if (!signal) continue;
      if (filenameId && signal.sessionId.toLowerCase() !== filenameId.toLowerCase()) continue;
      const payload = record.payload && typeof record.payload === 'object' ? record.payload : {};
      metadata = {
        sessionId: signal.sessionId,
        cwd: signal.cwd,
        kind: signal.kind,
        parentSessionId: safeId(
          payload.parent_thread_id || payload.forked_from_id ||
          (payload.source && typeof payload.source === 'object'
            ? payload.source.parent_thread_id || payload.source.forked_from_id : null)
        ),
      };
      break;
    }
    if (!metadata || startMs === null) return null;
    let endMs = startMs;
    for (const line of inspected.tailLines) {
      const record = parseJsonLine(line);
      const ts = record ? this._safeTimestamp(record.timestamp) : null;
      if (ts !== null && ts > endMs) endMs = ts;
    }
    return {
      provider: 'codex',
      sourceKey: `codex:${metadata.sessionId}`,
      filePath,
      sessionId: metadata.sessionId,
      projectPath: metadata.cwd,
      projectName: path.basename(metadata.cwd) || metadata.sessionId,
      projectIdHint: null,
      kind: metadata.kind === 'drone' ? 'drone' : 'main',
      parentSessionId: metadata.parentSessionId,
      startMs,
      endMs,
      size: inspected.size,
      priority,
    };
  }

  _sourceCursor(entry) {
    let cursor = this._sourceCursors.get(entry.sourceKey);
    if (cursor) return cursor;
    cursor = {
      readOffset: 0,
      buffer: Buffer.alloc(0),
      bufferOffset: 0,
      discardingOversized: false,
      adapterState: entry.provider === 'codex'
        ? createAdapterState('codex', { filename: entry.filePath, sessionId: entry.sessionId })
        : null,
      claudeSessionEmitted: false,
      lastEffectiveTs: null,
      pendingRecords: [],
      blockedUntil: null,
      done: false,
      partial: false,
    };
    this._sourceCursors.set(entry.sourceKey, cursor);
    return cursor;
  }

  /**
   * Merge one next record per source and reduce it immediately. The heap is
   * bounded by source count, rather than by every record through the target.
   */
  async _advanceThrough(token, target, emit) {
    if (!Number.isFinite(target)) return;
    const heap = [];
    const handles = new Map();
    let partial = this._partial;
    let visited = 0;
    let processed = 0;
    this._lastDrainPeakRecords = 0;
    try {
      for (const entry of this._indexEntries) {
        this._assertCurrent(token);
        if (entry.startMs > target) break;
        const cursor = this._sourceCursor(entry);
        const record = await this._readNextRecord(entry, cursor, token, target, handles);
        partial ||= cursor.partial;
        if (record) {
          heapPush(heap, record);
          this._lastDrainPeakRecords = Math.max(this._lastDrainPeakRecords, heap.length);
        }
        visited++;
        if (visited % 128 === 0) {
          await new Promise((resolve) => setImmediate(resolve));
          this._assertCurrent(token);
        }
      }

      while (heap.length) {
        this._assertCurrent(token);
        const record = heapPop(heap);
        this._advanceLifecycle(record.ts, emit);
        this._applyRecord(record, emit);
        processed++;
        const cursor = this._sourceCursors.get(record.sourceKey);
        const next = await this._readNextRecord(
          record.entry, cursor, token, target, handles
        );
        partial ||= cursor.partial;
        if (next) {
          heapPush(heap, next);
          this._lastDrainPeakRecords = Math.max(this._lastDrainPeakRecords, heap.length);
        }
        if (processed % 2048 === 0) {
          await new Promise((resolve) => setImmediate(resolve));
          this._assertCurrent(token);
        }
      }
    } finally {
      await this._closeStreamHandles(handles);
    }
    this._assertCurrent(token);
    this._partial = partial;
    this._advanceLifecycle(target, emit);
    this._cursorMs = target;
    if (emit) this._flush();
  }

  async _readNextRecord(entry, cursor, token, target, handles) {
    if (!cursor || (cursor.done && cursor.pendingRecords.length === 0)) return null;
    let sliceBytes = 0;
    try {
      while (true) {
        this._assertCurrent(token);

        if (cursor.pendingRecords.length) {
          if (cursor.pendingRecords[0].ts > target) {
            return null;
          }
          const record = cursor.pendingRecords.shift();
          return record;
        }

        if (Number.isFinite(cursor.blockedUntil) && cursor.blockedUntil > target) return null;
        cursor.blockedUntil = null;

        if (cursor.discardingOversized) {
          const newline = cursor.buffer.indexOf(0x0a);
          if (newline >= 0) {
            cursor.buffer = Buffer.from(cursor.buffer.subarray(newline + 1));
            cursor.bufferOffset += newline + 1;
            cursor.discardingOversized = false;
          } else if (cursor.buffer.length) {
            cursor.bufferOffset += cursor.buffer.length;
            cursor.buffer = Buffer.alloc(0);
          }
        }

        const newline = cursor.discardingOversized ? -1 : cursor.buffer.indexOf(0x0a);
        if (newline >= 0) {
          let end = newline;
          if (end > 0 && cursor.buffer[end - 1] === 0x0d) end--;
          const line = cursor.buffer.subarray(0, end);
          const lineOffset = cursor.bufferOffset;
          cursor.buffer = Buffer.from(cursor.buffer.subarray(newline + 1));
          cursor.bufferOffset += newline + 1;
          if (line.length === 0) continue;
          if (line.length > MAX_LINE_BYTES) {
            cursor.partial = true;
            continue;
          }
          const parsed = this._parseHistoricalLine(
            entry, line, lineOffset, cursor.adapterState, cursor.claudeSessionEmitted
          );
          if (parsed.adapterState) cursor.adapterState = parsed.adapterState;
          if (parsed.claudeSessionEmitted) cursor.claudeSessionEmitted = true;
          for (let ordinal = 0; ordinal < parsed.signals.length; ordinal++) {
            const parsedSignal = parsed.signals[ordinal];
            const effectiveTs = cursor.lastEffectiveTs === null
              ? parsedSignal.ts : Math.max(cursor.lastEffectiveTs, parsedSignal.ts);
            cursor.lastEffectiveTs = effectiveTs;
            const signal = effectiveTs === parsedSignal.ts
              ? parsedSignal : { ...parsedSignal, ts: effectiveTs };
            cursor.pendingRecords.push({
              ts: signal.ts,
              provider: entry.provider,
              sourceKey: entry.sourceKey,
              offset: lineOffset,
              ordinal,
              entry,
              signal,
            });
          }
          if (parsed.signals.length === 0 && Number.isFinite(parsed.recordTs) &&
              parsed.recordTs > target) {
            cursor.blockedUntil = parsed.recordTs;
            return null;
          }
          continue;
        }

        if (cursor.buffer.length > MAX_LINE_BYTES) {
          cursor.bufferOffset += cursor.buffer.length;
          cursor.buffer = Buffer.alloc(0);
          cursor.discardingOversized = true;
          cursor.partial = true;
        }
        if (cursor.readOffset >= entry.size) {
          // The captured immutable range ended without another complete line.
          cursor.buffer = Buffer.alloc(0);
          cursor.done = true;
          return null;
        }
        const handle = await this._openStreamHandle(entry, cursor, handles);
        this._assertCurrent(token);
        const length = Math.min(STREAM_READ_CHUNK_BYTES, entry.size - cursor.readOffset);
        const chunk = Buffer.alloc(length);
        const readAt = cursor.readOffset;
        const { bytesRead } = await handle.read(chunk, 0, length, readAt);
        this._assertCurrent(token);
        if (bytesRead <= 0) {
          cursor.partial = true;
          cursor.done = true;
          return null;
        }
        if (cursor.buffer.length === 0) cursor.bufferOffset = readAt;
        const received = chunk.subarray(0, bytesRead);
        cursor.buffer = cursor.buffer.length
          ? Buffer.concat([cursor.buffer, received]) : Buffer.from(received);
        cursor.readOffset += bytesRead;
        sliceBytes += bytesRead;
        if (sliceBytes >= 8 * 1024 * 1024) {
          sliceBytes = 0;
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
    } catch (error) {
      if (error && error.code === 'ERR_REPLAY_CANCELLED') throw error;
      cursor.partial = true;
      cursor.done = true;
      return null;
    }
  }

  _releaseCursorBuffer(cursor) {
    if (!cursor || !cursor.buffer.length) return;
    cursor.readOffset = cursor.bufferOffset;
    cursor.buffer = Buffer.alloc(0);
  }

  async _openStreamHandle(entry, cursor, handles) {
    let stream = handles.get(entry.sourceKey);
    if (stream) {
      handles.delete(entry.sourceKey);
      handles.set(entry.sourceKey, stream);
      return stream.handle;
    }
    if (handles.size >= MAX_OPEN_STREAM_HANDLES) {
      const oldestKey = handles.keys().next().value;
      const oldest = handles.get(oldestKey);
      handles.delete(oldestKey);
      this._releaseCursorBuffer(oldest.cursor);
      try { await oldest.handle.close(); } catch { /* best-effort bounded handle pool */ }
    }
    const handle = await fs.promises.open(entry.filePath, 'r');
    stream = { handle, cursor };
    handles.set(entry.sourceKey, stream);
    return handle;
  }

  async _closeStreamHandles(handles) {
    const closing = [];
    for (const { handle, cursor } of handles.values()) {
      this._releaseCursorBuffer(cursor);
      closing.push(handle.close().catch(() => undefined));
    }
    handles.clear();
    await Promise.all(closing);
  }

  _parseHistoricalLine(entry, line, lineOffset, adapterState, claudeSessionEmitted) {
    const record = parseJsonLine(line);
    const ts = record ? this._safeTimestamp(record.timestamp) : null;
    if (!record || ts === null) {
      return { signals: [], adapterState, claudeSessionEmitted, recordTs: ts };
    }
    if (entry.provider === 'codex') {
      const adapted = adaptLine('codex', line.toString('utf8'), adapterState, {
        lineOffset,
        now: ts,
      });
      const signals = (adapted && Array.isArray(adapted.signals) ? adapted.signals : [])
        .filter((signal) => signal && Number.isFinite(signal.ts))
        .map((signal) => ({ ...signal, ts }));
      return {
        signals,
        adapterState: adapted && adapted.state ? adapted.state : adapterState,
        claudeSessionEmitted,
        recordTs: ts,
      };
    }
    return {
      signals: historicalClaudeSignals(entry, record, lineOffset, ts, claudeSessionEmitted),
      adapterState,
      claudeSessionEmitted: true,
      recordTs: ts,
    };
  }

  _applyRecord(record, emit) {
    const signal = record.signal;
    const runtime = this._runtimeBySource.get(record.sourceKey) || {
      provider: record.provider,
      sessionId: record.entry.sessionId,
      projectPath: record.entry.projectPath,
      kind: record.entry.kind,
      parentSessionId: record.entry.parentSessionId,
      projectIdHint: record.entry.projectIdHint,
      projectId: null,
    };
    if (signal.type === 'session') {
      runtime.sessionId = safeId(signal.sessionId) || runtime.sessionId;
      runtime.projectPath = safePath(signal.cwd) || runtime.projectPath;
      runtime.kind = signal.kind === 'drone' ? 'drone' : runtime.kind;
      runtime.parentSessionId = safeId(signal.parentSessionId) || runtime.parentSessionId;
    }
    const project = this._ensureProject(
      runtime.projectPath, record.ts, emit, runtime.projectIdHint
    );
    if (!project) return;
    runtime.projectId = project.id;
    this._runtimeBySource.set(record.sourceKey, runtime);
    const ship = this._ensureShip(runtime, record.ts, emit);
    if (!ship) return;
    ship.lastEvent = Math.max(ship.lastEvent, record.ts);
    if (record.ts > project.lastActivity) {
      project.lastActivity = record.ts;
      this._queue({ type: 'project-updated', project: publicProject(project) }, emit);
    }

    if (signal.type === 'session') return;
    if (signal.type === 'turn-start') {
      ship.turnDone = false;
      ship.status = 'Working';
      ship.detail = null;
      this._setAttention(ship, null, record.ts, emit);
      this._queue({ type: 'ship-updated', ship: publicShip(ship) }, emit);
      return;
    }
    if (signal.type === 'turn-end' || signal.type === 'turn-done' || signal.type === 'turn-complete') {
      ship.turnDone = true;
      ship.detail = null;
      this._queue({ type: 'ship-updated', ship: publicShip(ship) }, emit);
      return;
    }
    if (signal.type === 'turn-aborted') {
      ship.turnDone = false;
      ship.status = 'Working';
      ship.detail = null;
      this._setAttention(ship, null, record.ts, emit);
      this._queue({ type: 'ship-updated', ship: publicShip(ship) }, emit);
      return;
    }
    if (signal.type === 'tool-start' || signal.type === 'tool-use') {
      const classification = classifyTool(signal.tool);
      const callId = safeId(signal.callId || signal.id) ||
        `line-${record.offset.toString(16)}-${record.ordinal}`;
      const pendingId = `${runtime.provider}:${runtime.sessionId}:${callId}`;
      ship.pending.set(pendingId, { tool: classification.tool, ts: record.ts });
      ship.status = signal.status || classification.status;
      ship.turnDone = false;
      ship.detail = null;
      this._setAttention(ship, null, record.ts, emit);
      this._queue({ type: 'ship-updated', ship: publicShip(ship) }, emit);
      this._queue({
        type: 'activity', project: project.id, shipId: ship.id,
        tool: classification.tool, status: ship.status, detail: null, ts: record.ts,
      }, emit);
      if (runtime.provider === 'claude' &&
          (classification.tool === 'Agent' || classification.tool === 'Task')) {
        this._spawnClaudeDrone(project, ship, runtime.sessionId, callId, record.ts, emit);
      }
      return;
    }
    if (signal.type === 'tool-end' || signal.type === 'tool-result') {
      const callId = safeId(signal.callId || signal.id);
      if (!callId) return;
      const pendingId = `${runtime.provider}:${runtime.sessionId}:${callId}`;
      ship.pending.delete(pendingId);
      this._queue({ type: 'ship-updated', ship: publicShip(ship) }, emit);
      if (runtime.provider === 'claude') {
        const droneId = `drone:claude:${runtime.sessionId}:${callId}`;
        const drone = this._ships.get(droneId);
        if (drone) this._departShip(drone, record.ts, emit, 'returned');
      }
      return;
    }
    if ((signal.type === 'build' || signal.type === 'build-files') && signal.success !== false) {
      const callId = safeId(signal.callId || signal.id);
      const safeFiles = Array.isArray(signal.files)
        ? signal.files.map((value) => typeof value === 'string' ? value
          : value && typeof value === 'object' ? value.movePath || value.path || '' : '')
          .filter(Boolean).sort()
        : [];
      const buildKey = callId
        ? `${runtime.provider}:${runtime.sessionId}:${callId}`
        : `${runtime.provider}:${runtime.sessionId}:${record.ts}:${fnv1a(safeFiles.join('\n'))}`;
      if (this._seenBuildSignals.has(buildKey)) return;
      this._seenBuildSignals.add(buildKey);
      this._applyBuilds(project, ship, signal.files, record.ts, emit);
      return;
    }
    if (signal.type === 'activity' || signal.type === 'status' || signal.type === 'heartbeat') {
      ship.status = typeof signal.status === 'string' ? signal.status : 'Working';
      ship.detail = null;
      this._queue({ type: 'ship-updated', ship: publicShip(ship) }, emit);
      if (signal.type !== 'heartbeat') this._queue({
        type: 'activity', project: project.id, shipId: ship.id,
        tool: 'Activity', status: ship.status, detail: null, ts: record.ts,
      }, emit);
    }
  }

  _ensureProject(projectPath, ts, emit, projectIdHint) {
    const key = canonicalProjectPath(projectPath);
    if (!key) return null;
    let id = this._projectIdByPath.get(key);
    if (!id) {
      id = safeId(this._preferredProjectIds.get(key)) || safeId(projectIdHint) ||
        `project:${fnv1a(key).toString(16).padStart(8, '0')}`;
      if (this._projects.has(id) && canonicalProjectPath(this._projects.get(id).path) !== key) {
        id = `${id}-${fnv1a(key).toString(16)}`;
      }
    }
    let project = this._projects.get(id);
    if (!project) {
      project = {
        id,
        path: projectPath,
        name: path.basename(projectPath) || id,
        exists: safeExists(projectPath),
        firstSeen: ts,
        lastActivity: ts,
        totalBytes: 0,
        totalBuilds: 0,
        buckets: Object.create(null),
      };
      this._projects.set(id, project);
      this._projectIdByPath.set(key, id);
      this._queue({ type: 'project-added', project: publicProject(project) }, emit);
    }
    return project;
  }

  _ensureShip(runtime, ts, emit) {
    if (!runtime.projectId || !runtime.sessionId) return null;
    const id = runtime.provider === 'claude'
      ? `ship:${runtime.projectId}:${runtime.sessionId}`
      : `ship:${runtime.provider}:${runtime.sessionId}`;
    let ship = this._ships.get(id);
    if (!ship) {
      const number = (this._providerCounters.get(runtime.provider) || 0) + 1;
      this._providerCounters.set(runtime.provider, number);
      const parentId = runtime.parentSessionId
        ? `ship:${runtime.provider}:${runtime.parentSessionId}` : null;
      const parent = parentId ? this._ships.get(parentId) : null;
      ship = {
        id,
        name: `${runtime.provider === 'codex' ? 'Codex' : 'Claude'}-${number}`,
        provider: runtime.provider,
        project: runtime.projectId,
        kind: runtime.kind === 'drone' ? 'drone' : 'main',
        parentName: parent ? parent.name : null,
        status: 'Working',
        detail: null,
        lastEvent: ts,
        pending: new Map(),
        turnDone: false,
        attention: null,
        attentionSince: null,
      };
      this._ships.set(id, ship);
      this._queue({ type: 'ship-spawned', ship: publicShip(ship) }, emit);
      const project = this._projects.get(runtime.projectId);
      this._pushFeed('spawn', `${ship.name} entered ${project ? project.name : runtime.projectId}`,
        runtime.projectId, ts, emit);
    }
    return ship;
  }

  _spawnClaudeDrone(project, parent, sessionId, callId, ts, emit) {
    const id = `drone:claude:${sessionId}:${callId}`;
    if (this._ships.has(id)) return;
    const number = (this._providerCounters.get('claude') || 0) + 1;
    this._providerCounters.set('claude', number);
    const drone = {
      id,
      name: `Claude-${number}`,
      provider: 'claude',
      project: project.id,
      kind: 'drone',
      parentName: parent.name,
      status: 'Working',
      detail: null,
      lastEvent: ts,
      pending: new Map(),
      turnDone: false,
      attention: null,
      attentionSince: null,
    };
    this._ships.set(id, drone);
    this._queue({ type: 'ship-spawned', ship: publicShip(drone) }, emit);
    this._pushFeed('spawn', `${parent.name} launched ${drone.name} in ${project.name}`,
      project.id, ts, emit);
  }

  _applyBuilds(project, ship, files, ts, emit) {
    if (!Array.isArray(files)) return;
    const seen = new Set();
    for (const value of files.slice(0, 256)) {
      const filePath = typeof value === 'string' ? value
        : value && typeof value === 'object' ? value.movePath || value.path : null;
      const relative = relativeInside(project.path, filePath);
      if (!relative || seen.has(relative)) continue;
      seen.add(relative);
      const bucket = relative.includes('/') ? relative.split('/')[0] : '(root)';
      const isNew = !Object.hasOwn(project.buckets, bucket);
      project.buckets[bucket] = (project.buckets[bucket] || 0) + 1;
      project.totalBuilds++;
      this._queue({
        type: 'build', project: project.id, bucket, file: relative,
        shipId: ship.id, isNew, ts,
      }, emit);
      if (isNew) this._pushFeed('form',
        `Planet formation started: ${bucket} in ${project.name}`, project.id, ts, emit);
      this._pushFeed('build', `${ship.name} building ${relative} in ${project.name}`,
        project.id, ts, emit);
    }
  }

  _advanceLifecycle(now, emit) {
    const due = [];
    for (const ship of this._ships.values()) {
      // Historical observation never pages the user for old prompts.
      ship.attention = null;
      ship.attentionSince = null;
      const timeout = ship.kind === 'drone' ? DRONE_WINDOW_MS : ACTIVE_WINDOW_MS;
      const deadline = ship.lastEvent + timeout;
      if (now > deadline) due.push({ ship, deadline });
    }
    due.sort((a, b) => a.deadline - b.deadline || a.ship.id.localeCompare(b.ship.id));
    for (const item of due) {
      if (this._ships.get(item.ship.id) === item.ship) {
        this._departShip(item.ship, item.deadline, emit, 'expired');
      }
    }
  }

  _setAttention(ship, attention, ts, emit) {
    if (ship.attention === attention) return;
    ship.attention = attention;
    ship.attentionSince = attention ? ts : null;
    this._queue({ type: 'ship-updated', ship: publicShip(ship) }, emit);
    if (attention === 'done') {
      const project = this._projects.get(ship.project);
      this._pushFeed('done', `${ship.name} finished its task in ${project ? project.name : ship.project}`,
        ship.project, ts, emit);
    }
  }

  _departShip(ship, ts, emit, reason) {
    if (!this._ships.has(ship.id)) return;
    this._ships.delete(ship.id);
    this._queue({ type: 'ship-departed', shipId: ship.id, ts }, emit);
    const text = reason === 'returned' && ship.parentName
      ? `${ship.name} returned to ${ship.parentName}` : `${ship.name} warped out`;
    this._pushFeed('depart', text, ship.project, ts, emit);
  }

  _pushFeed(kind, text, projectId, ts, emit) {
    const entry = { kind, text, project: projectId, ts };
    this._feed.push(entry);
    if (this._feed.length > FEED_LIMIT) this._feed = this._feed.slice(-FEED_LIMIT);
    this._queue({ type: 'feed', entry: { ...entry } }, emit);
  }

  _queue(event, emit) {
    if (!emit) return;
    this._pendingEvents.push({ ...event, seq: ++this._eventSequence });
    if (this._pendingEvents.length >= this.maxBatch) this._flush();
  }

  _flush() {
    if (this._pendingEvents.length === 0) return;
    const batch = this._pendingEvents.splice(0, this.maxBatch);
    this.emit('events', batch);
    if (this._pendingEvents.length) this._flush();
  }

  _resetModel() {
    this._projects = new Map();
    this._projectIdByPath = new Map();
    this._ships = new Map();
    this._feed = [];
    this._runtimeBySource = new Map();
    this._providerCounters = new Map();
    this._seenBuildSignals = new Set();
    this._eventSequence = 0;
    this._pendingEvents = [];
  }

  _safeTimestamp(value) {
    const ts = parseTimestamp(value);
    const upper = this._indexNow + MAX_CLOCK_SKEW_MS;
    return ts !== null && ts >= MIN_TIMESTAMP_MS && ts <= upper ? ts : null;
  }

  _clampTimestamp(value) {
    if (this._minMs === null || this._maxMs === null) return null;
    const parsed = parseTimestamp(value);
    if (parsed === null) throw new TypeError('replay timestamp must be finite');
    return Math.max(this._minMs, Math.min(this._maxMs, parsed));
  }

  _emitState() {
    this.emit('state', this.status());
  }

  _scheduleTick(token, delay) {
    this._timer = this.scheduler.setTimeout(async () => {
      this._timer = null;
      if (token !== this._epoch || this._phase !== 'playing' || this._tickBusy) return;
      this._tickBusy = true;
      try {
        const wallNow = finiteNow(this.now);
        const elapsed = Math.max(0, wallNow - this._playWallStart);
        const target = this._playCursorStart + elapsed * this._speed;
        await this.advanceTo(target, { emit: true });
        // Parsing/render delivery time is backlog, not virtual history time.
        // Anchor the next delta only after this slice has completed.
        this._playCursorStart = this._cursorMs === null ? target : this._cursorMs;
        this._playWallStart = finiteNow(this.now);
      } catch (error) {
        if (!error || error.code !== 'ERR_REPLAY_CANCELLED') {
          this._phase = 'error';
          this._emitState();
        }
      } finally {
        this._tickBusy = false;
      }
      if (token === this._epoch && this._phase === 'playing') this._scheduleTick(token, this.tickMs);
    }, delay);
  }

  _cancelTimer() {
    if (this._timer !== null) this.scheduler.clearTimeout(this._timer);
    this._timer = null;
  }

  _cancelPlayback() {
    this._cancelTimer();
    this._epoch++;
  }

  _assertCurrent(token) {
    if (token !== this._epoch) {
      const error = new Error('replay operation cancelled');
      error.code = 'ERR_REPLAY_CANCELLED';
      throw error;
    }
  }
}

async function* iterateClaudeFiles(root, assertCurrent) {
  let directories;
  try { directories = await fs.promises.readdir(root, { withFileTypes: true }); }
  catch { return; }
  directories = directories.filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  let visited = 0;
  for (const directory of directories) {
    assertCurrent();
    let entries;
    try { entries = await fs.promises.readdir(path.join(root, directory.name), { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.jsonl')) continue;
      assertCurrent();
      yield { filePath: path.join(root, directory.name, entry.name), slug: directory.name };
      visited++;
      if (visited % 128 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
  }
}

async function* iterateFilesRecursive(root, extension, assertCurrent) {
  const pending = [root];
  let visited = 0;
  while (pending.length) {
    assertCurrent();
    const directory = pending.pop();
    let entries;
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); }
    catch { continue; }
    entries.sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(filePath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(extension)) {
        assertCurrent();
        yield filePath;
        visited++;
        if (visited % 128 === 0) await new Promise((resolve) => setImmediate(resolve));
      }
    }
  }
}

async function inspectBlocks(filePath) {
  let handle;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0) return null;
    const headSize = Math.min(stat.size, INDEX_BLOCK_BYTES);
    const tailStart = Math.max(0, stat.size - INDEX_BLOCK_BYTES);
    const tailSize = stat.size - tailStart;
    const head = Buffer.alloc(headSize);
    const tail = Buffer.alloc(tailSize);
    const headRead = await handle.read(head, 0, head.length, 0);
    const tailRead = tailStart === 0
      ? { bytesRead: headRead.bytesRead, buffer: head }
      : await handle.read(tail, 0, tail.length, tailStart);
    const headBuffer = head.subarray(0, headRead.bytesRead);
    const tailBuffer = tailStart === 0
      ? headBuffer : tail.subarray(0, tailRead.bytesRead);
    return {
      size: stat.size,
      headLines: completeLines(headBuffer, false),
      tailLines: completeLines(tailBuffer, tailStart > 0),
    };
  } catch {
    return null;
  } finally {
    if (handle) try { await handle.close(); } catch { /* raced with shutdown */ }
  }
}

function completeLines(buffer, dropFirst) {
  const output = [];
  let start = 0;
  if (dropFirst) {
    const newline = buffer.indexOf(0x0a);
    if (newline < 0) return output;
    start = newline + 1;
  }
  for (let index = start; index < buffer.length; index++) {
    if (buffer[index] !== 0x0a) continue;
    let end = index;
    if (end > start && buffer[end - 1] === 0x0d) end--;
    if (end > start && end - start <= MAX_LINE_BYTES) output.push(buffer.subarray(start, end));
    start = index + 1;
  }
  return output;
}

function parseJsonLine(line) {
  try {
    const value = JSON.parse(Buffer.isBuffer(line) ? line.toString('utf8') : String(line));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function parseTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * History's reading of one Claude record. The session is announced once per source, at its
 * indexed project path. A prompt, any assistant message and user text each start a turn.
 * Only assistant tool calls and user tool results count, named in the cross-provider
 * vocabulary. The merge orders signals by position, so their order and count are part of
 * the contract.
 */
function historicalClaudeSignals(entry, record, lineOffset, ts, sessionEmitted) {
  const signal = (type, fields = {}) => ({ type, provider: 'claude', sessionId: entry.sessionId, ...fields, ts });
  const signals = [];
  let message = null;
  for (const fact of claudeRecordToSignals(record)) {
    if (fact.type === 'session') {
      if (!sessionEmitted) {
        signals.push(signal('session', {
          cwd: entry.projectPath, kind: fact.kind === 'drone' ? 'drone' : entry.kind,
        }));
      }
    } else if (fact.type === 'turn-end') {
      signals.push(signal('turn-end'));
    } else if (fact.type === 'message') {
      message = fact;
      if ((fact.user && fact.prompt) || fact.assistant) signals.push(signal('turn-start'));
      if (fact.blocks && fact.user && fact.text) signals.push(signal('turn-start'));
    } else if (fact.type === 'tool-start' && message.assistant) {
      const callId = safeId(fact.callId) || `line-${lineOffset.toString(16)}`;
      const classified = classifyTool(fact.tool);
      signals.push(signal('tool-start', { callId, tool: classified.tool, status: classified.status }));
      const filePath = safePath(fact.filePath);
      if (classified.build && filePath) {
        signals.push(signal('build', { callId, files: [filePath], success: true }));
      }
    } else if (fact.type === 'tool-end' && message.user) {
      const callId = safeId(fact.callId);
      if (callId) signals.push(signal('tool-end', { callId }));
    }
  }
  return signals;
}

function compareIndexEntries(a, b) {
  return a.startMs - b.startMs || providerRank(a.provider) - providerRank(b.provider) ||
    a.sourceKey.localeCompare(b.sourceKey);
}

function compareRecords(a, b) {
  return a.ts - b.ts || providerRank(a.provider) - providerRank(b.provider) ||
    a.sourceKey.localeCompare(b.sourceKey) || a.offset - b.offset || a.ordinal - b.ordinal;
}

function heapPush(heap, record) {
  let index = heap.length;
  heap.push(record);
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compareRecords(heap[parent], record) <= 0) break;
    heap[index] = heap[parent];
    index = parent;
  }
  heap[index] = record;
}

function heapPop(heap) {
  const first = heap[0];
  const tail = heap.pop();
  if (heap.length === 0) return first;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    if (left >= heap.length) break;
    const right = left + 1;
    const child = right < heap.length && compareRecords(heap[right], heap[left]) < 0
      ? right : left;
    if (compareRecords(heap[child], tail) >= 0) break;
    heap[index] = heap[child];
    index = child;
  }
  heap[index] = tail;
  return first;
}

function providerRank(provider) {
  return provider === 'claude' ? 0 : 1;
}

function publicProject(project) {
  return {
    id: project.id,
    path: project.path,
    name: project.name,
    exists: project.exists,
    firstSeen: project.firstSeen,
    lastActivity: project.lastActivity,
    totalBytes: project.totalBytes,
    totalBuilds: project.totalBuilds,
    buckets: { ...project.buckets },
    seed: fnv1a(project.id),
    galaxy: replayGalaxy(project.path, project.exists),
  };
}

function publicShip(ship) {
  return {
    id: ship.id,
    name: ship.name,
    project: ship.project,
    kind: ship.kind,
    provider: ship.provider,
    status: ship.status,
    detail: null,
    lastEvent: ship.lastEvent,
    attention: ship.attention,
    attentionSince: ship.attentionSince,
  };
}

function replayGalaxy(projectPath, exists) {
  if (exists === false) return { key: 'graveyard', label: 'Graveyard' };
  const canonical = canonicalProjectPath(projectPath) || 'history';
  const windows = canonical.startsWith('win:');
  const flavor = windows ? path.win32 : path.posix;
  const raw = canonical.slice(canonical.indexOf(':') + 1).replace(/\//g, flavor.sep);
  const parent = flavor.dirname(raw);
  const label = humanize(flavor.basename(parent)) || 'History';
  return { key: `history:${fnv1a(parent).toString(16).padStart(8, '0')}`, label };
}

function proceduralPlanets(projectId) {
  const rand = mulberry32(fnv1a(projectId));
  const count = 3 + Math.floor(rand() * 4);
  const planets = [];
  for (let index = 0; index < count; index++) {
    planets.push({
      name: `Sector-${index + 1}`,
      files: 5 + Math.floor(rand() * 120),
      builds: 0,
      procedural: true,
    });
  }
  return planets;
}

function relativeInside(root, file) {
  if (!safePath(root) || !safePath(file)) return null;
  const windows = /^[A-Za-z]:[\\/]/.test(root) || root.includes('\\');
  const flavor = windows ? path.win32 : path.posix;
  if (!flavor.isAbsolute(root) || !flavor.isAbsolute(file)) return null;
  const normalizedRoot = flavor.normalize(root);
  const normalizedFile = flavor.normalize(file);
  const comparableRoot = windows ? normalizedRoot.toLowerCase() : normalizedRoot;
  const comparableFile = windows ? normalizedFile.toLowerCase() : normalizedFile;
  const relative = flavor.relative(comparableRoot, comparableFile);
  if (!relative || relative === '..' || relative.startsWith(`..${flavor.sep}`) ||
      flavor.isAbsolute(relative)) return null;
  return relative.replace(/[\\/]+/g, '/');
}

function safeId(value) {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  return candidate && candidate.length <= 256 && SAFE_ID_RE.test(candidate) ? candidate : null;
}

function safePath(value) {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  return candidate && candidate.length <= 4096 && !/[\0\r\n]/.test(candidate) ? candidate : null;
}

function safeExists(value) {
  // Security: never probe a UNC/device path derived from transcript content.
  if (!isLocalProjectPath(value)) return false;
  try { return fs.existsSync(value); } catch { return false; }
}

function firstString(...values) {
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

function finiteNow(now) {
  const value = Number(now());
  return Number.isFinite(value) ? value : Date.now();
}

function humanize(value) {
  return String(value || '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function fnv1a(value) {
  const input = String(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return function random() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { ReplaySource };

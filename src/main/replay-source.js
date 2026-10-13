// @ts-check
'use strict';

// Historical transcript playback. ReplaySource is deliberately independent of
// Tracker: it never starts live watchers, writes persistent state, opens a
// process, or exposes transcript contents. Only structural transcript facts
// cross this module's public boundary. The work lives in history/: the index,
// per-source record readers, the merge, the model they rebuild, and seek checkpoints.

const { EventEmitter } = require('events');
const { planCheckpointTimes } = require('./history/checkpoint-plan');
const { createCheckpointStore, seekThrough, staleCheckpoint } = require('./history/checkpoints');
const { collectIndexEntries, orderIndex } = require('./history/index-builder');
const { parseTimestamp, safeTimestamp } = require('./history/jsonl');
const { mergeThrough } = require('./history/merge');
const { createHistoryModel } = require('./history/model');
const { finiteNow, resolveReplayOptions } = require('./history/options');
const { openStreamHandle, sourceCursor } = require('./history/record-reader');

/**
 * @import { FeedEntry, PlanetData, PlaybackStatus, Project, ReplaySpeed, Ship, SystemData }
 *   from '../types/contract'
 * @import { IndexEntry } from './history/index-builder'
 * @import { HandlePool, SourceCursor } from './history/record-reader'
 */

class ReplaySource extends EventEmitter {
  constructor(options = {}) {
    super();
    const resolved = resolveReplayOptions(options);
    this.claudeProjectsDir = resolved.claudeProjectsDir;
    this.codexSessionDirs = resolved.codexSessionDirs;
    this.now = resolved.now;
    this.scheduler = resolved.scheduler;
    this.maxFiles = resolved.maxFiles;
    this.maxBatch = resolved.maxBatch;
    this.tickMs = resolved.tickMs;

    this._phase = 'idle';
    /** @type {ReplaySpeed} */
    this._speed = 1;
    this._cursorMs = null;
    this._minMs = null;
    this._maxMs = null;
    this._partial = false;
    this._hasIndex = false;
    this._indexNow = finiteNow(this.now);
    /** @type {IndexEntry[]} */
    this._indexEntries = [];
    /** @type {Map<string, string>} */
    this._preferredProjectIds = new Map();
    /** @type {Map<string, SourceCursor>} */
    this._sourceCursors = new Map();
    this._lastDrainPeakRecords = 0;
    this._epoch = 0;
    this._timer = null;
    this._tickBusy = false;
    this._playWallStart = 0;
    this._playCursorStart = 0;
    this._model = createHistoryModel({
      batchSize: () => this.maxBatch,
      onBatch: (batch) => this.emit('events', batch),
      preferredProjectId: (key) => this._preferredProjectIds.get(key),
    });
    this._checkpoints = createCheckpointStore();
  }

  /** Build a bounded file/time index. Raw lines and source paths stay private. */
  async index() {
    this._cancelPlayback();
    const token = ++this._epoch;
    await this._buildIndex(token);
    return this.status();
  }

  /** @returns {PlaybackStatus} */
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
    this._model.reset();
    this._cursorMs = this._minMs;
    if (!beforeRange) {
      this._lastDrainPeakRecords = 0;
      await seekThrough({
        store: this._checkpoints,
        model: this._model,
        cursors: () => this._sourceCursors,
        setCursors: (cursors) => { this._sourceCursors = cursors; },
        advance: (time, after) => this._advanceThrough(token, time, false, after),
        reset: () => {
          this._model.reset();
          this._sourceCursors = new Map();
        },
        assertCurrent: () => this._assertCurrent(token),
      }, target);
    } else {
      this._cursorMs = target;
    }
    this._model.clearEvents();
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
    this._lastDrainPeakRecords = 0;
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
    this._speed = /** @type {ReplaySpeed} */ (speed);
    this._emitState();
    return this.status();
  }

  /** @returns {{ projects: Project[], ships: Ship[], feed: FeedEntry[], eventSequence: number }} */
  snapshot() {
    return this._model.snapshot();
  }

  /**
   * @param {string} projectId
   * @returns {SystemData | null}
   */
  getSystem(projectId) {
    return this._model.getSystem(projectId);
  }

  /**
   * @param {string} projectId
   * @param {string} planetName
   * @returns {PlanetData | null}
   */
  getPlanet(projectId, planetName) {
    return this._model.getPlanet(projectId, planetName);
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
    this._model.reset();
    this._checkpoints.reset([]);
    this._emitState();
  }

  async _buildIndex(token, { preservePlaying = false } = {}) {
    this._phase = 'indexing';
    this._hasIndex = false;
    this._indexNow = finiteNow(this.now);
    this._emitState();
    const collected = await collectIndexEntries({
      claudeProjectsDir: this.claudeProjectsDir,
      codexSessionDirs: this.codexSessionDirs,
      safeTimestamp: (value) => safeTimestamp(value, this._indexNow),
      assertCurrent: () => this._assertCurrent(token),
    });
    const index = orderIndex(collected, this.maxFiles);
    this._assertCurrent(token);
    this._indexEntries = index.entries;
    this._preferredProjectIds = index.preferredProjectIds;
    this._sourceCursors = new Map();
    this._partial = index.partial;
    this._minMs = index.minMs;
    this._maxMs = index.maxMs;
    this._cursorMs = this._minMs;
    this._hasIndex = true;
    this._phase = preservePlaying ? 'playing' : 'paused';
    this._model.reset();
    this._checkpoints.reset(planCheckpointTimes(index.entries, index.minMs, index.maxMs));
    if (preservePlaying) {
      this._playCursorStart = this._minMs || 0;
      this._playWallStart = finiteNow(this.now);
    }
    this._emitState();
  }

  /** `after` guards a checkpoint continuation: every record applied must be later. */
  async _advanceThrough(token, target, emit, after = -Infinity) {
    if (!Number.isFinite(target)) return;
    const partial = await mergeThrough({
      entries: this._indexEntries,
      partial: this._partial,
      assertCurrent: () => this._assertCurrent(token),
      safeTimestamp: (value) => safeTimestamp(value, this._indexNow),
      openStreamHandle: (entry, cursor, handles) => this._openStreamHandle(entry, cursor, handles),
      cursorFor: (entry) => sourceCursor(this._sourceCursors, entry),
      cursorOf: (sourceKey) => this._sourceCursors.get(sourceKey),
      apply: (record) => {
        if (record.ts <= after) throw staleCheckpoint(record.ts);
        this._model.advanceLifecycle(record.ts, emit);
        this._model.applyRecord(record, emit);
      },
      onHeapSize: (size) => {
        this._lastDrainPeakRecords = Math.max(this._lastDrainPeakRecords, size);
      },
    }, target);
    this._assertCurrent(token);
    this._partial = partial;
    this._model.advanceLifecycle(target, emit);
    this._cursorMs = target;
    if (emit) this._model.flush();
  }

  /**
   * @param {IndexEntry} entry
   * @param {SourceCursor} cursor
   * @param {HandlePool} handles
   */
  _openStreamHandle(entry, cursor, handles) {
    return openStreamHandle(entry, cursor, handles);
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
      const error = /** @type {NodeJS.ErrnoException} */ (new Error('replay operation cancelled'));
      error.code = 'ERR_REPLAY_CANCELLED';
      throw error;
    }
  }
}

module.exports = { ReplaySource };

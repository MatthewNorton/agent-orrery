// @ts-check
'use strict';

// Seek checkpoints: the universe and every source cursor exactly as a cold seek leaves them
// at planned times, so a seek replays only from the latest one at or before its target.
// Continuing from time C equals a cold seek only while every record applied is later than C.
// A record that is not (one parked behind a later-stamped line that a seek to C stops at)
// marks the checkpoint stale for that target, and the seek runs cold instead.

const { MAX_CHECKPOINTS } = require('./checkpoint-plan');
const { safeExists } = require('./model');

/**
 * @import { HistoryModel, ModelState } from './model'
 * @import { SourceCursor } from './record-reader'
 */

const CHECKPOINT_BUDGET_BYTES = 64 * 1024 * 1024;

/**
 * @typedef {object} Checkpoint
 * @property {number} time
 * @property {number} ordinal position in the plan, for even thinning
 * @property {number} invalidFrom the first target this checkpoint is known not to serve
 * @property {ModelState} state
 * @property {Map<string, SourceCursor>} cursors
 * @property {number} bytes
 */

/**
 * A copy that shares only what the model never mutates: feed entries and pending-call values.
 * @param {ModelState} state
 * @returns {ModelState}
 */
function cloneModelState(state) {
  const projects = new Map();
  for (const [id, project] of state.projects) {
    projects.set(id, { ...project, buckets: Object.assign(Object.create(null), project.buckets) });
  }
  const ships = new Map();
  for (const [id, ship] of state.ships) ships.set(id, { ...ship, pending: new Map(ship.pending) });
  const runtimeBySource = new Map();
  for (const [key, runtime] of state.runtimeBySource) runtimeBySource.set(key, { ...runtime });
  return {
    projects,
    projectIdByPath: new Map(state.projectIdByPath),
    ships,
    feed: state.feed.slice(),
    runtimeBySource,
    providerCounters: new Map(state.providerCounters),
    seenBuildSignals: new Set(state.seenBuildSignals),
    eventSequence: 0,
    pendingEvents: [],
  };
}

/**
 * A copy with its buffer released: the next read starts at the first unread byte.
 * @param {SourceCursor} cursor
 * @returns {SourceCursor}
 */
function cloneCursor(cursor) {
  return {
    ...cursor,
    readOffset: cursor.buffer.length > cursor.bufferStart ? cursor.bufferOffset : cursor.readOffset,
    buffer: Buffer.alloc(0),
    bufferStart: 0,
    adapterState: cursor.adapterState && { ...cursor.adapterState },
    pendingRecords: cursor.pendingRecords.slice(),
  };
}

/** @param {Map<string, SourceCursor>} cursors */
function cloneCursors(cursors) {
  const copy = new Map();
  for (const [key, cursor] of cursors) copy.set(key, cloneCursor(cursor));
  return copy;
}

/**
 * Put a checkpoint's universe into the model and return fresh copies of its cursors.
 * Whether a project folder exists is read again, as a cold seek would.
 * @param {Checkpoint} checkpoint
 * @param {HistoryModel} model
 */
function restoreCheckpoint(checkpoint, model) {
  const state = cloneModelState(checkpoint.state);
  for (const project of state.projects.values()) project.exists = safeExists(project.path);
  Object.assign(model.state, state);
  return cloneCursors(checkpoint.cursors);
}

/**
 * The heap a checkpoint holds, from what it contains; calibrated against measured heap.
 * @param {Checkpoint} checkpoint
 */
function estimateCheckpointBytes({ state, cursors }) {
  let pending = 0;
  for (const cursor of cursors.values()) pending += cursor.pendingRecords.length;
  let buckets = 0;
  for (const project of state.projects.values()) buckets += Object.keys(project.buckets).length;
  let calls = 0;
  for (const ship of state.ships.values()) calls += ship.pending.size;
  return cursors.size * 500 + pending * 8 + state.runtimeBySource.size * 160 +
    state.projects.size * 300 + buckets * 60 + state.ships.size * 300 + calls * 80 +
    state.feed.length * 8 + (state.projectIdByPath.size + state.seenBuildSignals.size +
    state.providerCounters.size) * 40;
}

/**
 * The checkpoints of one index. Times come from a plan; when the count or byte budget is
 * exceeded the checkpoint whose removal leaves the smallest gap goes, and its time with it.
 * @param {{ maxCount?: number, maxBytes?: number, measure?: (checkpoint: Checkpoint) => number }} [options]
 */
function createCheckpointStore({
  maxCount = MAX_CHECKPOINTS, maxBytes = CHECKPOINT_BUDGET_BYTES, measure = estimateCheckpointBytes,
} = {}) {
  /** @type {{ time: number, ordinal: number }[]} */
  let plan = [];
  let lastOrdinal = 0;
  /** @type {Checkpoint[]} */
  let saved = [];
  let bytes = 0;
  const counters = { restores: 0, stale: 0, evicted: 0 };

  /** @param {number[]} times */
  function reset(times) {
    plan = times.map((time, index) => ({ time, ordinal: index + 1 }));
    lastOrdinal = plan.length;
    saved = [];
    bytes = 0;
  }

  /** The latest checkpoint at or before `target` that is not stale for it. */
  function latest(target) {
    let found = null;
    for (const checkpoint of saved) {
      if (checkpoint.time > target) break;
      if (checkpoint.invalidFrom > target) found = checkpoint;
    }
    return found;
  }

  /** Planned times in (after, target] without a checkpoint yet. */
  function boundaries(after, target) {
    return plan.filter((item) => item.time > after && item.time <= target &&
      !saved.some((checkpoint) => checkpoint.time === item.time)).map((item) => item.time);
  }

  /**
   * @param {number} time
   * @param {ModelState} state
   * @param {Map<string, SourceCursor>} cursors
   */
  function capture(time, state, cursors) {
    const planned = plan.find((item) => item.time === time);
    if (!planned || saved.some((checkpoint) => checkpoint.time === time)) return;
    /** @type {Checkpoint} */
    const checkpoint = {
      time, ordinal: planned.ordinal, invalidFrom: Infinity,
      state: cloneModelState(state), cursors: cloneCursors(cursors), bytes: 0,
    };
    checkpoint.bytes = measure(checkpoint);
    saved.push(checkpoint);
    saved.sort((a, b) => a.time - b.time);
    bytes += checkpoint.bytes;
    while (saved.length > maxCount || (bytes > maxBytes && saved.length)) evictOne();
  }

  function evictOne() {
    let victim = 0;
    let smallest = Infinity;
    for (let index = 0; index < saved.length; index++) {
      const before = index > 0 ? saved[index - 1].ordinal : 0;
      const after = index + 1 < saved.length ? saved[index + 1].ordinal : lastOrdinal + 1;
      if (after - before < smallest) {
        smallest = after - before;
        victim = index;
      }
    }
    const [removed] = saved.splice(victim, 1);
    bytes -= removed.bytes;
    plan = plan.filter((item) => item.time !== removed.time);
    counters.evicted++;
  }

  /**
   * A continuation applied a record at `recordTs` it should have applied earlier: checkpoints
   * from that time up to the step's target cannot serve that target or later ones.
   * @param {number} recordTs
   * @param {number} stepTarget
   */
  function invalidate(recordTs, stepTarget) {
    counters.stale++;
    for (const checkpoint of saved) {
      if (checkpoint.time >= recordTs && checkpoint.time < stepTarget) {
        checkpoint.invalidFrom = Math.min(checkpoint.invalidFrom, stepTarget);
      }
    }
  }

  function stats() {
    return { planned: plan.length, count: saved.length, bytes, ...counters };
  }

  return {
    reset, latest, boundaries, capture, invalidate, stats,
    noteRestore: () => { counters.restores++; },
    /** @returns {readonly Checkpoint[]} */
    get checkpoints() { return saved; },
  };
}

/** @typedef {ReturnType<typeof createCheckpointStore>} CheckpointStore */

/**
 * Thrown from a guarded advance when a record is not later than the checkpoint it continues.
 * @param {number} recordTs
 */
function staleCheckpoint(recordTs) {
  return Object.assign(new Error('checkpoint is stale for this target'), {
    code: 'ERR_CHECKPOINT_STALE', recordTs,
  });
}

/**
 * @typedef {object} SeekContext
 * @property {CheckpointStore} store
 * @property {HistoryModel} model
 * @property {() => Map<string, SourceCursor>} cursors
 * @property {(cursors: Map<string, SourceCursor>) => void} setCursors
 * @property {(time: number, after: number) => Promise<void>} advance a silent advance to `time`
 *   that throws ERR_CHECKPOINT_STALE for a record at or before `after`
 * @property {() => void} reset an empty model and no cursors
 * @property {() => void} assertCurrent
 */

/**
 * Rebuild the universe at `target` from a reset model: restore the latest usable checkpoint,
 * advance through the planned times after it (capturing each), then to the target.
 * @param {SeekContext} ctx
 * @param {number} target
 */
async function seekThrough(ctx, target) {
  const start = ctx.store.latest(target);
  let after = -Infinity;
  if (start) {
    ctx.setCursors(restoreCheckpoint(start, ctx.model));
    ctx.store.noteRestore();
    after = start.time;
  }
  let stepTarget = target;
  try {
    for (const time of ctx.store.boundaries(after, target)) {
      stepTarget = time;
      await ctx.advance(time, after);
      ctx.assertCurrent();
      ctx.store.capture(time, ctx.model.state, ctx.cursors());
      after = time;
    }
    stepTarget = target;
    await ctx.advance(target, after);
  } catch (error) {
    if (!error || error.code !== 'ERR_CHECKPOINT_STALE') throw error;
    ctx.store.invalidate(error.recordTs, stepTarget);
    ctx.reset();
    await ctx.advance(target, -Infinity);
  }
}

module.exports = {
  CHECKPOINT_BUDGET_BYTES,
  createCheckpointStore,
  restoreCheckpoint,
  staleCheckpoint,
  seekThrough,
};

// @ts-check
'use strict';

/**
 * @import { BatchMeta, PlaybackStatus, ProjectVcsStatus, ReplayResult, ReplaySpeed,
 *   ReplayStatePush, Snapshot, StreamMode, SystemData } from '../types/contract'
 */

function createReplayControl(ctx) {
  let replayOperation = 0;
  let replayBoundaryOperations = 0;
  let replayIndexPromise = null;
  let replayStateLastSent = 0;
  let replayStateTimer = null;

  /**
   * @param {StreamMode | null} [mode]
   * @returns {PlaybackStatus}
   */
  function boundedReplayStatus(mode = null) {
    const raw = ctx.replaySource ? ctx.replaySource.status() : {};
    const minTs = Number.isFinite(raw.minTs) ? raw.minTs : null;
    const maxTs = Number.isFinite(raw.maxTs) ? raw.maxTs : null;
    let cursorTs = Number.isFinite(raw.cursorTs) ? raw.cursorTs : null;
    const visibleMode = mode || (ctx.activeSource === ctx.replaySource ? 'replay' : 'live');
    if (visibleMode === 'live' && Number.isFinite(maxTs)) cursorTs = maxTs;
    return {
      mode: visibleMode,
      available: Boolean(raw.available),
      indexing: Boolean(raw.indexing),
      minTs,
      maxTs,
      cursorTs,
      playing: visibleMode === 'replay' && Boolean(raw.playing),
      speed: /** @type {ReplaySpeed} */ (
        [1, 10, 100, 1000].includes(Number(raw.speed)) ? Number(raw.speed) : 1
      ),
      sourceCount: Number.isFinite(raw.sourceCount) ? raw.sourceCount : 0,
      truncated: Boolean(raw.truncated),
    };
  }

  /** @returns {Snapshot} */
  function visibleSnapshot() {
    const source = ctx.activeSource || ctx.tracker;
    let snapshot = source ? source.snapshot() : {
      projects: [], ships: [], feed: [], eventSequence: 0,
    };
    if (ctx.projectVcsStatusController) {
      snapshot = ctx.projectVcsStatusController.enrichSnapshot(source, snapshot);
    }
    return {
      ...snapshot,
      streamEpoch: ctx.streamEpoch,
      playback: boundedReplayStatus(source === ctx.replaySource ? 'replay' : 'live'),
    };
  }

  /** @returns {SystemData | null} */
  function visibleSystem(projectId) {
    const source = ctx.activeSource || ctx.tracker;
    const system = source ? source.getSystem(projectId) : null;
    return ctx.projectVcsStatusController
      ? ctx.projectVcsStatusController.enrichSystem(source, system)
      : system;
  }

  /** @param {ProjectVcsStatus} status */
  function sendProjectVcsStatusChanged(status) {
    if (!status || ctx.activeSource !== ctx.tracker || !ctx.win || ctx.win.isDestroyed()) return;
    ctx.win.webContents.send('au:project-vcs-status-changed', status, /** @satisfies {BatchMeta} */ ({
      streamEpoch: ctx.streamEpoch,
      mode: 'live',
    }));
  }

  /** @returns {ReplayResult} */
  function replayResult(includeSnapshot = false) {
    const playback = boundedReplayStatus(ctx.activeSource === ctx.replaySource ? 'replay' : 'live');
    return {
      playback,
      streamEpoch: ctx.streamEpoch,
      ...(includeSnapshot ? { snapshot: visibleSnapshot() } : {}),
    };
  }

  function sendReplayState() {
    if (!ctx.win || ctx.win.isDestroyed()) return;
    const now = Date.now();
    const remaining = 100 - (now - replayStateLastSent);
    if (remaining > 0) {
      if (!replayStateTimer) {
        replayStateTimer = setTimeout(() => {
          replayStateTimer = null;
          sendReplayState();
        }, remaining);
      }
      return;
    }
    replayStateLastSent = now;
    ctx.win.webContents.send('au:replay-state', /** @satisfies {ReplayStatePush} */ ({
      ...boundedReplayStatus(ctx.activeSource === ctx.replaySource ? 'replay' : 'live'),
      streamEpoch: ctx.streamEpoch,
    }));
  }

  async function ensureReplayIndex(force = false) {
    if (!ctx.replaySource) throw new Error('history playback is unavailable');
    const current = boundedReplayStatus('replay');
    if (!force && current.available && !current.indexing) return current;
    if (!replayIndexPromise) {
      replayIndexPromise = ctx.replaySource.index()
        .finally(() => { replayIndexPromise = null; });
    }
    await replayIndexPromise;
    return boundedReplayStatus('replay');
  }

  function validateReplayCommand(command) {
    if (!command || typeof command !== 'object' || Array.isArray(command)) {
      throw new TypeError('replay command must be an object');
    }
    const action = command.action;
    if (!['index', 'seek', 'play', 'pause', 'speed', 'live'].includes(action)) {
      throw new TypeError('unsupported replay action');
    }
    if (action === 'seek' && (typeof command.ts !== 'number' || !Number.isFinite(command.ts))) {
      throw new TypeError('replay seek timestamp must be finite');
    }
    if (action === 'speed' && (typeof command.speed !== 'number' ||
        ![1, 10, 100, 1000].includes(command.speed))) {
      throw new RangeError('unsupported replay speed');
    }
    return action;
  }

  /** @returns {Promise<ReplayResult>} */
  async function handleReplayCommand(command) {
    const action = validateReplayCommand(command);
    const operation = ++replayOperation;

    if (action === 'index') {
      if (ctx.activeSource === ctx.replaySource) throw new Error('return to LIVE before rebuilding the history index');
      await ensureReplayIndex(true);
      return replayResult(false);
    }

    if (action === 'seek') {
      replayBoundaryOperations++;
      try {
        await ensureReplayIndex(false);
        const status = boundedReplayStatus('replay');
        if (!status.available) throw new Error('no historical records are available');
        const target = Math.max(status.minTs, Math.min(status.maxTs, command.ts));
        // Forward scrubs can reuse parsed source cursors and the current reducer.
        // Backward scrubs still take the deterministic cold-seek path.
        if (ctx.activeSource === ctx.replaySource && Number.isFinite(status.cursorTs) &&
            target >= status.cursorTs) {
          // Cancel a scheduled/in-flight playback generation before reusing its
          // source cursors. Otherwise a timer tick and this seek can interleave
          // reads against the same mutable cursor.
          ctx.replaySource.pause();
          await ctx.replaySource.advanceTo(target, { emit: false });
        } else {
          await ctx.replaySource.seek(target);
        }
        if (operation !== replayOperation) return replayResult(false);
        ctx.replaySource.pause();
        ctx.activeSource = ctx.replaySource;
        ctx.streamEpoch++;
        sendReplayState();
        return replayResult(true);
      } finally {
        replayBoundaryOperations = Math.max(0, replayBoundaryOperations - 1);
      }
    }

    if (action === 'live') {
      ctx.replaySource.pause();
      if (ctx.activeSource !== ctx.tracker) {
        ctx.activeSource = ctx.tracker;
        ctx.streamEpoch++;
      }
      sendReplayState();
      return replayResult(true);
    }

    if (ctx.activeSource !== ctx.replaySource) {
      throw new Error(`${action} requires replay mode`);
    }
    if (action === 'play') ctx.replaySource.play();
    else if (action === 'pause') ctx.replaySource.pause();
    else ctx.replaySource.setSpeed(Number(command.speed));
    return replayResult(false);
  }

  function visibleProject(id) {
    const source = ctx.activeSource || ctx.tracker;
    if (source && source.projects instanceof Map) return source.projects.get(id) || null;
    const snapshot = source ? source.snapshot() : null;
    return snapshot && Array.isArray(snapshot.projects)
      ? snapshot.projects.find((project) => project.id === id) || null
      : null;
  }

  function reset() {
    replayOperation++;
    if (replayStateTimer) clearTimeout(replayStateTimer);
    replayStateTimer = null;
    replayBoundaryOperations = 0;
  }

  return {
    get replayBoundaryOperations() { return replayBoundaryOperations; },
    boundedReplayStatus,
    visibleSnapshot,
    visibleSystem,
    visibleProject,
    sendProjectVcsStatusChanged,
    sendReplayState,
    ensureReplayIndex,
    handleReplayCommand,
    reset,
  };
}

module.exports = { createReplayControl };

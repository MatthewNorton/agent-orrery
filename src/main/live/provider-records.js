// @ts-check
'use strict';

// Codex and Signal rollouts: read new bytes, adapt complete lines into provider signals, and
// apply those signals to ships, pending calls and builds.

const fs = require('fs');
const {
  normalizeProvider,
  canonicalProjectPath,
  classifyTool,
  createAdapterState,
  splitCompleteLines,
  adaptLine,
} = require('../provider-adapters');
const { fnv1a, hex8 } = require('../shared/hash');
const { liveShip } = require('../universe/public-shape');
const { queue } = require('./events');
const { READ_LIMIT_BYTES, LINE_LIMIT_BYTES } = require('./model');
const { ensureProjectForPath } = require('./projects');
const { ensureProviderShip, setModel, addPending, clearPending } = require('./ships');
const { applyProviderBuildFiles } = require('./builds');

/** @import { LiveModel, LiveTail } from '../../types/live-model' */

const SEEN_SIGNALS_LIMIT = 2048;
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Reads what a rollout gained since the last poll. A file that shrank was replaced: it is read
 * again from zero, in catchup mode.
 * @param {LiveModel} model
 * @param {string} fp
 * @param {LiveTail} tail
 * @param {import('fs').Stats} st
 */
function pollProviderFile(model, fp, tail, st) {
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
    const len = Math.min(st.size - tail.offset, READ_LIMIT_BYTES);
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, tail.offset);
    fs.closeSync(fd);
    chunk = buf.subarray(0, n);
    tail.offset += n;
  } catch {
    return;
  }
  const touchedShip = ensureProviderShip(
    model, tail.provider, tail.project, tail.session,
    tail.kind || 'main', st.mtimeMs, tail.parentSessionId
  );
  if (touchedShip) touchedShip.lastEvent = Math.max(touchedShip.lastEvent, st.mtimeMs);
  const touchedProject = model.projects.get(tail.project);
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
  tail.remainder = split.remainder.length <= LINE_LIMIT_BYTES ? split.remainder : Buffer.alloc(0);
  if (split.remainder.length > LINE_LIMIT_BYTES) tail.discardOversized = true;
  let lineOffset = startOffset;
  for (const line of split.lines) {
    if (line.length > LINE_LIMIT_BYTES) {
      lineOffset += line.length + 1;
      continue;
    }
    const result = adaptLine(tail.provider, line.toString('utf8'), tail.adapterState, {
      lineOffset, now: st.mtimeMs,
    });
    if (result && result.state) tail.adapterState = result.state;
    applyProviderSignals(model, result && Array.isArray(result.signals) ? result.signals : [], tail);
    lineOffset += line.length + 1;
  }
  if (tail.catchup && tail.offset >= st.size) tail.catchup = false;
}

/**
 * @param {LiveModel} model
 * @param {any[]} signals
 * @param {LiveTail} tail
 */
function applyProviderSignals(model, signals, tail) {
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
      while (tail.seenSignals.size > SEEN_SIGNALS_LIMIT) tail.seenSignals.delete(tail.seenSignals.values().next().value);
    }
    const provider = normalizeProvider(signal.provider || tail.provider);
    const sessionId = signal.sessionId || tail.session;
    const ts = Number.isFinite(signal.ts) ? signal.ts : Date.now();
    // Any signal may restate the session's model facts; the tail remembers the latest.
    if (typeof signal.local === 'boolean') tail.local = signal.local;
    if (typeof signal.model === 'string') tail.model = signal.model;

    if (signal.type === 'session' || signal.type === 'project') {
      // Security follow-up: UNC/relative cwds have no project key; skip the association, never fnv1a(null).
      const projectKey = signal.cwd ? canonicalProjectPath(signal.cwd) : null;
      if (projectKey) {
        const project = ensureProjectForPath(model, signal.cwd, `project:${hex8(projectKey)}`, ts, 0);
        if (project) tail.project = project.id;
      }
      if (tail.project) {
        setModel(model, ensureProviderShip(
          model, provider, tail.project, sessionId,
          signal.kind || tail.kind || 'main', ts,
          signal.parentSessionId || tail.parentSessionId
        ), tail);
      }
      continue;
    }

    const ship = ensureProviderShip(
      model, provider, tail.project, sessionId,
      signal.kind || tail.kind || 'main', ts,
      signal.parentSessionId || tail.parentSessionId
    );
    if (!ship) continue;
    setModel(model, ship, tail);
    ship.lastEvent = Math.max(ship.lastEvent, ts);

    if (signal.type === 'task-claim') {
      if (TASK_ID.test(signal.taskId || '')) {
        ship.taskId = signal.taskId.toLowerCase();
        queue(model, { type: 'ship-updated', ship: liveShip(ship) });
      }
    } else if (signal.type === 'turn-start') {
      ship.turnDone = false;
      ship.turnOutcome = 'running';
      ship.status = 'Working';
      ship.detail = null;
      queue(model, { type: 'ship-updated', ship: liveShip(ship) });
    } else if (signal.type === 'turn-done' || signal.type === 'turn-complete' || signal.type === 'turn-end') {
      ship.turnDone = true;
      ship.turnOutcome = 'completed';
      ship.detail = null;
      queue(model, { type: 'ship-updated', ship: liveShip(ship) });
    } else if (signal.type === 'turn-aborted') {
      ship.turnDone = false;
      ship.turnOutcome = 'aborted';
      ship.status = 'Working';
      ship.detail = null;
      queue(model, { type: 'ship-updated', ship: liveShip(ship) });
    } else if (signal.type === 'tool-use' || signal.type === 'tool-start') {
      const pendingId = `${provider}:${sessionId}:${signal.id || signal.callId || signal.key || ts}`;
      const classified = classifyTool(signal.tool);
      const tool = classified.tool;
      ship.status = signal.status || classified.status;
      ship.detail = null;
      ship.turnDone = false;
      addPending(model, ship, pendingId, tool, ts);
      queue(model, { type: 'ship-updated', ship: liveShip(ship) });
      if (!tail.catchup) {
        queue(model, {
          type: 'activity', project: ship.project, shipId: ship.id,
          tool, status: ship.status, detail: null, ts,
        });
      }
    } else if (signal.type === 'tool-result' || signal.type === 'tool-end') {
      const pendingId = `${provider}:${sessionId}:${signal.id || signal.callId || ''}`;
      clearPending(model, pendingId, ts);
    } else if (signal.type === 'build-files' || signal.type === 'build') {
      if (signal.success !== false) applyProviderBuildFiles(model, ship, signal.files, ts, tail.catchup);
    } else if (signal.type === 'activity' || signal.type === 'heartbeat' || signal.type === 'status') {
      if (signal.status) ship.status = signal.status;
      ship.detail = null;
      queue(model, { type: 'ship-updated', ship: liveShip(ship) });
      if (!tail.catchup && signal.type !== 'heartbeat') {
        queue(model, {
          type: 'activity', project: ship.project, shipId: ship.id,
          tool: signal.tool || 'Activity', status: ship.status, detail: null, ts,
        });
      }
    }
  }
}

module.exports = { pollProviderFile, applyProviderSignals };

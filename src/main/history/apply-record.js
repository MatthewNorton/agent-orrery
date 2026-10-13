// @ts-check
'use strict';

// Reduces one merged record into the historical universe. Signals use the cross-provider
// vocabulary; a Claude Agent or Task call launches a drone that returns with its result.

const { classifyTool } = require('../provider-adapters');
const { fnv1a } = require('../shared/hash');
const { safeId, safePath } = require('../transcripts/fields');
const { historyProject, historyShip } = require('../universe/public-shape');

/**
 * @import { HistoryModel } from './model'
 * @import { HistoryRecord } from './record-reader'
 */

/**
 * What history knows about a source's session, learned from its index entry and signals.
 * @typedef {object} HistoryRuntime
 * @property {string} provider
 * @property {string} sessionId
 * @property {string} projectPath
 * @property {'main' | 'drone'} kind
 * @property {string | null} parentSessionId
 * @property {string | null} projectIdHint
 * @property {string | null} projectId
 * @property {boolean} local
 */

/**
 * @param {HistoryModel} model
 * @param {HistoryRecord} record
 * @param {boolean} emit
 */
function applyRecord(model, record, emit) {
  const signal = record.signal;
  /** @type {HistoryRuntime} */
  const runtime = model.state.runtimeBySource.get(record.sourceKey) || {
    provider: record.provider,
    sessionId: record.entry.sessionId,
    projectPath: record.entry.projectPath,
    kind: record.entry.kind,
    parentSessionId: record.entry.parentSessionId,
    projectIdHint: record.entry.projectIdHint,
    projectId: null,
    local: record.entry.local === true,
  };
  if (typeof signal.local === 'boolean') runtime.local = signal.local;
  if (signal.type === 'session') {
    runtime.sessionId = safeId(signal.sessionId) || runtime.sessionId;
    runtime.projectPath = safePath(signal.cwd) || runtime.projectPath;
    runtime.kind = signal.kind === 'drone' ? 'drone' : runtime.kind;
    runtime.parentSessionId = safeId(signal.parentSessionId) || runtime.parentSessionId;
  }
  const project = model.ensureProject(
    runtime.projectPath, record.ts, emit, runtime.projectIdHint
  );
  if (!project) return;
  runtime.projectId = project.id;
  model.state.runtimeBySource.set(record.sourceKey, runtime);
  const ship = model.ensureShip(runtime, record.ts, emit);
  if (!ship) return;
  if (ship.local !== runtime.local) {
    ship.local = runtime.local;
    model.queue({ type: 'ship-updated', ship: historyShip(ship) }, emit);
  }
  ship.lastEvent = Math.max(ship.lastEvent, record.ts);
  if (record.ts > project.lastActivity) {
    project.lastActivity = record.ts;
    model.queue({ type: 'project-updated', project: historyProject(project) }, emit);
  }

  if (signal.type === 'session') return;
  if (signal.type === 'turn-start') {
    ship.turnDone = false;
    ship.status = 'Working';
    ship.detail = null;
    model.setAttention(ship, null, record.ts, emit);
    model.queue({ type: 'ship-updated', ship: historyShip(ship) }, emit);
    return;
  }
  if (signal.type === 'turn-end' || signal.type === 'turn-done' || signal.type === 'turn-complete') {
    ship.turnDone = true;
    ship.detail = null;
    model.queue({ type: 'ship-updated', ship: historyShip(ship) }, emit);
    return;
  }
  if (signal.type === 'turn-aborted') {
    ship.turnDone = false;
    ship.status = 'Working';
    ship.detail = null;
    model.setAttention(ship, null, record.ts, emit);
    model.queue({ type: 'ship-updated', ship: historyShip(ship) }, emit);
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
    model.setAttention(ship, null, record.ts, emit);
    model.queue({ type: 'ship-updated', ship: historyShip(ship) }, emit);
    model.queue({
      type: 'activity', project: project.id, shipId: ship.id,
      tool: classification.tool, status: ship.status, detail: null, ts: record.ts,
    }, emit);
    if (runtime.provider === 'claude' &&
        (classification.tool === 'Agent' || classification.tool === 'Task')) {
      model.spawnClaudeDrone(project, ship, runtime.sessionId, callId, record.ts, emit);
    }
    return;
  }
  if (signal.type === 'tool-end' || signal.type === 'tool-result') {
    const callId = safeId(signal.callId || signal.id);
    if (!callId) return;
    const pendingId = `${runtime.provider}:${runtime.sessionId}:${callId}`;
    ship.pending.delete(pendingId);
    model.queue({ type: 'ship-updated', ship: historyShip(ship) }, emit);
    if (runtime.provider === 'claude') {
      const droneId = `drone:claude:${runtime.sessionId}:${callId}`;
      const drone = model.state.ships.get(droneId);
      if (drone) model.departShip(drone, record.ts, emit, 'returned');
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
    if (model.state.seenBuildSignals.has(buildKey)) return;
    model.state.seenBuildSignals.add(buildKey);
    model.applyBuilds(project, ship, signal.files, record.ts, emit);
    return;
  }
  if (signal.type === 'activity' || signal.type === 'status' || signal.type === 'heartbeat') {
    ship.status = typeof signal.status === 'string' ? signal.status : 'Working';
    ship.detail = null;
    model.queue({ type: 'ship-updated', ship: historyShip(ship) }, emit);
    if (signal.type !== 'heartbeat') model.queue({
      type: 'activity', project: project.id, shipId: ship.id,
      tool: 'Activity', status: ship.status, detail: null, ts: record.ts,
    }, emit);
  }
}

module.exports = { applyRecord };

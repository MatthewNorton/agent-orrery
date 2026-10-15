// @ts-check
'use strict';

// Claude Code transcripts: read new text, parse complete lines, and apply each record to its
// project and ship.

const fs = require('fs');
const path = require('path');
const { canonicalProjectPath } = require('../provider-adapters');
const { claudeRecordToSignals, claudeTool } = require('../transcripts/claude');
const { relativeInside } = require('../path-safety');
const { liveShip } = require('../universe/public-shape');
const { queue, pushFeed } = require('./events');
const { READ_LIMIT_BYTES, LINE_LIMIT_BYTES } = require('./model');
const { adoptProjectPath } = require('./projects');
const { ensureShip, spawnDrone, setModel, addPending } = require('./ships');
const { addBuild } = require('./builds');

/**
 * @import { LiveModel, LiveProject, LiveShip, LiveTail } from '../../types/live-model'
 * @import { ClaudeMessage, ClaudeSession, ClaudeToolStart } from '../transcripts/claude'
 */

const FEED_SAMPLE_RATE = 0.12;

// Live reads a typed prompt, assistant blocks, or user blocks that answer no tool call as the
// agent working again. History has its own rule (historicalClaudeSignals).
/** @param {ClaudeMessage} message */
function resumesTurn(message) {
  return (message.user && message.prompt) ||
    (message.blocks && (message.assistant || (message.user && !message.toolResult)));
}

/**
 * Reads what a transcript gained since the last poll and parses its complete lines.
 * @param {LiveModel} model
 * @param {string} fp
 * @param {LiveTail} tail
 * @param {import('fs').Stats} st
 */
function pollClaudeFile(model, fp, tail, st) {
  if (st.size <= tail.offset) return;
  let chunk;
  try {
    const fd = fs.openSync(fp, 'r');
    const len = st.size - tail.offset;
    const buf = Buffer.alloc(Math.min(len, READ_LIMIT_BYTES));
    const n = fs.readSync(fd, buf, 0, buf.length, tail.offset);
    fs.closeSync(fd);
    chunk = buf.toString('utf8', 0, n);
    tail.offset += n;
  } catch {
    return;
  }
  if (tail.discardOversized) {
    const newline = chunk.indexOf('\n');
    if (newline < 0) return;
    chunk = chunk.slice(newline + 1);
    tail.discardOversized = false;
  }
  const text = tail.remainder + chunk;
  const lines = text.split('\n');
  tail.remainder = lines.pop();
  if (Buffer.byteLength(tail.remainder, 'utf8') > LINE_LIMIT_BYTES) {
    tail.remainder = '';
    tail.discardOversized = true;
  }
  for (const line of lines) {
    if (Buffer.byteLength(line, 'utf8') <= LINE_LIMIT_BYTES && line.trim()) parseLine(model, line, tail);
  }
  if (tail.catchup && tail.offset >= st.size) tail.catchup = false;
}

/**
 * @param {LiveModel} model
 * @param {string} line
 * @param {Pick<LiveTail, 'project' | 'session' | 'catchup'>} tail
 */
function parseLine(model, line, tail) {
  let record;
  try { record = JSON.parse(line); } catch { return; }
  const project = model.projects.get(tail.project);
  if (!project) return;
  // Live stamps an undated record with the time it was read.
  const parsedTs = record.timestamp ? Date.parse(record.timestamp) : NaN;
  const ts = Number.isFinite(parsedTs) ? parsedTs : Date.now();
  let ship = null;
  let message = null;
  for (const signal of claudeRecordToSignals(record)) {
    if (signal.type === 'session') {
      ship = applyClaudeSession(model, project, tail, signal, ts);
    } else if (signal.type === 'turn-end') {
      ship.turnDone = true;
    } else if (signal.type === 'message') {
      message = signal;
      if (resumesTurn(signal)) ship.turnDone = false;
      setModel(model, ship, signal);
    } else if (signal.type === 'tool-start') {
      if (message.assistant && signal.callId) {
        // A tool_use id belongs to the ship that issued it last.
        const previousOwnerId = model.pendingIndex.get(signal.callId);
        if (previousOwnerId && previousOwnerId !== ship.id) {
          const previousOwner = model.ships.get(previousOwnerId);
          if (previousOwner) previousOwner.pending.delete(signal.callId);
        }
        addPending(model, ship, signal.callId, signal.tool, ts);
      }
      onToolUse(model, project, ship, signal, ts, tail.catchup);
    } else if (signal.type === 'tool-end' && signal.callId) {
      onToolResult(model, signal.callId, ts);
    }
  }
}

/**
 * @param {LiveModel} model
 * @param {LiveProject} project
 * @param {{ project: string, session: string }} tail
 * @param {ClaudeSession} session
 * @param {number} ts
 * @returns {LiveShip}
 */
function applyClaudeSession(model, project, tail, session, ts) {
  if (!project.path && canonicalProjectPath(session.cwd)) adoptProjectPath(model, project, session.cwd);
  if (ts > project.lastActivity) project.lastActivity = ts;
  const ship = ensureShip(model, tail.project, tail.session, session.kind === 'drone', ts);
  ship.lastEvent = Math.max(ship.lastEvent, ts);
  return ship;
}

/**
 * @param {LiveModel} model
 * @param {LiveProject} project
 * @param {LiveShip} ship
 * @param {ClaudeToolStart} signal
 * @param {number} ts
 * @param {boolean} catchup
 */
function onToolUse(model, project, ship, signal, ts, catchup) {
  const tool = signal.tool || '?';
  const { status, build, spawn } = claudeTool(tool);
  ship.status = status;
  const rel = signal.filePath === null ? null : relativeInside(project.path, signal.filePath);
  ship.detail = signal.filePath === null ? signal.detail : rel || path.basename(signal.filePath);
  queue(model, { type: 'ship-updated', ship: liveShip(ship) });

  if (build && rel) {
    addBuild(model, project, ship, rel, ts, catchup);
  } else if (!catchup) {
    queue(model, {
      type: 'activity',
      project: project.id, shipId: ship.id, tool, status: ship.status, detail: ship.detail, ts,
    });
    if (spawn) {
      spawnDrone(model, project, ship, signal.callId, ts);
    } else if (Math.random() < FEED_SAMPLE_RATE) {
      // Sample non-build activity into the feed so it stays readable.
      pushFeed(model, 'info', `${ship.name} ${ship.status.toLowerCase()} in ${project.name}`, project.id);
    }
  }
}

/**
 * Closes a tool call; the drone it launched, if any, docks again.
 * @param {LiveModel} model
 * @param {any} toolUseId
 * @param {number} ts
 */
function onToolResult(model, toolUseId, ts) {
  const ownerId = model.pendingIndex.get(toolUseId);
  if (ownerId) {
    const owner = model.ships.get(ownerId);
    if (owner) owner.pending.delete(toolUseId);
    model.pendingIndex.delete(toolUseId);
  }

  const droneId = `drone:${toolUseId}`;
  const drone = model.ships.get(droneId);
  if (drone) {
    model.ships.delete(droneId);
    queue(model, { type: 'ship-departed', shipId: droneId, ts });
    pushFeed(model, 'depart', `${drone.name} returned to ${drone.parentName}`, drone.project);
  }
}

module.exports = { pollClaudeFile, parseLine };

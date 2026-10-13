// @ts-check
'use strict';

// How one transcript line becomes history signals. Codex lines go through the shared
// adapter; Claude records get history's own reading below.

const { adaptLine, classifyTool } = require('../provider-adapters');
const { claudeRecordToSignals } = require('../transcripts/claude');
const { safeId, safePath } = require('../transcripts/fields');
const { parseJsonLine } = require('./jsonl');

/**
 * @import { IndexEntry } from './index-builder'
 * @import { TimestampGuard } from './jsonl'
 */

/**
 * @typedef {object} ParsedLine
 * @property {Record<string, any>[]} signals each stamped with the record's timestamp
 * @property {Record<string, any> | null} adapterState
 * @property {boolean} claudeSessionEmitted
 * @property {number | null} recordTs
 */

/**
 * @param {IndexEntry} entry
 * @param {Buffer} line
 * @param {number} lineOffset
 * @param {Record<string, any> | null} adapterState
 * @param {boolean} claudeSessionEmitted
 * @param {TimestampGuard} safeTimestamp
 * @returns {ParsedLine}
 */
function parseHistoricalLine(entry, line, lineOffset, adapterState, claudeSessionEmitted, safeTimestamp) {
  const record = parseJsonLine(line);
  const ts = record ? safeTimestamp(record.timestamp) : null;
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

/**
 * History's reading of one Claude record. The session is announced once per source, at its
 * indexed project path. A prompt, any assistant message and user text each start a turn.
 * Only assistant tool calls and user tool results count, named in the cross-provider
 * vocabulary. The merge orders signals by position, so their order and count are part of
 * the contract.
 * @param {IndexEntry} entry
 * @param {Record<string, any>} record
 * @param {number} lineOffset
 * @param {number} ts
 * @param {boolean} sessionEmitted
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
      const local = fact.assistant && typeof fact.local === 'boolean' ? { local: fact.local } : {};
      if ((fact.user && fact.prompt) || fact.assistant) signals.push(signal('turn-start', local));
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

module.exports = { parseHistoricalLine, historicalClaudeSignals };

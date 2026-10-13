// @ts-check
'use strict';

const { plainObject, safeId, safePath, firstTrimmed } = require('./fields');
const { codexProviderIsLocal } = require('./model');

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig;
const MAX_BUILD_FILES = 256;
const TASK_MARKER_RE = /(?:^|\s)agent-universe:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?=\s|$)/i;

/**
 * The rollout UUID from either a POSIX or Windows Codex filename: the last one in the leaf.
 * @param {unknown} filename
 * @returns {string | null}
 */
function codexSessionIdFromFilename(filename) {
  if (typeof filename !== 'string' || !filename) return null;
  const leaf = filename.split(/[\\/]/).pop() || '';
  let last = null;
  for (const match of leaf.matchAll(UUID_RE)) last = match[0];
  return last ? last.toLowerCase() : null;
}

/**
 * Convert one already-parsed Codex record into privacy-safe structural facts.
 * This function is deliberately stateless; adaptCodexRecord adds source ownership and
 * rejects copied pre-metadata records when tailing a concrete rollout.
 * @param {unknown} record
 * @returns {Array<Record<string, any>>}
 */
function codexRecordToSignals(record) {
  if (!plainObject(record)) return [];
  const payload = plainObject(record.payload) ? record.payload : {};
  const recordType = safeToken(record.type);
  const payloadType = safeToken(payload.type);
  const parsedTs = recordTimestamp(record.timestamp, payload.timestamp, null);
  const withTs = (signal) => {
    if (parsedTs !== null) signal.ts = parsedTs;
    return signal;
  };

  if (recordType === 'session_meta') {
    // Subagent rollouts keep the root session in `session_id` but assign the
    // child thread its own `id`; the rollout filename and ship identity use id.
    const sessionId = safeId(firstTrimmed(payload.id, payload.session_id, record.session_id));
    const cwd = safePath(payload.cwd);
    if (!sessionId || !cwd) return [];
    const threadSource = typeof payload.thread_source === 'string'
      ? payload.thread_source.trim().toLowerCase()
      : null;
    const source = payload.source;
    const nestedSubagent = plainObject(source)
      && (plainObject(source.subagent) || source.thread_source === 'subagent');
    const fallbackDrone = threadSource === null
      && Boolean(safePath(payload.agent_path) || safeId(payload.parent_thread_id) || nestedSubagent);
    const kind = threadSource === 'subagent' || fallbackDrone ? 'drone' : 'main';
    const local = codexProviderIsLocal(payload.model_provider);
    return [withTs({ type: 'session', sessionId, cwd, kind, ...(local === null ? {} : { local }) })];
  }

  if (recordType === 'response_item') {
    if (payloadType === 'message' && safeToken(payload.role) === 'user') {
      const taskId = taskMarkerFromContent(payload.content);
      return taskId ? [withTs({ type: 'task-claim', taskId })] : [];
    }
    if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
      const callId = safeId(firstTrimmed(payload.call_id, payload.id));
      if (!callId) return [];
      return [withTs({
        type: 'tool-start',
        callId,
        tool: safeToolName(payload.name),
      })];
    }
    if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') {
      const callId = safeId(firstTrimmed(payload.call_id, payload.id));
      return callId ? [withTs({ type: 'tool-end', callId })] : [];
    }
    return [];
  }

  if (recordType !== 'event_msg') return [];
  if (payloadType === 'patch_apply_end' && payload.success === true) {
    const files = safeChangedPaths(payload.changes);
    if (files.length === 0) return [];
    const callId = safeId(payload.call_id);
    return [withTs({ type: 'build', files, ...(callId ? { callId } : {}) })];
  }
  if (payloadType === 'task_started') return [withTs({ type: 'turn-start' })];
  if (payloadType === 'task_complete') return [withTs({ type: 'turn-end' })];
  if (payloadType === 'turn_aborted') return [withTs({ type: 'turn-aborted' })];
  return [];
}

/**
 * Adapt one parsed record for a tailed rollout. `state` is the caller's private copy of the
 * adapter cursor; it is updated in place and returned with the signals.
 * @param {Record<string, any>} record
 * @param {Record<string, any>} state
 * @param {number} now
 */
function adaptCodexRecord(record, state, now) {
  const rawSignals = codexRecordToSignals(record);
  const payload = plainObject(record.payload) ? record.payload : {};
  const recordType = safeToken(record.type);
  const ts = recordTimestamp(record.timestamp, payload.timestamp, now);

  if (recordType === 'session_meta') {
    const session = rawSignals.find((signal) => signal.type === 'session');
    if (!session) return { state, signals: [] };
    const metadataId = session.sessionId;
    if (state.expectedSessionId && !sameId(metadataId, state.expectedSessionId)) {
      return { state, signals: [] };
    }

    state.sessionId = metadataId;
    state.expectedSessionId = state.expectedSessionId || metadataId;
    state.ownSessionSeen = true;
    state.cwd = session.cwd || state.cwd;
    state.kind = session.kind;
    state.parentSessionId = codexParentSessionId(payload);

    const sessionSignal = {
      ...session,
      provider: 'codex',
      sessionId: state.sessionId,
      ts: Number.isFinite(session.ts) ? session.ts : ts,
    };
    return { state, signals: [sessionSignal] };
  }

  // A forked rollout can begin with records copied from its parent. Never
  // attribute those records to the child before its own matching metadata.
  if (!state.ownSessionSeen || !state.sessionId) {
    return { state, signals: [] };
  }

  const signals = rawSignals.map((signal) => ({
    ...signal,
    provider: 'codex',
    sessionId: state.sessionId,
    ts: Number.isFinite(signal.ts) ? signal.ts : ts,
  }));
  return { state, signals };
}

/**
 * The parent thread of a forked or subagent rollout, from its session_meta payload.
 * @param {Record<string, any>} payload
 * @returns {string | null}
 */
function codexParentSessionId(payload) {
  const direct = safeId(firstTrimmed(payload.parent_thread_id, payload.forked_from_id));
  if (direct) return direct;
  const source = payload.source;
  if (!plainObject(source)) return null;

  const sourceDirect = safeId(firstTrimmed(source.parent_thread_id, source.forked_from_id));
  if (sourceDirect) return sourceDirect;
  if (!plainObject(source.subagent)) return null;

  const subagentDirect = safeId(firstTrimmed(
    source.subagent.parent_thread_id,
    source.subagent.forked_from_id
  ));
  if (subagentDirect) return subagentDirect;
  if (!plainObject(source.subagent.thread_spawn)) return null;
  return safeId(firstTrimmed(
    source.subagent.thread_spawn.parent_thread_id,
    source.subagent.thread_spawn.forked_from_id
  ));
}

function taskMarkerFromContent(content) {
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    if (!plainObject(part) || safeToken(part.type) !== 'input_text' || typeof part.text !== 'string') {
      continue;
    }
    const match = TASK_MARKER_RE.exec(part.text);
    if (match) return match[1].toLowerCase();
  }
  return null;
}

function safeChangedPaths(changes) {
  let candidates = [];
  if (plainObject(changes)) {
    candidates = Object.keys(changes);
  } else if (Array.isArray(changes)) {
    candidates = changes.map((entry) => plainObject(entry) ? entry.path : null);
  }

  const files = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const file = safePath(candidate);
    if (!file || seen.has(file)) continue;
    seen.add(file);
    files.push(file);
    if (files.length >= MAX_BUILD_FILES) break;
  }
  return files;
}

function safeToolName(value) {
  if (typeof value !== 'string') return 'unknown';
  const name = value.trim().slice(0, 64);
  return name && /^[A-Za-z0-9_.:-]+$/.test(name) ? name : 'unknown';
}

function safeToken(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9_]*$/i.test(value) ? value.toLowerCase() : '';
}

function sameId(a, b) {
  return a.toLowerCase() === b.toLowerCase();
}

/** A finite number, or a parseable date string, from the first value that has one. */
function recordTimestamp(primary, secondary, fallback) {
  for (const value of [primary, secondary]) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return fallback;
}

module.exports = {
  codexSessionIdFromFilename,
  codexRecordToSignals,
  adaptCodexRecord,
  codexParentSessionId,
};

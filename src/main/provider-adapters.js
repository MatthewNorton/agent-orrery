// Pure provider transcript adapters. This module deliberately has no I/O and
// only emits a small, structural vocabulary; transcript content never crosses
// the adapter boundary.
'use strict';

const path = require('path');

const PROVIDERS = new Set(['claude', 'codex', 'generic']);
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;
const MAX_ID_LENGTH = 256;
const MAX_PATH_LENGTH = 4096;
const MAX_BUILD_FILES = 256;
const TASK_MARKER_RE = /(?:^|\s)agent-universe:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?=\s|$)/i;

const TOOL_CLASSES = Object.freeze({
  apply_patch: Object.freeze({ tool: 'Edit', status: 'Building', build: true }),
  edit: Object.freeze({ tool: 'Edit', status: 'Building', build: true }),
  write: Object.freeze({ tool: 'Write', status: 'Building', build: true }),
  notebookedit: Object.freeze({ tool: 'NotebookEdit', status: 'Building', build: true }),
  multiedit: Object.freeze({ tool: 'MultiEdit', status: 'Building', build: true }),

  exec_command: Object.freeze({ tool: 'Bash', status: 'Gathering Resources', build: false }),
  exec: Object.freeze({ tool: 'Bash', status: 'Gathering Resources', build: false }),
  wait: Object.freeze({ tool: 'Bash', status: 'Gathering Resources', build: false }),
  shell_command: Object.freeze({ tool: 'Bash', status: 'Gathering Resources', build: false }),
  write_stdin: Object.freeze({ tool: 'Bash', status: 'Gathering Resources', build: false }),
  bash: Object.freeze({ tool: 'Bash', status: 'Gathering Resources', build: false }),
  powershell: Object.freeze({ tool: 'PowerShell', status: 'Gathering Resources', build: false }),
  shell: Object.freeze({ tool: 'Bash', status: 'Gathering Resources', build: false }),

  web: Object.freeze({ tool: 'WebSearch', status: 'Scanning', build: false }),
  browser: Object.freeze({ tool: 'WebSearch', status: 'Scanning', build: false }),
  web_search: Object.freeze({ tool: 'WebSearch', status: 'Scanning', build: false }),
  websearch: Object.freeze({ tool: 'WebSearch', status: 'Scanning', build: false }),
  web_fetch: Object.freeze({ tool: 'WebFetch', status: 'Scanning', build: false }),
  webfetch: Object.freeze({ tool: 'WebFetch', status: 'Scanning', build: false }),

  spawn_agent: Object.freeze({ tool: 'Agent', status: 'Delegating', build: false }),
  send_message: Object.freeze({ tool: 'Agent', status: 'Delegating', build: false }),
  followup_task: Object.freeze({ tool: 'Agent', status: 'Delegating', build: false }),
  wait_agent: Object.freeze({ tool: 'Agent', status: 'Delegating', build: false }),
  task: Object.freeze({ tool: 'Task', status: 'Delegating', build: false }),
  agent: Object.freeze({ tool: 'Agent', status: 'Delegating', build: false }),

  request_user_input: Object.freeze({ tool: 'AskUserQuestion', status: 'Working', build: false }),
  askuserquestion: Object.freeze({ tool: 'AskUserQuestion', status: 'Working', build: false }),
  exitplanmode: Object.freeze({ tool: 'ExitPlanMode', status: 'Planning', build: false }),
  update_plan: Object.freeze({ tool: 'TodoWrite', status: 'Planning', build: false }),
  create_goal: Object.freeze({ tool: 'TodoWrite', status: 'Planning', build: false }),
  update_goal: Object.freeze({ tool: 'TodoWrite', status: 'Planning', build: false }),
  get_goal: Object.freeze({ tool: 'TodoWrite', status: 'Planning', build: false }),
  todowrite: Object.freeze({ tool: 'TodoWrite', status: 'Planning', build: false }),

  read: Object.freeze({ tool: 'Read', status: 'Exploring', build: false }),
  read_file: Object.freeze({ tool: 'Read', status: 'Exploring', build: false }),
  open: Object.freeze({ tool: 'Read', status: 'Exploring', build: false }),
  list: Object.freeze({ tool: 'Read', status: 'Exploring', build: false }),
  list_files: Object.freeze({ tool: 'Read', status: 'Exploring', build: false }),
  search: Object.freeze({ tool: 'Grep', status: 'Exploring', build: false }),
  read_mcp_resource: Object.freeze({ tool: 'Read', status: 'Exploring', build: false }),
  view_image: Object.freeze({ tool: 'Read', status: 'Exploring', build: false }),
  grep: Object.freeze({ tool: 'Grep', status: 'Exploring', build: false }),
  glob: Object.freeze({ tool: 'Glob', status: 'Exploring', build: false }),
  find: Object.freeze({ tool: 'Grep', status: 'Exploring', build: false }),
});

const UNKNOWN_TOOL = Object.freeze({ tool: 'Tool', status: 'Working', build: false });

/** Normalize every externally supplied provider to the three public keys. */
function normalizeProvider(value) {
  const key = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!key) return 'claude'; // Backward compatibility for legacy snapshots.
  if (PROVIDERS.has(key)) return key;
  if (key === 'anthropic' || key === 'claude-code') return 'claude';
  if (key === 'openai' || key === 'codex-cli') return 'codex';
  return 'generic';
}

/**
 * Produce a host-independent comparison key without consulting the host OS or
 * filesystem. Windows paths are case-folded; POSIX paths retain case.
 */
function canonicalProjectPath(value) {
  if (typeof value !== 'string') return null;
  const input = value.trim();
  if (!isLocalProjectPath(input)) return null;

  const windows = /^[A-Za-z]:[\\/]/.test(input) || input.includes('\\');
  if (windows) {
    const normalized = path.win32.normalize(input)
      .replace(/\\/g, '/')
      .replace(/\/$/, (suffix, offset, whole) => whole.length === 3 ? suffix : '')
      .toLowerCase();
    return `win:${normalized}`;
  }

  const normalized = path.posix.normalize(input.replace(/\/+/g, '/'));
  return `posix:${normalized.length > 1 ? normalized.replace(/\/$/, '') : normalized}`;
}

/**
 * Accept only a local, absolutely rooted project path: a drive-letter root or a
 * single-slash POSIX root. Transcript content is attacker-controlled, and any
 * stat/exists/realpath on a UNC (`\\host\share`), `//host/share`, or `\\?\`
 * device path would make the host open a network connection (SMB/NTLM
 * forced-authentication) without user interaction. Reject those at the boundary.
 */
function isLocalProjectPath(value) {
  if (typeof value !== 'string') return false;
  if (!value || value.length > MAX_PATH_LENGTH || /[\0\r\n]/.test(value)) return false;
  if (/^[\\/]{2}/.test(value)) return false;
  if (/^[A-Za-z]:[\\/]/.test(value)) return !/^[A-Za-z]:[\\/]{2}[?.]/.test(value);
  return value.startsWith('/') && !value.includes('\\');
}

/** Extract the rollout UUID from either a POSIX or Windows Codex filename. */
function codexSessionIdFromFilename(filename) {
  if (typeof filename !== 'string' || !filename) return null;
  const leaf = filename.split(/[\\/]/).pop() || '';
  UUID_RE.lastIndex = 0;
  let match = null;
  for (let next = UUID_RE.exec(leaf); next; next = UUID_RE.exec(leaf)) match = next[0];
  UUID_RE.lastIndex = 0;
  return match ? match.toLowerCase() : null;
}

/**
 * Map raw tool identifiers to the existing, content-free tracker vocabulary.
 * Unknown names intentionally collapse to `Tool` instead of being surfaced.
 */
function classifyTool(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const leaf = raw.split(/[.:/\\]/).filter(Boolean).pop() || '';
  let classification = TOOL_CLASSES[leaf];

  // MCP and namespaced tools often keep the useful noun in a longer leaf.
  if (!classification) {
    if (leaf.includes('apply_patch') || leaf === 'patch') classification = TOOL_CLASSES.apply_patch;
    else if (/(?:exec|shell|command|write_stdin|wait)/.test(leaf)) classification = TOOL_CLASSES.exec_command;
    else if (/(?:web|browser)/.test(leaf)) classification = TOOL_CLASSES.web_search;
    else if (leaf.includes('web_fetch')) classification = TOOL_CLASSES.web_fetch;
    else if (/(?:spawn|followup|send_message|agent|task)/.test(leaf)) classification = TOOL_CLASSES.spawn_agent;
    else if (leaf.includes('request_user_input')) classification = TOOL_CLASSES.request_user_input;
    else if (/(?:plan|goal|todo)/.test(leaf)) classification = TOOL_CLASSES.update_plan;
    else if (/(?:read|find|search|list|open|view)/.test(leaf)) classification = TOOL_CLASSES.read;
    else if (/(?:edit|write|patch)/.test(leaf)) classification = TOOL_CLASSES.edit;
  }

  const selected = classification || UNKNOWN_TOOL;
  return { tool: selected.tool, status: selected.status, build: selected.build };
}

/** Map provider tools into the tracker's existing public status labels. */
function providerToolStatus(value) {
  const tool = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!tool) return 'Working';
  if (/(?:web|browser)/.test(tool)) return 'Scanning';
  if (/(?:spawn|followup|send_message|agent|task)/.test(tool)) return 'Delegating';
  if (/(?:plan|goal|todo)/.test(tool)) return 'Planning';
  if (/(?:exec|shell|command|write_stdin|wait)/.test(tool)) return 'Gathering Resources';
  if (/(?:edit|write|patch)/.test(tool)) return 'Building';
  if (/(?:read|find|search|list|open|view)/.test(tool)) return 'Exploring';
  return 'Working';
}

/**
 * Convert one already-parsed Codex record into privacy-safe structural facts.
 * This function is deliberately stateless; adaptLine adds source ownership and
 * rejects copied pre-metadata records when tailing a concrete rollout.
 */
function codexRecordToSignals(record) {
  if (!plainObject(record)) return [];
  const payload = plainObject(record.payload) ? record.payload : {};
  const recordType = safeToken(record.type);
  const payloadType = safeToken(payload.type);
  const parsedTs = timestamp(record.timestamp, payload.timestamp, null);
  const withTs = (signal) => {
    if (parsedTs !== null) signal.ts = parsedTs;
    return signal;
  };

  if (recordType === 'session_meta') {
    // Subagent rollouts keep the root session in `session_id` but assign the
    // child thread its own `id`; the rollout filename and ship identity use id.
    const sessionId = safeId(firstString(payload.id, payload.session_id, record.session_id));
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
    return [withTs({ type: 'session', sessionId, cwd, kind })];
  }

  if (recordType === 'response_item') {
    if (payloadType === 'message' && safeToken(payload.role) === 'user') {
      const taskId = taskMarkerFromContent(payload.content);
      return taskId ? [withTs({ type: 'task-claim', taskId })] : [];
    }
    if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
      const callId = safeId(firstString(payload.call_id, payload.id));
      if (!callId) return [];
      return [withTs({
        type: 'tool-start',
        callId,
        tool: safeToolName(payload.name),
      })];
    }
    if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') {
      const callId = safeId(firstString(payload.call_id, payload.id));
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

/**
 * Read and validate the optional manual watch registry. This is the sole I/O
 * helper in this module; parsing and every transcript adapter remain pure.
 */
function readGenericWatchConfig(file) {
  const result = { watch: [], warnings: [] };
  if (typeof file !== 'string' || !file) return result;
  let raw;
  try {
    // Kept local so pure adapter users do not acquire an ambient filesystem
    // dependency merely by importing this module.
    const fs = require('fs');
    raw = fs.readFileSync(file);
  } catch (error) {
    if (error && error.code !== 'ENOENT') result.warnings.push('provider config could not be read');
    return result;
  }
  if (raw.length > 256 * 1024) {
    result.warnings.push('provider config exceeds 256 KiB');
    return result;
  }

  let parsed;
  try { parsed = JSON.parse(raw.toString('utf8')); }
  catch {
    result.warnings.push('provider config is not valid JSON');
    return result;
  }
  if (!plainObject(parsed) || !Array.isArray(parsed.watch)) {
    result.warnings.push('provider config must contain a watch array');
    return result;
  }

  const seen = new Set();
  let invalid = 0;
  for (const entry of parsed.watch.slice(0, 128)) {
    if (!plainObject(entry)) { invalid++; continue; }
    const directory = safePath(entry.directory);
    const projectPath = safePath(entry.projectPath) || directory;
    if (!directory || !projectPath || !absolutePathSyntax(directory)
      || !absolutePathSyntax(projectPath)) {
      invalid++;
      continue;
    }
    const identity = canonicalProjectPath(directory);
    if (!identity || seen.has(identity)) { invalid++; continue; }
    seen.add(identity);

    let label = null;
    if (typeof entry.label === 'string') {
      label = entry.label.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 24) || null;
    }
    result.watch.push({ directory, projectPath, label });
  }
  if (parsed.watch.length > 128 || invalid > 0) {
    result.warnings.push('provider config contains invalid or duplicate watch entries');
  }
  return result;
}

/** Create the small mutable cursor needed to adapt one provider source. */
function createAdapterState(provider, source = {}) {
  const key = normalizeProvider(provider);
  const input = typeof source === 'string' ? { filename: source } : (source || {});
  const filename = firstString(input.filename, input.filePath, input.path, input.sourcePath);
  const suppliedId = safeId(firstString(input.sessionId, input.id));
  const filenameId = key === 'codex' ? codexSessionIdFromFilename(filename) : null;
  const signalFilenameId = key === 'generic' ? safeFilenameId(filename) : null;
  const sessionId = suppliedId || filenameId || signalFilenameId || (key === 'generic' ? 'signal' : null);
  const cwd = safePath(input.cwd);

  return {
    provider: key,
    expectedSessionId: key === 'codex' ? sessionId : null,
    sessionId,
    ownSessionSeen: key !== 'codex',
    cwd,
    kind: key === 'codex' ? null : 'main',
    parentSessionId: null,
  };
}

/**
 * Split at byte boundaries so a UTF-8 sequence spanning polling chunks remains
 * intact. Returned lines exclude LF and an immediately preceding CR.
 */
function splitCompleteLines(remainderBuffer, chunkBuffer) {
  const remainderInput = toBuffer(remainderBuffer);
  const chunkInput = toBuffer(chunkBuffer);
  const combined = remainderInput.length === 0
    ? Buffer.from(chunkInput)
    : chunkInput.length === 0
      ? Buffer.from(remainderInput)
      : Buffer.concat([remainderInput, chunkInput]);

  const lines = [];
  let start = 0;
  for (let i = 0; i < combined.length; i++) {
    if (combined[i] !== 0x0a) continue;
    const end = i > start && combined[i - 1] === 0x0d ? i - 1 : i;
    lines.push(Buffer.from(combined.subarray(start, end)));
    start = i + 1;
  }
  return { lines, remainder: Buffer.from(combined.subarray(start)) };
}

/**
 * Adapt one complete line. The caller owns time and byte offsets; this function
 * has no ambient clock, I/O, process, or network dependencies.
 */
function adaptLine(provider, utf8Line, state, meta = {}) {
  const key = normalizeProvider(provider);
  const base = validState(state, key) ? state : createAdapterState(key);
  const nextState = { ...base, provider: key };
  const now = finiteNumber(meta.now, 0);

  if (key === 'generic') {
    return {
      state: nextState,
      signals: [{
        type: 'heartbeat',
        provider: 'generic',
        sessionId: nextState.sessionId || 'signal',
        ts: now,
      }],
    };
  }

  // Claude's established parser remains in tracker.js.
  if (key === 'claude') return { state: nextState, signals: [] };

  let record;
  try {
    const text = Buffer.isBuffer(utf8Line) ? utf8Line.toString('utf8') : String(utf8Line || '');
    record = JSON.parse(text);
  } catch {
    return {
      state: nextState,
      signals: [],
      diagnostic: { code: 'invalid-json', lineOffset: finiteNumber(meta.lineOffset, 0) },
    };
  }
  if (!plainObject(record)) return { state: nextState, signals: [] };

  const rawSignals = codexRecordToSignals(record);
  const payload = plainObject(record.payload) ? record.payload : {};
  const recordType = safeToken(record.type);
  const ts = timestamp(record.timestamp, payload.timestamp, now);

  if (recordType === 'session_meta') {
    const session = rawSignals.find((signal) => signal.type === 'session');
    if (!session) return { state: nextState, signals: [] };
    const metadataId = session.sessionId;
    if (nextState.expectedSessionId && !sameId(metadataId, nextState.expectedSessionId)) {
      return { state: nextState, signals: [] };
    }

    const parentSessionId = parentIdFromSource(payload, payload.source);
    nextState.sessionId = metadataId;
    nextState.expectedSessionId = nextState.expectedSessionId || metadataId;
    nextState.ownSessionSeen = true;
    nextState.cwd = session.cwd || nextState.cwd;
    nextState.kind = session.kind;
    nextState.parentSessionId = parentSessionId;

    const sessionSignal = {
      ...session,
      provider: 'codex',
      sessionId: nextState.sessionId,
      ts: Number.isFinite(session.ts) ? session.ts : ts,
    };
    return { state: nextState, signals: [sessionSignal] };
  }

  // A forked rollout can begin with records copied from its parent. Never
  // attribute those records to the child before its own matching metadata.
  if (!nextState.ownSessionSeen || !nextState.sessionId) {
    return { state: nextState, signals: [] };
  }

  const signals = rawSignals.map((signal) => ({
    ...signal,
    provider: 'codex',
    sessionId: nextState.sessionId,
    ts: Number.isFinite(signal.ts) ? signal.ts : ts,
  }));
  return { state: nextState, signals };
}

function baseSignal(type, state, ts) {
  return { type, provider: state.provider, sessionId: state.sessionId, ts };
}

function validState(value, provider) {
  return plainObject(value) && normalizeProvider(value.provider) === provider;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function safeId(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  if (!id || id.length > MAX_ID_LENGTH || !SAFE_ID_RE.test(id)) return null;
  return id;
}

function safePath(value) {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  if (!candidate || candidate.length > MAX_PATH_LENGTH || /[\0\r\n]/.test(candidate)) return null;
  return candidate;
}

function safeFilenameId(filename) {
  if (typeof filename !== 'string') return null;
  const leaf = filename.split(/[\\/]/).pop() || '';
  const stem = leaf.replace(/\.[^.]*$/, '');
  return safeId(stem);
}

function safeToolName(value) {
  if (typeof value !== 'string') return 'unknown';
  const name = value.trim().slice(0, 64);
  return name && /^[A-Za-z0-9_.:-]+$/.test(name) ? name : 'unknown';
}

function absolutePathSyntax(value) {
  return path.win32.isAbsolute(value) || path.posix.isAbsolute(value);
}

function safeToken(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9_]*$/i.test(value) ? value.toLowerCase() : '';
}

function sameId(a, b) {
  return a.toLowerCase() === b.toLowerCase();
}

function finiteNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function timestamp(primary, secondary, fallback) {
  for (const value of [primary, secondary]) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return fallback;
}

function parentIdFromSource(payload, source) {
  const direct = safeId(firstString(payload.parent_thread_id, payload.forked_from_id));
  if (direct) return direct;
  if (!plainObject(source)) return null;

  const sourceDirect = safeId(firstString(source.parent_thread_id, source.forked_from_id));
  if (sourceDirect) return sourceDirect;
  if (!plainObject(source.subagent)) return null;

  const subagentDirect = safeId(firstString(
    source.subagent.parent_thread_id,
    source.subagent.forked_from_id
  ));
  if (subagentDirect) return subagentDirect;
  if (!plainObject(source.subagent.thread_spawn)) return null;
  return safeId(firstString(
    source.subagent.thread_spawn.parent_thread_id,
    source.subagent.thread_spawn.forked_from_id
  ));
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

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toBuffer(value) {
  if (value === undefined || value === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  throw new TypeError('line chunks must be Buffer, Uint8Array, string, null, or undefined');
}

module.exports = {
  normalizeProvider,
  canonicalProjectPath,
  isLocalProjectPath,
  codexSessionIdFromFilename,
  classifyTool,
  codexRecordToSignals,
  providerToolStatus,
  readGenericWatchConfig,
  createAdapterState,
  splitCompleteLines,
  adaptLine,
};

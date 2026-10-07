// @ts-check
// Provider identity, host-independent project path keys, the shared tool vocabulary and
// line adaptation. Each provider's record parser lives in transcripts/; this module has no
// I/O beyond the watch config, and transcript content never crosses it.
'use strict';

const path = require('path');
const { MAX_PATH_LENGTH, plainObject, safeId, safePath, firstTrimmed } = require('./transcripts/fields');
const {
  codexSessionIdFromFilename,
  codexRecordToSignals,
  adaptCodexRecord,
} = require('./transcripts/codex');

/** @import { Provider } from '../types/contract' */

const PROVIDERS = new Set(['claude', 'codex', 'generic']);

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

/**
 * Normalize every externally supplied provider to the three public keys.
 * @param {unknown} value
 * @returns {Provider}
 */
function normalizeProvider(value) {
  const key = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!key) return 'claude'; // Backward compatibility for legacy snapshots.
  if (PROVIDERS.has(key)) return /** @type {Provider} */ (key);
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
  const filename = firstTrimmed(input.filename, input.filePath, input.path, input.sourcePath);
  const suppliedId = safeId(firstTrimmed(input.sessionId, input.id));
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

  // Claude records go through transcripts/claude.js, whose facts each model applies itself.
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
  return adaptCodexRecord(record, nextState, now);
}

function validState(value, provider) {
  return plainObject(value) && normalizeProvider(value.provider) === provider;
}

function safeFilenameId(filename) {
  if (typeof filename !== 'string') return null;
  const leaf = filename.split(/[\\/]/).pop() || '';
  const stem = leaf.replace(/\.[^.]*$/, '');
  return safeId(stem);
}

function absolutePathSyntax(value) {
  return path.win32.isAbsolute(value) || path.posix.isAbsolute(value);
}

function finiteNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
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

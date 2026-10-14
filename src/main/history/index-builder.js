// @ts-check
'use strict';

// Finds every Claude and Codex transcript and records its time range from bounded head and
// tail reads. One entry per source; raw lines never leave this module.

const fs = require('fs');
const path = require('path');
const {
  canonicalProjectPath,
  codexRecordToSignals,
  codexSessionIdFromFilename,
} = require('../provider-adapters');
const { fnv1a } = require('../shared/hash');
const { safeId, safePath } = require('../transcripts/fields');
const { codexParentSessionId } = require('../transcripts/codex');
const { completeLines, parseJsonLine } = require('./jsonl');
const { compareIndexEntries, providerRank } = require('./order');

/** @import { TimestampGuard } from './jsonl' */

const INDEX_BLOCK_BYTES = 256 * 1024;

/**
 * One transcript and the byte range history may read from it.
 * @typedef {object} IndexEntry
 * @property {'claude' | 'codex'} provider
 * @property {string} sourceKey
 * @property {string} filePath
 * @property {string} sessionId
 * @property {string} projectPath
 * @property {string} projectName
 * @property {string | null} projectIdHint the Claude project folder slug
 * @property {'main' | 'drone'} kind
 * @property {string | null} parentSessionId
 * @property {boolean} [local]
 * @property {string | null} [model]
 * @property {number} startMs
 * @property {number} endMs
 * @property {number} size bytes captured at index time
 * @property {number} priority Codex root order; 0 for Claude
 */

/**
 * Inspect every transcript under the roots. Codex sessions found in several roots keep the
 * copy from the earliest root.
 * @param {{ claudeProjectsDir: string, codexSessionDirs: string[],
 *   safeTimestamp: TimestampGuard, assertCurrent: () => void }} options
 * @returns {Promise<IndexEntry[]>}
 */
async function collectIndexEntries({ claudeProjectsDir, codexSessionDirs, safeTimestamp, assertCurrent }) {
  const entries = [];
  let inspectedCount = 0;

  for await (const item of iterateClaudeFiles(claudeProjectsDir, assertCurrent)) {
    assertCurrent();
    const entry = await inspectClaudeFile(item.filePath, item.slug, safeTimestamp);
    if (entry) entries.push(entry);
    inspectedCount++;
    if (inspectedCount % 32 === 0) await new Promise((resolve) => setImmediate(resolve));
  }

  const codexBySession = new Map();
  for (let priority = 0; priority < codexSessionDirs.length; priority++) {
    for await (const filePath of iterateFilesRecursive(
      codexSessionDirs[priority], '.jsonl', assertCurrent
    )) {
      assertCurrent();
      const entry = await inspectCodexFile(filePath, priority, safeTimestamp);
      inspectedCount++;
      if (inspectedCount % 32 === 0) await new Promise((resolve) => setImmediate(resolve));
      if (!entry) continue;
      const previous = codexBySession.get(entry.sessionId);
      if (!previous || priority < previous.priority ||
          (priority === previous.priority && filePath.localeCompare(previous.filePath) < 0)) {
        codexBySession.set(entry.sessionId, entry);
      }
    }
  }
  entries.push(...codexBySession.values());
  return entries;
}

/**
 * Keep the `maxFiles` most recent sources and order them for the merge.
 * @param {IndexEntry[]} entries
 * @param {number} maxFiles
 */
function orderIndex(entries, maxFiles) {
  let selected = entries;
  let partial = false;
  selected.sort((a, b) => b.endMs - a.endMs || b.startMs - a.startMs ||
    providerRank(a.provider) - providerRank(b.provider) || a.sourceKey.localeCompare(b.sourceKey));
  if (selected.length > maxFiles) {
    selected = selected.slice(0, maxFiles);
    partial = true;
  }
  selected.sort(compareIndexEntries);
  /** @type {Map<string, string>} */
  const preferredProjectIds = new Map();
  for (const entry of selected) {
    if (entry.provider !== 'claude' || !entry.projectIdHint) continue;
    const key = canonicalProjectPath(entry.projectPath);
    if (key && !preferredProjectIds.has(key)) preferredProjectIds.set(key, entry.projectIdHint);
  }
  return {
    entries: selected,
    partial,
    preferredProjectIds,
    minMs: selected.length ? Math.min(...selected.map((entry) => entry.startMs)) : null,
    maxMs: selected.length ? Math.max(...selected.map((entry) => entry.endMs)) : null,
  };
}

/**
 * @param {string} filePath
 * @param {string} slug
 * @param {TimestampGuard} safeTimestamp
 * @returns {Promise<IndexEntry | null>}
 */
async function inspectClaudeFile(filePath, slug, safeTimestamp) {
  const inspected = await inspectBlocks(filePath);
  if (!inspected) return null;
  let cwd = null;
  let startMs = null;
  for (const line of inspected.headLines) {
    const record = parseJsonLine(line);
    if (!record) continue;
    const ts = safeTimestamp(record.timestamp);
    if (ts !== null && startMs === null) startMs = ts;
    if (!cwd && safePath(record.cwd)) cwd = record.cwd.trim();
    if (cwd && startMs !== null) break;
  }
  if (!cwd || startMs === null) return null;
  let endMs = startMs;
  for (const line of inspected.tailLines) {
    const record = parseJsonLine(line);
    const ts = record ? safeTimestamp(record.timestamp) : null;
    if (ts !== null && ts > endMs) endMs = ts;
  }
  // Security follow-up: skip UNC/relative cwds instead of indexing a bogus `claude:null:<id>` source.
  const projectKey = canonicalProjectPath(cwd);
  if (!projectKey) return null;
  const sessionId = safeId(path.basename(filePath, '.jsonl')) || `claude-${fnv1a(filePath).toString(16)}`;
  return {
    provider: 'claude',
    sourceKey: `claude:${projectKey}:${sessionId}`,
    filePath,
    sessionId,
    projectPath: cwd,
    projectName: path.basename(cwd) || slug,
    projectIdHint: slug,
    kind: 'main',
    parentSessionId: null,
    startMs,
    endMs,
    size: inspected.size,
    priority: 0,
  };
}

/**
 * @param {string} filePath
 * @param {number} priority
 * @param {TimestampGuard} safeTimestamp
 * @returns {Promise<IndexEntry | null>}
 */
async function inspectCodexFile(filePath, priority, safeTimestamp) {
  const inspected = await inspectBlocks(filePath);
  if (!inspected) return null;
  const filenameId = codexSessionIdFromFilename(filePath);
  let metadata = null;
  let startMs = null;
  for (const line of inspected.headLines) {
    const record = parseJsonLine(line);
    if (!record) continue;
    const ts = safeTimestamp(record.timestamp);
    if (ts !== null && startMs === null) startMs = ts;
    if (record.type !== 'session_meta') continue;
    const signal = codexRecordToSignals(record).find((item) => item.type === 'session');
    if (!signal) continue;
    if (filenameId && signal.sessionId.toLowerCase() !== filenameId.toLowerCase()) continue;
    metadata = {
      sessionId: signal.sessionId,
      cwd: signal.cwd,
      kind: signal.kind,
      parentSessionId: codexParentSessionId(record.payload),
      local: signal.local === true,
      model: signal.model || null,
    };
    break;
  }
  if (!metadata || startMs === null) return null;
  let endMs = startMs;
  for (const line of inspected.tailLines) {
    const record = parseJsonLine(line);
    const ts = record ? safeTimestamp(record.timestamp) : null;
    if (ts !== null && ts > endMs) endMs = ts;
  }
  return {
    provider: 'codex',
    sourceKey: `codex:${metadata.sessionId}`,
    filePath,
    sessionId: metadata.sessionId,
    projectPath: metadata.cwd,
    projectName: path.basename(metadata.cwd) || metadata.sessionId,
    projectIdHint: null,
    kind: metadata.kind === 'drone' ? 'drone' : 'main',
    parentSessionId: metadata.parentSessionId,
    local: metadata.local,
    model: metadata.model,
    startMs,
    endMs,
    size: inspected.size,
    priority,
  };
}

async function* iterateClaudeFiles(root, assertCurrent) {
  let directories;
  try { directories = await fs.promises.readdir(root, { withFileTypes: true }); }
  catch { return; }
  directories = directories.filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  let visited = 0;
  for (const directory of directories) {
    assertCurrent();
    let entries;
    try { entries = await fs.promises.readdir(path.join(root, directory.name), { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.jsonl')) continue;
      assertCurrent();
      yield { filePath: path.join(root, directory.name, entry.name), slug: directory.name };
      visited++;
      if (visited % 128 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
  }
}

async function* iterateFilesRecursive(root, extension, assertCurrent) {
  const pending = [root];
  let visited = 0;
  while (pending.length) {
    assertCurrent();
    const directory = pending.pop();
    let entries;
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); }
    catch { continue; }
    entries.sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(filePath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(extension)) {
        assertCurrent();
        yield filePath;
        visited++;
        if (visited % 128 === 0) await new Promise((resolve) => setImmediate(resolve));
      }
    }
  }
}

/**
 * The complete lines of a file's first and last block, and its size.
 * @param {string} filePath
 */
async function inspectBlocks(filePath) {
  let handle;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0) return null;
    const headSize = Math.min(stat.size, INDEX_BLOCK_BYTES);
    const tailStart = Math.max(0, stat.size - INDEX_BLOCK_BYTES);
    const tailSize = stat.size - tailStart;
    const head = Buffer.alloc(headSize);
    const tail = Buffer.alloc(tailSize);
    const headRead = await handle.read(head, 0, head.length, 0);
    const tailRead = tailStart === 0
      ? { bytesRead: headRead.bytesRead, buffer: head }
      : await handle.read(tail, 0, tail.length, tailStart);
    const headBuffer = head.subarray(0, headRead.bytesRead);
    const tailBuffer = tailStart === 0
      ? headBuffer : tail.subarray(0, tailRead.bytesRead);
    return {
      size: stat.size,
      headLines: completeLines(headBuffer, false),
      tailLines: completeLines(tailBuffer, tailStart > 0),
    };
  } catch {
    return null;
  } finally {
    if (handle) try { await handle.close(); } catch { /* raced with shutdown */ }
  }
}

module.exports = { collectIndexEntries, orderIndex, inspectClaudeFile, inspectCodexFile };

// @ts-check
'use strict';

// Discovers Codex rollouts under the session folders and keeps one tail per session, even when
// a rollout moves from sessions/ to archived_sessions/.

const fs = require('fs');
const path = require('path');
const {
  canonicalProjectPath,
  codexSessionIdFromFilename,
  codexRecordToSignals,
  createAdapterState,
  adaptLine,
} = require('../provider-adapters');
const { codexParentSessionId } = require('../transcripts/codex');
const { hex8 } = require('../shared/hash');
const { ACTIVE_WINDOW_MS, HOT_WINDOW_MS } = require('./model');
const { ensureProjectForPath } = require('./projects');
const { ensureProviderShip, setModel } = require('./ships');

/** @import { LiveModel, LiveTail } from '../../types/live-model' */

const META_HEAD_BYTES = 256 * 1024;
const MISSING_SCANS_LIMIT = 3;
const STRICT_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {LiveModel} model
 * @param {boolean} isStartup
 */
function scanCodex(model, isStartup) {
  const now = Date.now();
  const candidates = [];
  for (let priority = 0; priority < model.codexSessionDirs.length; priority++) {
    for (const fp of listFilesRecursive(model.codexSessionDirs[priority], '.jsonl')) {
      candidates.push({ fp, priority });
    }
  }
  candidates.sort((a, b) => a.priority - b.priority || a.fp.localeCompare(b.fp));
  const candidatePaths = new Set(candidates.map((item) => item.fp));

  const seenSessions = new Set();
  const totals = new Map();
  for (const { fp } of candidates) {
    const filenameSessionId = codexSessionIdFromFilename(fp) || path.basename(fp, '.jsonl');
    let st;
    try { st = fs.statSync(fp); } catch { continue; }
    const meta = readCodexMetadata(model, fp, filenameSessionId, st);
    if (!meta || !meta.cwd) continue;
    const projectKey = canonicalProjectPath(meta.cwd);
    if (!projectKey) continue;
    const sessionId = meta.sessionId || filenameSessionId;
    if (seenSessions.has(sessionId)) continue;
    seenSessions.add(sessionId);

    const fallbackId = `project:${hex8(projectKey)}`;
    const project = ensureProjectForPath(model, meta.cwd, fallbackId, st.mtimeMs, 0);
    if (!project) continue;
    totals.set(project.id, (totals.get(project.id) || 0) + st.size);
    if (st.mtimeMs > project.lastActivity) project.lastActivity = st.mtimeMs;

    if (now - st.mtimeMs > HOT_WINDOW_MS) continue;
    let tail = model.codexTailsBySession.get(sessionId);
    if (tail && tail.path !== fp) {
      model.files.delete(tail.path);
      tail.path = fp;
      tail.project = project.id;
      if (tail.offset > st.size) {
        tail.offset = 0;
        tail.remainder = Buffer.alloc(0);
        tail.catchup = true;
        tail.adapterState = createAdapterState('codex', {
          sessionId,
        });
      }
      model.files.set(fp, tail);
    } else if (!tail) {
      tail = newCodexTail(fp, project.id, sessionId, meta, st, isStartup);
      model.files.set(fp, tail);
      model.codexTailsBySession.set(sessionId, tail);
      if (isStartup && now - st.mtimeMs < ACTIVE_WINDOW_MS) {
        setModel(model, ensureProviderShip(
          model, 'codex', project.id, sessionId, meta.kind, st.mtimeMs, meta.parentSessionId
        ), meta.local, meta.model);
      }
    } else {
      tail.project = project.id;
      model.files.set(fp, tail);
    }
  }

  for (const [projectId, bytes] of totals) {
    const project = model.projects.get(projectId);
    if (!project) continue;
    project.codexBytes = bytes;
    project.totalBytes = (project.claudeBytes || 0) + bytes;
  }
  for (const fp of model.codexMetaCache.keys()) {
    if (!candidatePaths.has(fp)) model.codexMetaCache.delete(fp);
  }
  for (const [sessionId, tail] of model.codexTailsBySession) {
    if (candidatePaths.has(tail.path)) {
      tail.missingScans = 0;
      continue;
    }
    tail.missingScans = (tail.missingScans || 0) + 1;
    if (tail.missingScans < MISSING_SCANS_LIMIT) continue;
    model.files.delete(tail.path);
    model.codexTailsBySession.delete(sessionId);
  }
}

/**
 * At startup a rollout is tailed from its end, so its adapter is primed with a session_meta
 * built from the head's metadata alone. Found mid-run, it is read from zero in catchup mode.
 * @param {string} fp
 * @param {string} projectId
 * @param {string} sessionId
 * @param {any} meta
 * @param {import('fs').Stats} st
 * @param {boolean} isStartup
 * @returns {LiveTail}
 */
function newCodexTail(fp, projectId, sessionId, meta, st, isStartup) {
  let adapterState = createAdapterState('codex', {
    sessionId,
  });
  if (isStartup) {
    const safeMetaLine = JSON.stringify({
      timestamp: meta.timestamp || st.mtimeMs,
      type: 'session_meta',
      payload: {
        id: sessionId, session_id: sessionId, cwd: meta.cwd,
        thread_source: meta.kind === 'drone' ? 'subagent' : 'user',
        ...(meta.parentSessionId ? { parent_thread_id: meta.parentSessionId } : {}),
      },
    });
    const primed = adaptLine('codex', safeMetaLine, adapterState, { lineOffset: 0, now: st.mtimeMs });
    if (primed && primed.state) adapterState = primed.state;
  }
  return {
    provider: 'codex', path: fp, project: projectId, session: sessionId,
    offset: isStartup ? st.size : 0,
    catchup: !isStartup,
    remainder: Buffer.alloc(0),
    adapterState,
    kind: meta.kind,
    parentSessionId: meta.parentSessionId || null,
    local: meta.local,
    model: meta.model,
  };
}

/**
 * @param {LiveModel} model
 * @param {string} fp
 * @param {string} sessionId
 * @param {import('fs').Stats} stat
 */
function readCodexMetadata(model, fp, sessionId, stat) {
  const cached = model.codexMetaCache.get(fp);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.meta;
  const meta = readCodexOwnMetadata(fp, sessionId);
  model.codexMetaCache.set(fp, { size: stat.size, mtimeMs: stat.mtimeMs, meta });
  return meta;
}

function listFilesRecursive(root, extension) {
  const out = [];
  const queue = [root];
  while (queue.length) {
    const dir = queue.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const fp = path.join(dir, entry.name);
      if (entry.isDirectory()) queue.push(fp);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(extension)) out.push(fp);
    }
  }
  return out;
}

// The rollout's own session_meta; a forked child's head also holds its parent's.
function readCodexOwnMetadata(file, sessionId) {
  try {
    const fd = fs.openSync(file, 'r');
    const size = Math.min(fs.fstatSync(fd).size, META_HEAD_BYTES);
    const buf = Buffer.alloc(size);
    const n = fs.readSync(fd, buf, 0, size, 0);
    fs.closeSync(fd);
    let fallback = null;
    for (const line of buf.toString('utf8', 0, n).split(/\r?\n/)) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const payload = record && record.payload;
      if (record.type !== 'session_meta' || !payload) continue;
      const session = codexRecordToSignals(record).find((item) => item.type === 'session');
      if (!session) continue;
      const recordSessionId = session.sessionId;
      const result = {
        sessionId: recordSessionId,
        cwd: session.cwd,
        parentSessionId: codexParentSessionId(payload),
        kind: session.kind,
        local: session.local,
        model: typeof session.model === 'string' ? session.model : null,
        timestamp: session.ts || 0,
      };
      if (recordSessionId === sessionId) return result;
      if (!fallback) fallback = result;
    }
    const strictFilenameId = STRICT_SESSION_ID.test(sessionId);
    return strictFilenameId ? null : fallback;
  } catch { /* unreadable or locked sessions are retried on the next scan */ }
  return null;
}

module.exports = { scanCodex };

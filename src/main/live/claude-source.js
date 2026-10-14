// @ts-check
'use strict';

// Discovers Claude Code projects (one ~/.claude/projects/<slug> folder each) and decides which
// of their transcripts to tail.

const fs = require('fs');
const path = require('path');
const { canonicalProjectPath, isLocalProjectPath } = require('../provider-adapters');
const { pushFeed } = require('./events');
const { ACTIVE_WINDOW_MS, HOT_WINDOW_MS } = require('./model');
const {
  createProject, adoptProjectPath, updateProjectExists, preferredProjectPath,
} = require('./projects');
const { ensureShip } = require('./ships');

/** @import { LiveModel, LiveTail } from '../../types/live-model' */

const CWD_HEAD_BYTES = 32768;

/**
 * @param {LiveModel} model
 * @param {boolean} isStartup
 */
function scanClaude(model, isStartup) {
  let dirs;
  try {
    dirs = fs.readdirSync(model.claudeProjectsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return; // no ~/.claude/projects yet
  }
  const now = Date.now();
  for (const d of dirs) {
    const slug = d.name;
    const dirPath = path.join(model.claudeProjectsDir, slug);
    let entries;
    try {
      entries = fs.readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    if (entries.length === 0) continue;

    let project = model.projects.get(slug);
    let totalBytes = 0;
    let newest = 0;
    let newestFile = null;
    const stats = [];
    for (const f of entries) {
      const fp = path.join(dirPath, f);
      let st;
      try { st = fs.statSync(fp); } catch { continue; }
      totalBytes += st.size;
      stats.push({ fp, st });
      if (st.mtimeMs > newest) { newest = st.mtimeMs; newestFile = fp; }
    }

    if (!project || (!project.path && newest > project.lastActivity)) {
      const discoveredPath = newestFile ? readCwd(newestFile) : null;
      const pathKey = canonicalProjectPath(discoveredPath);
      const mappedId = pathKey && (model.projectPathIndex.get(pathKey) || model.pathIds[pathKey]);
      if (mappedId) project = model.projects.get(mappedId);
      const projectId = project ? project.id : (mappedId || slug);
      const projPath = preferredProjectPath(model, projectId, discoveredPath);
      if (!project) {
        project = createProject(model, projectId, projPath, { lastActivity: newest, totalBytes, claudeBytes: totalBytes });
        if (!isStartup) pushFeed(model, 'discover', `New system discovered: ${project.name}`, project.id);
      } else if (projPath) {
        adoptProjectPath(model, project, projPath);
      }
      if (pathKey) {
        model.projectPathIndex.set(pathKey, project.id);
        model.pathIds[pathKey] = project.id;
      }
    }
    project.claudeBytes = totalBytes;
    project.totalBytes = totalBytes + (project.codexBytes || 0);
    if (newest > project.lastActivity) project.lastActivity = newest;
    if (project.path) updateProjectExists(model, project);

    // Tail any file fresh enough to matter; at startup, note where every file ends.
    for (const { fp, st } of stats) {
      const hot = now - st.mtimeMs <= HOT_WINDOW_MS;
      if (model.files.has(fp) || !(hot || isStartup)) continue;
      const tail = claudeTail(model, fp, project.id, st.size, isStartup);
      if (!hot) continue;
      model.files.set(fp, tail);
      if (isStartup && now - st.mtimeMs < ACTIVE_WINDOW_MS) {
        ensureShip(model, project.id, tail.session, false, st.mtimeMs);
      }
    }
  }
}

/**
 * A transcript keeps one tail for the whole run, so a session that goes cold and resumes
 * reads on from where it stopped. Startup doesn't replay history: it tails from the end. A
 * file appearing while we run (or replacing a longer one) is a new session: replay it from
 * zero in catchup mode so its ship materializes with correct state.
 * @param {LiveModel} model
 * @param {string} fp
 * @param {string} projectId
 * @param {number} size
 * @param {boolean} isStartup
 * @returns {LiveTail}
 */
function claudeTail(model, fp, projectId, size, isStartup) {
  const known = model.claudeTails.get(fp);
  if (known && known.offset <= size) return known;
  const tail = {
    provider: 'claude', project: projectId, session: path.basename(fp, '.jsonl'),
    offset: isStartup ? size : 0, catchup: !isStartup, remainder: '',
  };
  model.claudeTails.set(fp, tail);
  return tail;
}

// Reads the head of a transcript to find the project's real cwd.
/** @param {string} file */
function readCwd(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(CWD_HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const m = buf.toString('utf8', 0, n).match(/"cwd":"((?:[^"\\]|\\.)*)"/);
    if (m) {
      const cwd = JSON.parse(`"${m[1]}"`);
      return isLocalProjectPath(cwd) ? cwd : null;
    }
  } catch { /* unreadable head is fine */ }
  return null;
}

module.exports = { scanClaude, readCwd };

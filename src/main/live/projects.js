// @ts-check
'use strict';

// The live project registry: which id a project path maps to, which path a project shows, and
// whether that folder still exists.

const fs = require('fs');
const path = require('path');
const { canonicalProjectPath, isLocalProjectPath } = require('../provider-adapters');
const { hex8 } = require('../shared/hash');
const { liveProject } = require('../universe/public-shape');
const { queue, pushFeed, flush } = require('./events');
const { saveState } = require('./state-file');

/**
 * @import { Project } from '../../types/contract'
 * @import { LiveModel, LiveProject } from '../../types/live-model'
 */

function trackerPathError(code, message) {
  const error = /** @type {NodeJS.ErrnoException} */ (new Error(message));
  error.code = code;
  return error;
}

function isProjectDirectory(projectPath) {
  // Security: transcript-derived paths reach the filesystem here on every scan.
  // Never stat a UNC or device path (forced SMB authentication), see isLocalProjectPath.
  if (!isLocalProjectPath(projectPath) || !path.isAbsolute(projectPath)) return false;
  try {
    return fs.statSync(projectPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A new project record, announced. Build counts and first sight come from `fields` when an
 * earlier run saved them.
 * @param {LiveModel} model
 * @param {string} id
 * @param {string | null} projPath
 * @param {Partial<LiveProject>} fields
 * @returns {LiveProject}
 */
function createProject(model, id, projPath, fields) {
  const project = {
    id,
    path: projPath,
    name: fields.name || (projPath && path.basename(projPath)) || id,
    exists: isProjectDirectory(projPath),
    lastActivity: fields.lastActivity || 0,
    totalBytes: fields.totalBytes || 0,
    claudeBytes: fields.claudeBytes || 0,
    codexBytes: fields.codexBytes || 0,
    buckets: fields.buckets || {},
    totalBuilds: fields.totalBuilds || 0,
    firstSeen: fields.firstSeen || Date.now(),
  };
  model.projects.set(id, project);
  indexProjectPath(model, project);
  queue(model, { type: 'project-added', project: liveProject(project) });
  return project;
}

/**
 * A project that had no folder learns one.
 * @param {LiveModel} model
 * @param {LiveProject} project
 * @param {string} projPath
 */
function adoptProjectPath(model, project, projPath) {
  project.path = projPath;
  project.name = path.basename(projPath) || project.name;
  project.exists = isProjectDirectory(projPath);
  indexProjectPath(model, project);
  model.systemCache.delete(project.id);
  queue(model, { type: 'project-updated', project: liveProject(project) });
}

/**
 * Brings back every project an earlier run saved, before the first scan: a project outlives
 * the transcripts it was found in.
 * @param {LiveModel} model
 */
function restoreRememberedProjects(model) {
  for (const [id, saved] of Object.entries(model.persisted.projects)) {
    if (model.projects.has(id)) continue;
    const projPath = preferredProjectPath(model, id, saved.path || null);
    createProject(model, id, projPath, {
      name: projPath ? undefined : saved.name,
      lastActivity: saved.lastActivity || saved.firstSeen,
      buckets: saved.buckets, totalBuilds: saved.totalBuilds, firstSeen: saved.firstSeen,
    });
  }
}

/**
 * Re-checks the project folder and announces a change.
 * @param {LiveModel} model
 * @param {LiveProject} project
 */
function updateProjectExists(model, project) {
  const exists = isProjectDirectory(project.path);
  if (exists === project.exists) return;
  project.exists = exists;
  model.systemCache.delete(project.id);
  queue(model, { type: 'project-updated', project: liveProject(project) });
}

/** @param {LiveModel} model */
function refreshProjectExistence(model) {
  for (const project of model.projects.values()) updateProjectExists(model, project);
}

/**
 * @param {LiveModel} model
 * @param {LiveProject} project
 */
function indexProjectPath(model, project) {
  const key = canonicalProjectPath(project && project.path);
  if (!key) return;
  model.projectPathIndex.set(key, project.id);
  model.pathIds[key] = project.id;
}

/**
 * @param {LiveModel} model
 * @param {string} projectId
 * @param {string | null} discoveredPath
 */
function preferredProjectPath(model, projectId, discoveredPath) {
  const override = model.pathOverrides[projectId];
  if (typeof override === 'string' && path.isAbsolute(override) && isLocalProjectPath(override)) {
    return path.normalize(override);
  }
  return isLocalProjectPath(discoveredPath) ? discoveredPath : null;
}

/**
 * Points a missing project at the folder it moved to, and saves that choice.
 * @param {LiveModel} model
 * @param {string} projectId
 * @param {unknown} nextPath
 * @returns {Project}
 */
function remapProjectPath(model, projectId, nextPath) {
  const project = model.projects.get(projectId);
  if (!project) throw trackerPathError('NOT_FOUND', 'project was not found');
  if (project.exists === true) {
    throw trackerPathError('NOT_MISSING', 'only missing project paths can be recovered');
  }
  if (typeof nextPath !== 'string' || !path.isAbsolute(nextPath)) {
    throw trackerPathError('INVALID', 'project path must be absolute');
  }

  let real;
  try {
    real = path.normalize(fs.realpathSync.native(nextPath));
    if (!fs.statSync(real).isDirectory()) {
      throw trackerPathError('INVALID', 'project path must be a directory');
    }
  } catch (error) {
    if (error && error.code === 'INVALID') throw error;
    throw trackerPathError('NOT_FOUND', 'project directory is unavailable');
  }

  const key = canonicalProjectPath(real);
  if (!key) throw trackerPathError('INVALID', 'project path is invalid');
  const owner = model.projectPathIndex.get(key) || model.pathIds[key];
  if (owner && owner !== projectId) {
    throw trackerPathError('IN_USE', 'project path is already assigned');
  }
  for (const other of model.projects.values()) {
    if (!other || other.id === projectId || !isProjectDirectory(other.path)) continue;
    try {
      if (canonicalProjectPath(fs.realpathSync.native(other.path)) === key) {
        throw trackerPathError('IN_USE', 'project path is already assigned');
      }
    } catch (error) {
      if (error && error.code === 'IN_USE') throw error;
    }
  }

  const previous = {
    path: project.path,
    name: project.name,
    exists: project.exists,
    hadOverride: Object.prototype.hasOwnProperty.call(model.pathOverrides, projectId),
    override: model.pathOverrides[projectId],
    hadIndex: model.projectPathIndex.has(key),
    indexOwner: model.projectPathIndex.get(key),
    hadPathId: Object.prototype.hasOwnProperty.call(model.pathIds, key),
    pathIdOwner: model.pathIds[key],
  };
  project.path = real;
  project.name = path.basename(real) || project.name;
  project.exists = true;
  model.pathOverrides[projectId] = real;
  model.projectPathIndex.set(key, projectId);
  model.pathIds[key] = projectId;
  model.systemCache.delete(projectId);
  try {
    saveState(model, true);
  } catch {
    project.path = previous.path;
    project.name = previous.name;
    project.exists = previous.exists;
    if (previous.hadOverride) model.pathOverrides[projectId] = previous.override;
    else delete model.pathOverrides[projectId];
    if (previous.hadIndex) model.projectPathIndex.set(key, previous.indexOwner);
    else model.projectPathIndex.delete(key);
    if (previous.hadPathId) model.pathIds[key] = previous.pathIdOwner;
    else delete model.pathIds[key];
    throw trackerPathError('FAILED', 'project path could not be saved');
  }
  const visible = liveProject(project);
  queue(model, { type: 'project-updated', project: visible });
  pushFeed(model, 'discover', `Project path recovered: ${project.name}`, projectId);
  flush(model);
  return visible;
}

/**
 * The project a Codex or Signal path belongs to, created on first sight.
 * @param {LiveModel} model
 * @param {string} projectPath
 * @param {string | null} fallbackId
 * @param {number} activity
 * @param {number} [totalBytes]
 * @returns {LiveProject | null}
 */
function ensureProjectForPath(model, projectPath, fallbackId, activity, totalBytes = 0) {
  // Security follow-up: canonicalProjectPath trims; trim here too so every later check sees the same path.
  if (typeof projectPath === 'string') projectPath = projectPath.trim();
  const key = canonicalProjectPath(projectPath);
  if (!key) return null;
  let id = model.projectPathIndex.get(key) || model.pathIds[key];
  if (!id) {
    const legacyClaudeId = String(projectPath).replace(/[^A-Za-z0-9]/g, '-');
    if (model.projects.has(legacyClaudeId) && !model.projects.get(legacyClaudeId).path) {
      id = legacyClaudeId;
    }
  }
  if (!id) {
    id = fallbackId || `project:${hex8(key)}`;
    if (model.projects.has(id) && canonicalProjectPath(model.projects.get(id).path) !== key) {
      id = `${id}:${hex8(key)}`;
    }
  }
  let project = model.projects.get(id);
  const preferredPath = preferredProjectPath(model, id, projectPath);
  if (!project) {
    project = createProject(model, id, preferredPath, { lastActivity: activity, totalBytes, codexBytes: totalBytes });
  } else {
    if (activity > project.lastActivity) project.lastActivity = activity;
    // Security follow-up: only adopt a path that survived preferredProjectPath (never null).
    if (!project.path && preferredPath) adoptProjectPath(model, project, preferredPath);
  }
  model.projectPathIndex.set(key, id);
  model.pathIds[key] = id;
  return project;
}

module.exports = {
  isProjectDirectory,
  createProject,
  adoptProjectPath,
  restoreRememberedProjects,
  updateProjectExists,
  refreshProjectExistence,
  indexProjectPath,
  preferredProjectPath,
  remapProjectPath,
  ensureProjectForPath,
};

// @ts-check
'use strict';

// The live project registry: which id a project path maps to, which path a project shows, and
// whether that folder still exists. What the owner does to a project by hand is project-edits.js.

const fs = require('fs');
const path = require('path');
const { setProjectPath } = require('../build-buckets');
const { canonicalProjectPath, isLocalProjectPath } = require('../provider-adapters');
const { localAbsolutePath } = require('../path-safety');
const { hex8 } = require('../shared/hash');
const { liveProject } = require('../universe/public-shape');
const { queue } = require('./events');
const { stillForgotten } = require('./forgotten');
const { savedProject } = require('./saved-project');

/** @import { LiveModel, LiveProject, SavedProject } from '../../types/live-model' */

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
 * earlier run saved them; `counted` is false when it saved those counts for a project with no
 * path. `fields.name` is its name only while it has no folder to be named for.
 * @param {LiveModel} model
 * @param {string} id
 * @param {string | null} projPath
 * @param {Partial<LiveProject>} fields
 * @param {boolean} [counted]
 * @returns {LiveProject}
 */
function createProject(model, id, projPath, fields, counted = true) {
  /** @type {LiveProject} */
  const project = {
    id,
    path: null,
    name: fields.name || id,
    exists: false,
    lastActivity: fields.lastActivity || 0,
    totalBytes: fields.totalBytes || 0,
    claudeBytes: fields.claudeBytes || 0,
    codexBytes: fields.codexBytes || 0,
    buckets: fields.buckets || {},
    totalBuilds: fields.totalBuilds || 0,
    firstSeen: fields.firstSeen || Date.now(),
  };
  takeProjectPath(model, project, projPath, counted);
  model.projects.set(id, project);
  queue(model, { type: 'project-added', project: liveProject(project) });
  return project;
}

/**
 * A project that had no folder learns one, and the change is announced.
 * @param {LiveModel} model
 * @param {LiveProject} project
 * @param {string} projPath
 */
function adoptProjectPath(model, project, projPath) {
  takeProjectPath(model, project, projPath);
  announceProjectUpdated(model, project);
}

/**
 * The one way a project takes a path (or none, at its creation), with what follows from it: one
 * bucket per folder by the rule of that path, every count a whole one (setProjectPath), the
 * folder's name, whether the folder is there, and the path index. The caller announces it.
 * `counted` is setProjectPath's: left out, the buckets of a project that had no path were not
 * counted under one, and of a folder's casings the larger stays.
 * @param {LiveModel} model
 * @param {LiveProject} project
 * @param {string | null} projPath
 * @param {boolean} [counted]
 * @returns {() => void} gives the path back: each of those as it was before
 */
function takeProjectPath(model, project, projPath, counted) {
  const key = canonicalProjectPath(projPath);
  const was = { path: project.path, buckets: project.buckets, name: project.name, exists: project.exists };
  const index = key && { had: model.projectPathIndex.has(key), id: model.projectPathIndex.get(key) };
  const pathId = key && { had: Object.hasOwn(model.pathIds, key), id: model.pathIds[key] };
  setProjectPath(project, projPath, counted);
  project.name = (projPath && path.basename(projPath)) || project.name;
  project.exists = isProjectDirectory(projPath);
  indexProjectPath(model, project);
  return () => {
    setProjectPath(project, was.path);
    // The buckets as the very object they were: once joined by the new path's rule they cannot
    // be told apart again, and a fold of them would be a copy.
    Object.assign(project, { buckets: was.buckets, name: was.name, exists: was.exists });
    if (!key) return;
    if (index.had) model.projectPathIndex.set(key, index.id);
    else model.projectPathIndex.delete(key);
    if (pathId.had) model.pathIds[key] = pathId.id;
    else delete model.pathIds[key];
  };
}

/**
 * Tells the renderer a project changed and drops its cached system view.
 * @param {LiveModel} model
 * @param {LiveProject} project
 */
function announceProjectUpdated(model, project) {
  model.systemCache.delete(project.id);
  queue(model, { type: 'project-updated', project: liveProject(project) });
}

/**
 * Brings back every project an earlier run saved, before the first scan: a project outlives
 * the transcripts it was found in.
 * @param {LiveModel} model
 */
function restoreRememberedProjects(model) {
  for (const [id, entry] of Object.entries(model.persisted.projects)) {
    // A state file is read as it is: an entry that is not a project record is passed over.
    const saved = savedProject(entry);
    if (saved && !model.projects.has(id)) restoreProject(model, id, saved);
  }
}

/**
 * A project as the state file, or a backup, keeps it: `saved` is from the one reader
 * (saved-project.js), so its fields are taken as they are.
 * @param {LiveModel} model
 * @param {string} id
 * @param {SavedProject} saved
 * @returns {LiveProject}
 */
function restoreProject(model, id, saved) {
  return createProject(model, id, preferredProjectPath(model, id, saved.path), {
    name: saved.name, lastActivity: saved.lastActivity || saved.firstSeen,
    buckets: saved.buckets, totalBuilds: saved.totalBuilds, firstSeen: saved.firstSeen,
  }, saved.counted);
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
  announceProjectUpdated(model, project);
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
 * The project id a canonical path maps to. It can name a forgotten project (forgotten.js).
 * @param {LiveModel} model
 * @param {string | null} key
 * @returns {string | null}
 */
function projectIdAtPath(model, key) {
  return (key && (model.projectPathIndex.get(key) || model.pathIds[key])) || null;
}

/**
 * @param {LiveModel} model
 * @param {string} projectId
 * @param {string | null} discoveredPath
 */
function preferredProjectPath(model, projectId, discoveredPath) {
  const override = localAbsolutePath(model.pathOverrides[projectId]);
  if (override) return override;
  return isLocalProjectPath(discoveredPath) ? discoveredPath : null;
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
  let id = projectIdAtPath(model, key);
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
  if (!project && stillForgotten(model, id, activity)) return null;
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
  takeProjectPath,
  announceProjectUpdated,
  restoreRememberedProjects,
  restoreProject,
  updateProjectExists,
  refreshProjectExistence,
  indexProjectPath,
  projectIdAtPath,
  preferredProjectPath,
  ensureProjectForPath,
};

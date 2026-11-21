// @ts-check
'use strict';

// What the owner does to one project by hand: point a missing project at the folder it moved
// to, or forget it. Each is saved to the state file before it shows, and refuses with an error
// that carries a code for the IPC layer.

const fs = require('fs');
const path = require('path');
const { canonicalProjectPath } = require('../provider-adapters');
const { liveProject } = require('../universe/public-shape');
const { queue, pushFeed, flush } = require('./events');
const { saveState, serializeState, writeState } = require('./state-file');
const { projectHasShips } = require('./ships');
const { isProjectDirectory, projectIdAtPath, takeProjectPath } = require('./projects');

/**
 * @import { Project } from '../../types/contract'
 * @import { LiveModel } from '../../types/live-model'
 */

function trackerPathError(code, message) {
  const error = /** @type {NodeJS.ErrnoException} */ (new Error(message));
  error.code = code;
  return error;
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
  const owner = projectIdAtPath(model, key);
  if (owner && owner !== projectId && model.projects.has(owner)) {
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

  const hadOverride = Object.prototype.hasOwnProperty.call(model.pathOverrides, projectId);
  const override = model.pathOverrides[projectId];
  const giveBack = takeProjectPath(model, project, real);
  model.pathOverrides[projectId] = real;
  model.systemCache.delete(projectId);
  try {
    saveState(model, true);
  } catch {
    giveBack();
    if (hadOverride) model.pathOverrides[projectId] = override;
    else delete model.pathOverrides[projectId];
    throw trackerPathError('FAILED', 'project path could not be saved');
  }
  const visible = liveProject(project);
  queue(model, { type: 'project-updated', project: visible });
  pushFeed(model, 'discover', `Project path recovered: ${project.name}`, projectId);
  flush(model);
  return visible;
}

/**
 * Drops a project and its build history from the map and the state file, and records it as
 * forgotten so its old transcripts don't bring it back. Refused while an agent works there.
 * @param {LiveModel} model
 * @param {string} projectId
 * @param {number} [now]
 */
function forgetProject(model, projectId, now = Date.now()) {
  const project = model.projects.get(projectId);
  if (!project) throw trackerPathError('NOT_FOUND', 'project was not found');
  if (projectHasShips(model.ships, projectId)) {
    throw trackerPathError('ACTIVE', 'an agent is working in this project');
  }
  // The file is written first; memory changes only once the forgetting is saved. Path keys
  // stay, now leading to the record.
  const record = { at: now, path: project.path };
  const out = serializeState(model);
  delete out.projects[projectId];
  delete out.pathOverrides[projectId];
  out.forgotten[projectId] = record;
  try {
    writeState(model.statePath, out);
  } catch {
    throw trackerPathError('FAILED', 'the forgotten project could not be saved');
  }
  model.projects.delete(projectId);
  delete model.pathOverrides[projectId];
  model.forgotten[projectId] = record;
  // Tails stop here but keep their offsets: a project that returns reads on from them.
  for (const [fp, tail] of model.files) if (tail.project === projectId) model.files.delete(fp);
  model.feed = model.feed.filter((entry) => entry.project !== projectId);
  model.systemCache.delete(projectId);
}

module.exports = { remapProjectPath, forgetProject };

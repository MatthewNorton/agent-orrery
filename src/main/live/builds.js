// @ts-check
'use strict';

// A verified edit grows its project: one build in the edited file's top-level folder.

const path = require('path');
const { relativeInside } = require('../path-safety');
const { bucketOf, countBuild } = require('../build-buckets');
const { queue, pushFeed } = require('./events');

/** @import { LiveModel, LiveProject, LiveShip } from '../../types/live-model' */

const BUILD_FILES_LIMIT = 64;

// Counts an edit to a file inside the project; catchup counts it without announcing it.
/**
 * @param {LiveModel} model
 * @param {LiveProject} project
 * @param {LiveShip} ship
 * @param {string} rel
 * @param {number} ts
 * @param {boolean} catchup
 */
function addBuild(model, project, ship, rel, ts, catchup) {
  const bucket = bucketOf(rel, path.sep);
  const isNew = countBuild(project, bucket);
  project.totalBuilds += 1;
  ship.builds += 1;
  model.systemCache.delete(project.id);
  if (catchup) return;
  queue(model, {
    type: 'build', project: project.id, bucket, file: rel,
    shipId: ship.id, isNew, ts,
  });
  if (isNew) pushFeed(model, 'form', `Planet formation started: ${bucket} in ${project.name}`, project.id);
  pushFeed(model, 'build', `${ship.name} building ${rel} in ${project.name}`, project.id);
}

/**
 * The files of one provider patch: each file inside the project counts once.
 * @param {LiveModel} model
 * @param {LiveShip} ship
 * @param {unknown} files
 * @param {number} ts
 * @param {boolean} catchup
 */
function applyProviderBuildFiles(model, ship, files, ts, catchup) {
  const project = model.projects.get(ship.project);
  if (!project || !Array.isArray(files)) return;
  const seen = new Set();
  for (const item of files.slice(0, BUILD_FILES_LIMIT)) {
    const filePath = typeof item === 'string' ? item : (item && (item.movePath || item.path));
    const rel = relativeInside(project.path, filePath);
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    addBuild(model, project, ship, rel, ts, catchup);
  }
}

module.exports = { addBuild, applyProviderBuildFiles };

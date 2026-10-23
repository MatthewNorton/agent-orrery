// @ts-check
'use strict';

// Forgotten projects. Forgetting drops a project from the map and the state file, but its
// transcripts stay on disk and the next scan would find it again; this record keeps it away
// while everything they hold predates the forgetting. The project's path keys in pathIds keep
// pointing at its id, so a transcript from any folder it lived in resolves to the record.
// Newer work lifts the record, and the project comes back as a new system.

/** @import { LiveModel, PersistedState, ForgottenProject } from '../../types/live-model' */

/**
 * The forgotten records an earlier run saved.
 * @param {PersistedState} persisted
 */
function loadForgotten(persisted) {
  /** @type {Record<string, ForgottenProject>} */
  const forgotten = Object.create(null);
  const saved = persisted.forgotten && typeof persisted.forgotten === 'object' ? persisted.forgotten : {};
  for (const [projectId, entry] of Object.entries(saved)) {
    if (!projectId || !entry || !Number.isFinite(entry.at)) continue;
    forgotten[projectId] = { at: entry.at, path: typeof entry.path === 'string' ? entry.path : null };
  }
  return forgotten;
}

/**
 * The id, while the project it names is forgotten and `activity` predates the forgetting;
 * null otherwise. Later activity lifts the record on the way.
 * @param {LiveModel} model
 * @param {string | null} projectId
 * @param {number} activity
 * @returns {string | null}
 */
function stillForgotten(model, projectId, activity) {
  if (!projectId || !model.forgotten[projectId]) return null;
  if (activity <= model.forgotten[projectId].at) return projectId;
  liftForgotten(model, projectId);
  return null;
}

/**
 * @param {LiveModel} model
 * @param {string} projectId
 */
function liftForgotten(model, projectId) {
  if (!model.forgotten[projectId]) return;
  delete model.forgotten[projectId];
  for (const [slug, id] of model.forgottenSlugs) {
    if (id === projectId) model.forgottenSlugs.delete(slug);
  }
}

module.exports = { loadForgotten, stillForgotten, liftForgotten };

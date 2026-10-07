// @ts-check
'use strict';

const { boundedInteger } = require('./shared/values');

/** @typedef {InstanceType<typeof import('./tracker').Tracker>} Tracker */
/** @import { ProjectVcsStatusService } from './project-vcs-status-service' */

const DEFAULT_DEBOUNCE_MS = 400;

/**
 * @typedef {object} ProjectVcsStatusControllerOptions
 * @property {Tracker} [tracker]
 * @property {ProjectVcsStatusService} [service]
 * @property {typeof setTimeout} [schedule]
 * @property {typeof clearTimeout} [cancel]
 * @property {number} [debounceMs]
 * @property {(error: Error) => void} [onError]
 */

/** @param {ProjectVcsStatusControllerOptions} [options] */
function createProjectVcsStatusController(options = {}) {
  /** @type {ProjectVcsStatusControllerOptions} */
  const settings = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const tracker = settings.tracker;
  const service = settings.service;
  if (!tracker || !(tracker.projects instanceof Map)) {
    throw new TypeError('project VCS controller requires a tracker project map');
  }
  if (!service || typeof service.refresh !== 'function' ||
      typeof service.refreshProject !== 'function' || typeof service.get !== 'function') {
    throw new TypeError('project VCS controller requires a status service');
  }
  const schedule = typeof settings.schedule === 'function' ? settings.schedule : setTimeout;
  const cancel = typeof settings.cancel === 'function' ? settings.cancel : clearTimeout;
  const debounceMs = boundedInteger(settings.debounceMs, DEFAULT_DEBOUNCE_MS, 0, 5_000);
  const onError = typeof settings.onError === 'function' ? settings.onError : () => {};
  const pending = new Map();
  let stopped = false;

  function report(error) {
    try { onError(error); } catch { /* diagnostics cannot break the controller */ }
  }

  function projects() {
    return [...tracker.projects.values()];
  }

  async function refreshAll(options = {}) {
    if (stopped) return Object.freeze([]);
    try {
      return await service.refresh(projects(), options);
    } catch (error) {
      report(error);
      return Object.freeze([]);
    }
  }

  async function refreshProject(projectId, options = {}) {
    if (stopped || typeof projectId !== 'string' || !projectId) return null;
    const project = tracker.projects.get(projectId);
    if (!project) return null;
    try {
      return await service.refreshProject(project, options);
    } catch (error) {
      report(error);
      return null;
    }
  }

  function scheduleProject(projectId) {
    if (stopped || typeof projectId !== 'string' || !tracker.projects.has(projectId)) return;
    const previous = pending.get(projectId);
    if (previous != null) cancel(previous);
    const timer = schedule(() => {
      pending.delete(projectId);
      refreshProject(projectId, { force: true });
    }, debounceMs);
    pending.set(projectId, timer);
  }

  function enrichProject(project) {
    if (!project || typeof project !== 'object' || typeof project.id !== 'string') return project;
    return { ...project, vcs: service.get(project.id) || null };
  }

  return Object.freeze({
    start() {
      if (stopped) return Promise.resolve(Object.freeze([]));
      return refreshAll();
    },
    refreshAll,
    refreshProject,
    observeEvents(batch) {
      if (stopped || !Array.isArray(batch)) return;
      for (const event of batch) {
        if (!event || typeof event !== 'object') continue;
        if ((event.type === 'project-added' || event.type === 'project-updated') &&
            event.project && typeof event.project.id === 'string') {
          scheduleProject(event.project.id);
        } else if (event.type === 'build' && typeof event.project === 'string') {
          scheduleProject(event.project);
        }
      }
    },
    enrichSnapshot(source, snapshot) {
      if (source !== tracker || !snapshot || !Array.isArray(snapshot.projects)) return snapshot;
      return { ...snapshot, projects: snapshot.projects.map(enrichProject) };
    },
    enrichSystem(source, system) {
      if (source !== tracker || !system || !system.project) return system;
      return { ...system, project: enrichProject(system.project) };
    },
    get(projectId) {
      return typeof projectId === 'string' ? service.get(projectId) || null : null;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      for (const timer of pending.values()) cancel(timer);
      pending.clear();
      if (typeof service.clear === 'function') service.clear();
    },
  });
}

module.exports = { createProjectVcsStatusController, DEFAULT_DEBOUNCE_MS };

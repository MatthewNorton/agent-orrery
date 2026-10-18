// @ts-check
'use strict';

const { boundedInteger, ownString } = require('../shared/values');

/** @import { ProjectVcsStatus } from '../../types/contract' */
/** @import { createLocalGitStatusCollector } from './collector' */
/** @import { createGitHubMetadataProvider } from './github-metadata-provider' */

const DEFAULT_TTL_MS = 15_000;
const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_MAX_PROJECTS = 500;
const GITHUB_FAILURE_CODES = new Set([
  'AUTH_REQUIRED', 'RATE_LIMITED', 'GH_UNAVAILABLE', 'GH_FAILED', 'TIMEOUT',
  'OUTPUT_LIMIT', 'INVALID_QUERY', 'INVALID_RESPONSE', 'REPOSITORY_UNAVAILABLE',
]);

function normalizedProject(project) {
  const projectId = ownString(project, 'id');
  const projectPath = ownString(project, 'path');
  const exists = !project || !Object.hasOwn(project, 'exists') || project.exists !== false;
  return projectId ? Object.freeze({ projectId, projectPath, exists }) : null;
}

function unavailableStatus(project, checkedAt, code) {
  return Object.freeze({
    projectId: project.projectId,
    projectPath: project.projectPath || null,
    checkedAt,
    state: 'unavailable',
    git: null,
    github: null,
    errorCode: code,
  });
}

function readyStatus(project, result, checkedAt) {
  if (!result || result.ok !== true || !result.git) {
    return unavailableStatus(
      project,
      checkedAt,
      result && typeof result.code === 'string' ? result.code : 'GIT_FAILED'
    );
  }
  return Object.freeze({
    projectId: project.projectId,
    projectPath: typeof result.projectPath === 'string' ? result.projectPath : project.projectPath,
    checkedAt,
    state: 'ready',
    git: result.git,
    github: result.github || null,
    errorCode: null,
  });
}

function comparable(status) {
  if (!status) return '';
  return JSON.stringify({
    projectPath: status.projectPath,
    state: status.state,
    git: status.git,
    github: status.github,
    errorCode: status.errorCode,
  });
}

function sameRepository(left, right) {
  return left && right && typeof left.nameWithOwner === 'string' &&
    typeof right.nameWithOwner === 'string' &&
    left.nameWithOwner.toLowerCase() === right.nameWithOwner.toLowerCase();
}

function retainGithubMetadata(previous, status) {
  if (!previous || !sameRepository(previous.github, status.github) ||
      status.github.state !== 'unknown' || previous.github.state === 'unknown') return status;
  const github = Object.freeze({
    ...status.github,
    state: previous.github.state,
    openPullRequests: Number.isSafeInteger(previous.github.openPullRequests)
      ? previous.github.openPullRequests : null,
    stale: previous.github.stale === true,
    checkedAt: Number.isFinite(previous.github.checkedAt) ? previous.github.checkedAt : null,
    errorCode: typeof previous.github.errorCode === 'string' ? previous.github.errorCode : null,
  });
  return Object.freeze({ ...status, github });
}

function mergeGithubMetadata(status, remote) {
  if (!status || !sameRepository(status.github, remote)) return status;
  const remoteState = remote.state === 'ready' ? 'ready'
    : remote.state === 'stale' ? 'stale' : 'error';
  const errorCode = typeof remote.errorCode === 'string' && GITHUB_FAILURE_CODES.has(remote.errorCode)
    ? remote.errorCode : remoteState === 'ready' ? null : 'GH_FAILED';
  const github = Object.freeze({
    ...status.github,
    state: remoteState,
    openPullRequests: Number.isSafeInteger(remote.openPullRequests) && remote.openPullRequests >= 0
      ? remote.openPullRequests : null,
    stale: remoteState === 'stale',
    checkedAt: Number.isFinite(remote.checkedAt) ? remote.checkedAt : null,
    errorCode,
  });
  return Object.freeze({ ...status, github });
}

/** @typedef {ReturnType<typeof createProjectVcsStatusService>} ProjectVcsStatusService */

/**
 * @typedef {object} ProjectVcsStatusServiceOptions
 * @property {ReturnType<typeof createLocalGitStatusCollector>} [collector]
 * @property {ReturnType<typeof createGitHubMetadataProvider>} [githubProvider]
 * @property {() => number} [clock]
 * @property {(status: ProjectVcsStatus) => void} [onChange]
 * @property {number} [ttlMs]
 * @property {number} [maxConcurrency]
 * @property {number} [maxProjects]
 */

/** @param {ProjectVcsStatusServiceOptions} [options] */
function createProjectVcsStatusService(options = {}) {
  /** @type {ProjectVcsStatusServiceOptions} */
  const settings = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const collector = settings.collector;
  if (!collector || typeof collector.read !== 'function') {
    throw new TypeError('project VCS status service requires a collector');
  }
  const githubProvider = settings.githubProvider &&
    typeof settings.githubProvider.readMany === 'function' ? settings.githubProvider : null;
  const clock = typeof settings.clock === 'function' ? settings.clock : Date.now;
  const onChange = typeof settings.onChange === 'function' ? settings.onChange : () => {};
  const ttlMs = boundedInteger(settings.ttlMs, DEFAULT_TTL_MS, 0, 10 * 60_000);
  const maxConcurrency = boundedInteger(
    settings.maxConcurrency, DEFAULT_MAX_CONCURRENCY, 1, 8
  );
  const maxProjects = boundedInteger(settings.maxProjects, DEFAULT_MAX_PROJECTS, 1, 2_000);
  const cache = new Map();
  const inFlight = new Map();
  const generations = new Map();

  function notify(status) {
    try { onChange(status); } catch { /* observers cannot break status collection */ }
  }

  function generation(projectId) {
    return generations.get(projectId) || 0;
  }

  function nextGeneration(projectId) {
    const next = generation(projectId) + 1;
    generations.set(projectId, next);
    return next;
  }

  function cached(project, now, force) {
    const entry = cache.get(project.projectId);
    if (!entry || force || entry.projectPath !== project.projectPath) return null;
    return now - entry.checkedAt <= ttlMs ? entry : null;
  }

  async function readProject(project, force) {
    const now = clock();
    const hit = cached(project, now, force);
    if (hit) return hit;

    if (!project.exists || !project.projectPath) {
      const status = unavailableStatus(
        project,
        now,
        project.exists ? 'INVALID_PATH' : 'PROJECT_UNAVAILABLE'
      );
      const previous = cache.get(project.projectId);
      cache.set(project.projectId, status);
      if (comparable(previous) !== comparable(status)) notify(status);
      return status;
    }

    const active = inFlight.get(project.projectId);
    if (active && active.projectPath === project.projectPath && !force) return active.promise;

    const currentGeneration = nextGeneration(project.projectId);
    const promise = Promise.resolve()
      .then(() => collector.read(project.projectPath))
      .then((result) => readyStatus(project, result, clock()))
      .catch(() => unavailableStatus(project, clock(), 'GIT_FAILED'))
      .then((status) => {
        if (generation(project.projectId) !== currentGeneration) {
          return cache.get(project.projectId) || status;
        }
        const previous = cache.get(project.projectId);
        const next = retainGithubMetadata(previous, status);
        cache.set(project.projectId, next);
        if (comparable(previous) !== comparable(next)) notify(next);
        return next;
      })
      .finally(() => {
        const current = inFlight.get(project.projectId);
        if (current && current.generation === currentGeneration) {
          inFlight.delete(project.projectId);
        }
      });
    inFlight.set(project.projectId, {
      projectPath: project.projectPath,
      generation: currentGeneration,
      promise,
    });
    return promise;
  }

  async function enrichGithub(statuses, force) {
    if (!githubProvider) return Object.freeze(statuses);
    const repositories = statuses
      .filter((status) => status && status.state === 'ready' && status.github)
      .map((status) => status.github);
    if (!repositories.length) return Object.freeze(statuses);
    let remoteStatuses;
    try {
      remoteStatuses = await githubProvider.readMany(repositories, { force });
    } catch {
      return Object.freeze(statuses);
    }
    const byRepository = new Map();
    for (const remote of Array.isArray(remoteStatuses) ? remoteStatuses : []) {
      if (remote && typeof remote.nameWithOwner === 'string') {
        byRepository.set(remote.nameWithOwner.toLowerCase(), remote);
      }
    }
    return Object.freeze(statuses.map((status) => {
      const current = cache.get(status.projectId);
      if (current !== status) return current || status;
      const key = status.github && typeof status.github.nameWithOwner === 'string'
        ? status.github.nameWithOwner.toLowerCase() : '';
      const remote = key ? byRepository.get(key) : null;
      if (!remote) return status;
      const next = mergeGithubMetadata(status, remote);
      if (comparable(status) !== comparable(next)) {
        cache.set(status.projectId, next);
        notify(next);
      }
      return next;
    }));
  }

  async function refresh(projects, options = {}) {
    const force = Boolean(options && options.force);
    const unique = new Map();
    for (const raw of Array.isArray(projects) ? projects : []) {
      if (unique.size >= maxProjects) break;
      const project = normalizedProject(raw);
      if (project && !unique.has(project.projectId)) unique.set(project.projectId, project);
    }
    const queue = [...unique.values()];
    const results = new Array(queue.length);
    let cursor = 0;

    async function worker() {
      while (cursor < queue.length) {
        const index = cursor++;
        results[index] = await readProject(queue[index], force);
      }
    }

    const workers = [];
    const workerCount = Math.min(maxConcurrency, queue.length);
    for (let index = 0; index < workerCount; index++) workers.push(worker());
    await Promise.all(workers);
    return enrichGithub(results, Boolean(options && options.forceGithub));
  }

  return Object.freeze({
    refresh,
    async refreshProject(project, options = {}) {
      const normalized = normalizedProject(project);
      if (!normalized) return null;
      const status = await readProject(normalized, Boolean(options.force));
      const enriched = await enrichGithub([status], Boolean(options && options.forceGithub));
      return enriched[0] || status;
    },
    get(projectId) {
      return typeof projectId === 'string' ? cache.get(projectId) || null : null;
    },
    snapshot() {
      return Object.freeze([...cache.values()]);
    },
    invalidate(projectId) {
      if (typeof projectId !== 'string' || !projectId) return false;
      nextGeneration(projectId);
      inFlight.delete(projectId);
      return cache.delete(projectId);
    },
    clear() {
      for (const projectId of new Set([...cache.keys(), ...inFlight.keys()])) {
        nextGeneration(projectId);
      }
      cache.clear();
      inFlight.clear();
    },
  });
}

module.exports = {
  createProjectVcsStatusService,
  normalizedProject,
  mergeGithubMetadata,
  DEFAULT_TTL_MS,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MAX_PROJECTS,
};

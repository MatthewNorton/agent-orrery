'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { boundedInteger, ownString, bufferValue } = require('./shared/values');
const { runBoundedProcess } = require('./shared/bounded-process');

const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_ERROR_TTL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_MAX_REPOSITORIES = 200;
const FAILURE_CODES = new Set([
  'AUTH_REQUIRED',
  'RATE_LIMITED',
  'GH_UNAVAILABLE',
  'GH_FAILED',
  'TIMEOUT',
  'OUTPUT_LIMIT',
  'INVALID_QUERY',
  'INVALID_RESPONSE',
  'REPOSITORY_UNAVAILABLE',
]);

function normalizeRepository(value) {
  const explicit = typeof value === 'string' ? value.trim() : ownString(value, 'nameWithOwner');
  const slash = explicit.indexOf('/');
  const owner = slash > 0 && slash === explicit.lastIndexOf('/')
    ? explicit.slice(0, slash) : ownString(value, 'owner');
  const repository = slash > 0 && slash === explicit.lastIndexOf('/')
    ? explicit.slice(slash + 1) : ownString(value, 'repository');
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner) ||
      !/^[A-Za-z0-9._-]{1,100}$/.test(repository) || repository === '.' || repository === '..') {
    return null;
  }
  return Object.freeze({
    owner,
    repository,
    nameWithOwner: `${owner}/${repository}`,
    cacheKey: `${owner}/${repository}`.toLowerCase(),
  });
}

function buildPullRequestQuery(repositories) {
  const normalized = [];
  for (const value of Array.isArray(repositories) ? repositories : []) {
    const repository = normalizeRepository(value);
    if (repository) normalized.push(repository);
  }
  const fields = normalized.map((repository, index) =>
    `r${index}: repository(owner: ${JSON.stringify(repository.owner)}, name: ${JSON.stringify(repository.repository)}) { pullRequests(states: [OPEN], first: 1) { totalCount } }`
  );
  return Object.freeze({
    query: `query ProjectPullRequests { ${fields.join(' ')} }`,
    repositories: Object.freeze(normalized),
  });
}

function metadata(repository, checkedAt, values = {}) {
  const count = Number.isSafeInteger(values.openPullRequests) && values.openPullRequests >= 0
    ? values.openPullRequests : null;
  return Object.freeze({
    nameWithOwner: repository.nameWithOwner,
    state: values.state === 'ready' ? 'ready'
      : values.state === 'stale' ? 'stale' : 'unavailable',
    openPullRequests: count,
    stale: values.state === 'stale',
    checkedAt,
    errorCode: typeof values.errorCode === 'string' ? values.errorCode : null,
  });
}

function failureCode(value) {
  return typeof value === 'string' && FAILURE_CODES.has(value) ? value : 'GH_FAILED';
}

function parseGraphqlResponse(value, repositories, checkedAt) {
  let payload;
  try {
    payload = Buffer.isBuffer(value) || typeof value === 'string'
      ? JSON.parse(bufferValue(value).toString('utf8')) : value;
  } catch {
    payload = null;
  }
  const data = payload && typeof payload === 'object' && !Array.isArray(payload) &&
    payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
    ? payload.data : null;
  return Object.freeze(repositories.map((repository, index) => {
    const result = data && Object.hasOwn(data, `r${index}`) ? data[`r${index}`] : null;
    const count = result && result.pullRequests && result.pullRequests.totalCount;
    return Number.isSafeInteger(count) && count >= 0
      ? metadata(repository, checkedAt, { state: 'ready', openPullRequests: count })
      : metadata(repository, checkedAt, { errorCode: data ? 'REPOSITORY_UNAVAILABLE' : 'INVALID_RESPONSE' });
  }));
}

function buildGhSpec(ghCommand, repositories, env, cwd) {
  const request = buildPullRequestQuery(repositories);
  if (!request.repositories.length) return null;
  const childEnv = { ...(env && typeof env === 'object' ? env : {}) };
  const dedicatedToken = ownString(childEnv, 'AGENT_UNIVERSE_GITHUB_TOKEN');
  delete childEnv.AGENT_UNIVERSE_GITHUB_TOKEN;
  delete childEnv.GH_HOST;
  delete childEnv.GH_REPO;
  delete childEnv.GH_ENTERPRISE_TOKEN;
  delete childEnv.GITHUB_ENTERPRISE_TOKEN;
  delete childEnv.GH_TOKEN;
  delete childEnv.GITHUB_TOKEN;
  if (dedicatedToken) childEnv.GH_TOKEN = dedicatedToken;
  return Object.freeze({
    command: ghCommand,
    args: Object.freeze([
      'api', 'graphql', '--hostname', 'github.com', '--method', 'POST',
      '-f', `query=${request.query}`,
    ]),
    options: Object.freeze({
      cwd,
      env: Object.freeze({
        ...childEnv,
        GH_PROMPT_DISABLED: '1',
        GH_NO_UPDATE_NOTIFIER: '1',
        GIT_TERMINAL_PROMPT: '0',
        NO_COLOR: '1',
      }),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  });
}

function runnerFailure(stderr) {
  const message = bufferValue(stderr).toString('utf8').toLowerCase();
  if (/auth|log in|login|gh_token|github_token/.test(message)) return 'AUTH_REQUIRED';
  if (/rate.?limit|secondary rate/.test(message)) return 'RATE_LIMITED';
  return 'GH_FAILED';
}

function ghResult({ exitCode, stdout, stderr }) {
  return exitCode === 0 ? { ok: true, stdout } : { ok: false, code: runnerFailure(stderr) };
}

function createGhPullRequestReader(options = {}) {
  const settings = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const ghCommand = ownString(settings, 'ghCommand') || 'gh';
  const env = settings.env && typeof settings.env === 'object' ? settings.env : process.env;
  const cwd = ownString(settings, 'cwd') || path.parse(process.cwd()).root;
  const limits = Object.freeze({
    spawnImpl: typeof settings.spawnImpl === 'function' ? settings.spawnImpl : spawn,
    timeoutMs: boundedInteger(settings.timeoutMs, DEFAULT_TIMEOUT_MS, 250, 60_000),
    maxOutputBytes: boundedInteger(
      settings.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 4_096, 4 * 1024 * 1024
    ),
    unavailableCode: 'GH_UNAVAILABLE',
    onClose: ghResult,
  });

  return async function readPullRequests(repositories) {
    const spec = buildGhSpec(ghCommand, repositories, env, cwd);
    if (!spec || Buffer.byteLength(spec.args[spec.args.length - 1], 'utf8') > 64 * 1024) {
      return { ok: false, code: 'INVALID_QUERY' };
    }
    return runBoundedProcess(spec, limits);
  };
}

function createGitHubMetadataProvider(options = {}) {
  const settings = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const readBatch = typeof settings.readBatch === 'function'
    ? settings.readBatch : createGhPullRequestReader(settings);
  const clock = typeof settings.clock === 'function' ? settings.clock : Date.now;
  const cacheTtlMs = boundedInteger(settings.cacheTtlMs, DEFAULT_CACHE_TTL_MS, 0, 60 * 60_000);
  const errorTtlMs = boundedInteger(settings.errorTtlMs, DEFAULT_ERROR_TTL_MS, 0, 5 * 60_000);
  const batchSize = boundedInteger(settings.batchSize, DEFAULT_BATCH_SIZE, 1, 50);
  const maxRepositories = boundedInteger(
    settings.maxRepositories, DEFAULT_MAX_REPOSITORIES, 1, 500
  );
  const cache = new Map();
  let queue = Promise.resolve();

  function failed(repository, code, now) {
    const prior = cache.get(repository.cacheKey);
    if (prior && prior.lastSuccess) {
      return metadata(repository, now, {
        state: 'stale',
        openPullRequests: prior.lastSuccess.openPullRequests,
        errorCode: code,
      });
    }
    return metadata(repository, now, { errorCode: code });
  }

  async function fetchBatch(repositories) {
    const request = buildPullRequestQuery(repositories);
    let result;
    try { result = await readBatch(request.repositories); } catch { result = null; }
    const now = clock();
    let values = result && result.ok === true
      ? parseGraphqlResponse(result.stdout, request.repositories, now)
      : request.repositories.map((repository) => failed(
        repository,
        failureCode(result && result.code),
        now
      ));
    values = values.map((value, index) => value.state === 'ready' ? value : failed(
      request.repositories[index], failureCode(value.errorCode), now
    ));
    values.forEach((value, index) => {
      const repository = request.repositories[index];
      const prior = cache.get(repository.cacheKey);
      cache.set(repository.cacheKey, {
        value,
        expiresAt: now + (value.state === 'ready' ? cacheTtlMs : errorTtlMs),
        lastSuccess: value.state === 'ready' ? value : prior && prior.lastSuccess,
      });
    });
  }

  async function performRead(repositories) {
    for (let index = 0; index < repositories.length; index += batchSize) {
      await fetchBatch(repositories.slice(index, index + batchSize));
    }
  }

  return Object.freeze({
    async readMany(values, options = {}) {
      const force = Boolean(options && options.force);
      const repositories = [];
      const unique = new Set();
      for (const value of Array.isArray(values) ? values : []) {
        if (repositories.length >= maxRepositories) break;
        const repository = normalizeRepository(value);
        if (repository && !unique.has(repository.cacheKey)) {
          unique.add(repository.cacheKey);
          repositories.push(repository);
        }
      }
      const now = clock();
      const missing = repositories.filter((repository) => {
        const entry = cache.get(repository.cacheKey);
        return force || !entry || entry.expiresAt < now;
      });
      if (missing.length) {
        const work = queue.then(() => performRead(missing), () => performRead(missing));
        queue = work.catch(() => {});
        await work;
      }
      return Object.freeze(repositories.map((repository) => cache.get(repository.cacheKey).value));
    },
    get(value) {
      const repository = normalizeRepository(value);
      const entry = repository && cache.get(repository.cacheKey);
      return entry ? entry.value : null;
    },
    clear() { cache.clear(); },
  });
}

module.exports = {
  createGitHubMetadataProvider,
  createGhPullRequestReader,
  buildGhSpec,
  buildPullRequestQuery,
  parseGraphqlResponse,
  normalizeRepository,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_ERROR_TTL_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_REPOSITORIES,
};

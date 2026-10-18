'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  createGitHubMetadataProvider,
  createGhPullRequestReader,
  buildGhSpec,
  buildPullRequestQuery,
  parseGraphqlResponse,
  normalizeRepository,
} = require('../src/main/vcs-status/github-metadata-provider');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kills = [];
  child.kill = (signal) => { child.kills.push(signal); return true; };
  return child;
}

function response(counts) {
  const data = {};
  counts.forEach((count, index) => {
    data[`r${index}`] = count == null ? null : { pullRequests: { totalCount: count } };
  });
  return { ok: true, stdout: Buffer.from(JSON.stringify({ data })) };
}

test('normalizes GitHub repository identities and rejects query-shaped input', () => {
  assert.deepEqual(normalizeRepository('OpenAI/codex'), {
    owner: 'OpenAI', repository: 'codex', nameWithOwner: 'OpenAI/codex', cacheKey: 'openai/codex',
  });
  assert.equal(normalizeRepository({ owner: 'example', repository: 'project.js' }).nameWithOwner,
    'example/project.js');
  assert.equal(normalizeRepository('example/repo) { viewer { login } }'), null);
  assert.equal(normalizeRepository('example/one/two'), null);
  assert.equal(normalizeRepository('../project'), null);
});

test('builds one aliased count-only GraphQL query for a repository batch', () => {
  const request = buildPullRequestQuery(['OpenAI/codex', 'octocat/Hello-World']);

  assert.equal(request.repositories.length, 2);
  assert.match(request.query, /^query ProjectPullRequests/);
  assert.match(request.query, /r0: repository\(owner: "OpenAI", name: "codex"\)/);
  assert.match(request.query, /r1: repository\(owner: "octocat", name: "Hello-World"\)/);
  assert.equal((request.query.match(/totalCount/g) || []).length, 2);
  assert.equal(request.query.includes('nodes'), false);
});

test('parses counts while isolating missing and malformed repositories', () => {
  const request = buildPullRequestQuery(['one/alpha', 'two/beta', 'three/gamma']);
  const values = parseGraphqlResponse(JSON.stringify({
    data: {
      r0: { pullRequests: { totalCount: 3 } },
      r1: null,
      r2: { pullRequests: { totalCount: -1 } },
    },
    errors: [{ path: ['r1'], message: 'private detail must not escape' }],
  }), request.repositories, 123);

  assert.deepEqual(values[0], {
    nameWithOwner: 'one/alpha', state: 'ready', openPullRequests: 3,
    stale: false, checkedAt: 123, errorCode: null,
  });
  assert.equal(values[1].state, 'unavailable');
  assert.equal(values[1].errorCode, 'REPOSITORY_UNAVAILABLE');
  assert.equal(Object.hasOwn(values[1], 'message'), false);
  assert.equal(values[2].state, 'unavailable');
});

test('caches successful reads, deduplicates identities, and refreshes after expiry', async () => {
  let now = 1_000;
  const queries = [];
  const provider = createGitHubMetadataProvider({
    clock: () => now,
    cacheTtlMs: 100,
    async readBatch(repositories) {
      queries.push(repositories);
      return response([2]);
    },
  });

  const first = await provider.readMany(['OpenAI/codex', 'openai/CODEX']);
  now += 100;
  const cached = await provider.readMany(['openai/codex']);
  now += 1;
  const expired = await provider.readMany(['openai/codex']);

  assert.equal(first.length, 1);
  assert.equal(first[0].openPullRequests, 2);
  assert.equal(cached[0], first[0]);
  assert.equal(expired[0].checkedAt, 1_101);
  assert.equal(queries.length, 2);
});

test('splits bounded batches and caps repositories accepted by one read', async () => {
  const batchSizes = [];
  const provider = createGitHubMetadataProvider({
    batchSize: 2,
    maxRepositories: 5,
    async readBatch(repositories) {
      const size = repositories.length;
      batchSizes.push(size);
      return response(new Array(size).fill(0));
    },
  });
  const values = await provider.readMany([
    'one/a', 'two/b', 'three/c', 'four/d', 'five/e', 'six/f',
  ]);

  assert.equal(values.length, 5);
  assert.deepEqual(batchSizes, [2, 2, 1]);
});

test('keeps a previous successful count as stale after a sanitized failure', async () => {
  let now = 1_000;
  let fail = false;
  const provider = createGitHubMetadataProvider({
    clock: () => now,
    cacheTtlMs: 100,
    errorTtlMs: 50,
    async readBatch() {
      return fail ? { ok: false, code: 'RATE_LIMITED', stderr: 'secret' } : response([4]);
    },
  });
  await provider.readMany(['example/project']);
  now += 101;
  fail = true;
  const [stale] = await provider.readMany(['example/project']);

  assert.deepEqual(stale, {
    nameWithOwner: 'example/project', state: 'stale', openPullRequests: 4,
    stale: true, checkedAt: 1_101, errorCode: 'RATE_LIMITED',
  });
  assert.equal(Object.hasOwn(stale, 'stderr'), false);
});

test('keeps a previous successful count when a later GraphQL response omits the repository', async () => {
  let now = 1_000;
  let available = true;
  const provider = createGitHubMetadataProvider({
    clock: () => now,
    cacheTtlMs: 100,
    async readBatch() { return response([available ? 7 : null]); },
  });
  await provider.readMany(['example/project']);
  now += 101;
  available = false;
  const [stale] = await provider.readMany(['example/project']);

  assert.equal(stale.state, 'stale');
  assert.equal(stale.openPullRequests, 7);
  assert.equal(stale.errorCode, 'REPOSITORY_UNAVAILABLE');
});

test('maps unexpected adapter errors to a stable public failure code', async () => {
  const provider = createGitHubMetadataProvider({
    async readBatch() { return { ok: false, code: 'private upstream detail' }; },
  });
  const [failed] = await provider.readMany(['example/project']);

  assert.equal(failed.errorCode, 'GH_FAILED');
});

test('serializes GraphQL calls so the provider never launches overlapping gh processes', async () => {
  let active = 0;
  let peak = 0;
  const gates = [];
  const provider = createGitHubMetadataProvider({
    batchSize: 1,
    readBatch() {
      active++;
      peak = Math.max(peak, active);
      return new Promise((resolve) => gates.push(() => {
        active--;
        resolve(response([0]));
      }));
    },
  });
  const read = provider.readMany(['one/a', 'two/b']);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gates.length, 1);
  gates.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gates.length, 1);
  gates.shift()();
  await read;
  assert.equal(peak, 1);
});

test('builds a pinned read-only gh call without disk caching or ambient tokens', () => {
  const spec = buildGhSpec('gh', ['example/project'], {
    PATH: 'fixed', GH_HOST: 'example.com', GH_TOKEN: 'ambient',
    AGENT_UNIVERSE_GITHUB_TOKEN: 'dedicated',
  }, 'C:\\');

  assert.equal(spec.command, 'gh');
  assert.deepEqual(spec.args.slice(0, 7), [
    'api', 'graphql', '--hostname', 'github.com', '--method', 'POST', '-f',
  ]);
  assert.equal(spec.args.includes('--cache'), false);
  assert.match(spec.args[spec.args.length - 1], /^query=query ProjectPullRequests/);
  assert.equal(spec.options.cwd, 'C:\\');
  assert.equal(spec.options.shell, false);
  assert.deepEqual(spec.options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(spec.options.env.GH_PROMPT_DISABLED, '1');
  assert.equal(spec.options.env.GH_NO_UPDATE_NOTIFIER, '1');
  assert.equal(spec.options.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(spec.options.env.GH_HOST, undefined);
  assert.equal(spec.options.env.GITHUB_TOKEN, undefined);
  assert.equal(spec.options.env.GH_TOKEN, 'dedicated');
});

test('rejects arbitrary GraphQL instead of exposing a general query runner', async () => {
  const reader = createGhPullRequestReader({ spawnImpl() { throw new Error('must not spawn'); } });
  assert.deepEqual(await reader('mutation { addStar(input: {}) { clientMutationId } }'), {
    ok: false, code: 'INVALID_QUERY',
  });
});

test('runner classifies auth and rate-limit failures without returning stderr', async () => {
  for (const [message, code] of [
    ['To get started with GitHub CLI, please run: gh auth login', 'AUTH_REQUIRED'],
    ['API rate limit exceeded for user', 'RATE_LIMITED'],
  ]) {
    const child = fakeChild();
    const runner = createGhPullRequestReader({
      env: {},
      spawnImpl() {
        process.nextTick(() => {
          child.stderr.emit('data', message);
          child.emit('close', 1, null);
        });
        return child;
      },
    });
    const result = await runner(['example/project']);
    assert.deepEqual(result, { ok: false, code });
  }
});

test('runner kills gh when combined output exceeds the configured bound', async () => {
  const child = fakeChild();
  const runner = createGhPullRequestReader({
    env: {},
    maxOutputBytes: 4_096,
    spawnImpl() {
      process.nextTick(() => child.stdout.emit('data', Buffer.alloc(4_097)));
      return child;
    },
  });
  const result = await runner(['example/project']);

  assert.deepEqual(result, { ok: false, code: 'OUTPUT_LIMIT' });
  assert.deepEqual(child.kills, ['SIGKILL']);
});

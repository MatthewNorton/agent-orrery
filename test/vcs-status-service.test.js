'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createProjectVcsStatusService,
  normalizedProject,
} = require('../src/main/vcs-status/service');

function project(id, projectPath = `C:\\workspace\\${id}`, exists = true) {
  return { id, path: projectPath, exists };
}

function collected(projectPath, overrides = {}) {
  return {
    ok: true,
    projectPath,
    git: { state: 'ready', branch: 'main', detached: false, dirty: false, changedFiles: 0 },
    github: null,
    ...overrides,
  };
}

function githubRemote(nameWithOwner) {
  const [owner, repository] = nameWithOwner.split('/');
  return {
    remoteName: 'origin', owner, repository, nameWithOwner,
    url: `https://github.com/${nameWithOwner}`, state: 'unknown',
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('normalizes only own project identity fields', () => {
  const inherited = Object.create({ id: 'inherited', path: 'C:\\unsafe' });
  assert.equal(normalizedProject(inherited), null);
  assert.deepEqual(normalizedProject(project('one')), {
    projectId: 'one', projectPath: 'C:\\workspace\\one', exists: true,
  });
});

test('refreshes every unique project with bounded concurrency and stable input order', async () => {
  let active = 0;
  let peak = 0;
  const gates = new Map();
  const calls = [];
  const collector = {
    async read(projectPath) {
      calls.push(projectPath);
      active++;
      peak = Math.max(peak, active);
      const gate = deferred();
      gates.set(projectPath, gate);
      await gate.promise;
      active--;
      return collected(projectPath);
    },
  };
  const service = createProjectVcsStatusService({ collector, maxConcurrency: 2, clock: () => 100 });
  const refresh = service.refresh([project('one'), project('two'), project('one'), project('three')]);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 2);
  assert.equal(calls.length, 2);
  gates.get(calls[0]).resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 3);
  gates.get(calls[1]).resolve();
  gates.get(calls[2]).resolve();

  const statuses = await refresh;
  assert.equal(peak, 2);
  assert.deepEqual(statuses.map((status) => status.projectId), ['one', 'two', 'three']);
  assert.equal(service.snapshot().length, 3);
});

test('reuses fresh cache entries and force refreshes on demand', async () => {
  let now = 1_000;
  let reads = 0;
  const service = createProjectVcsStatusService({
    collector: {
      async read(projectPath) {
        reads++;
        return collected(projectPath, {
          git: {
            state: 'ready', branch: 'main', detached: false,
            dirty: reads > 1, changedFiles: reads > 1 ? 1 : 0,
          },
        });
      },
    },
    ttlMs: 100,
    clock: () => now,
  });

  const first = await service.refreshProject(project('one'));
  now += 50;
  const cached = await service.refreshProject(project('one'));
  const forced = await service.refreshProject(project('one'), { force: true });
  now += 101;
  const expired = await service.refreshProject(project('one'));

  assert.equal(reads, 3);
  assert.equal(cached, first);
  assert.equal(forced.git.dirty, true);
  assert.equal(expired.git.dirty, true);
});

test('path changes bypass cache and a stale in-flight path cannot overwrite the new status', async () => {
  const oldGate = deferred();
  const newGate = deferred();
  const oldPath = 'C:\\workspace\\old';
  const newPath = 'C:\\workspace\\new';
  const service = createProjectVcsStatusService({
    collector: {
      async read(projectPath) {
        if (projectPath === oldPath) {
          await oldGate.promise;
          return collected(oldPath);
        }
        await newGate.promise;
        return collected(newPath, {
          git: { state: 'ready', branch: 'moved', detached: false, dirty: false, changedFiles: 0 },
        });
      },
    },
    clock: () => 100,
  });

  const oldRead = service.refreshProject(project('one', oldPath));
  const newRead = service.refreshProject(project('one', newPath));
  newGate.resolve();
  const latest = await newRead;
  oldGate.resolve();
  await oldRead;

  assert.equal(latest.projectPath, newPath);
  assert.equal(service.get('one').projectPath, newPath);
  assert.equal(service.get('one').git.branch, 'moved');
});

test('coalesces same-path in-flight reads and reports semantic changes only once', async () => {
  const gate = deferred();
  const changes = [];
  let reads = 0;
  const service = createProjectVcsStatusService({
    collector: {
      async read(projectPath) {
        reads++;
        await gate.promise;
        return collected(projectPath);
      },
    },
    onChange(status) { changes.push(status); },
    clock: () => 100,
  });

  const first = service.refreshProject(project('one'));
  const second = service.refreshProject(project('one'));
  gate.resolve();
  const [one, two] = await Promise.all([first, second]);

  assert.equal(reads, 1);
  assert.equal(one, two);
  assert.equal(changes.length, 1);
  await service.refreshProject(project('one'), { force: true });
  assert.equal(changes.length, 1);
});

test('does not invoke Git for missing paths and preserves explicit unavailable state', async () => {
  let reads = 0;
  const service = createProjectVcsStatusService({
    collector: { async read() { reads++; return collected('unused'); } },
    clock: () => 123,
  });

  const missing = await service.refreshProject(project('missing', 'C:\\missing', false));
  const noPath = await service.refreshProject({ id: 'no-path', path: '', exists: true });

  assert.equal(reads, 0);
  assert.equal(missing.state, 'unavailable');
  assert.equal(missing.errorCode, 'PROJECT_UNAVAILABLE');
  assert.equal(noPath.errorCode, 'INVALID_PATH');
});

test('sanitizes collector failures and supports explicit invalidation', async () => {
  let reads = 0;
  const service = createProjectVcsStatusService({
    collector: {
      async read() {
        reads++;
        if (reads === 1) throw new Error('private repository detail');
        return { ok: false, code: 'TIMEOUT', private: 'do not expose' };
      },
    },
    clock: () => 100,
  });

  const failed = await service.refreshProject(project('one'));
  assert.deepEqual(failed, {
    projectId: 'one', projectPath: 'C:\\workspace\\one', checkedAt: 100,
    state: 'unavailable', git: null, github: null, errorCode: 'GIT_FAILED',
  });
  assert.equal(service.invalidate('one'), true);
  const timedOut = await service.refreshProject(project('one'));
  assert.equal(timedOut.errorCode, 'TIMEOUT');
  assert.equal(Object.hasOwn(timedOut, 'private'), false);
});

test('observer failures cannot break collection or cache updates', async () => {
  const service = createProjectVcsStatusService({
    collector: { async read(projectPath) { return collected(projectPath); } },
    onChange() { throw new Error('observer failed'); },
    clock: () => 100,
  });

  const status = await service.refreshProject(project('one'));
  assert.equal(status.state, 'ready');
  assert.equal(service.get('one'), status);
});

test('caps the number of projects accepted by one refresh', async () => {
  const calls = [];
  const service = createProjectVcsStatusService({
    collector: {
      async read(projectPath) {
        calls.push(projectPath);
        return collected(projectPath);
      },
    },
    maxProjects: 2,
  });

  const statuses = await service.refresh([project('one'), project('two'), project('three')]);
  assert.equal(statuses.length, 2);
  assert.equal(calls.length, 2);
});

test('batches GitHub enrichment after local collection and skips local-only repositories', async () => {
  const remoteCalls = [];
  const service = createProjectVcsStatusService({
    collector: {
      async read(projectPath) {
        const id = projectPath.split('\\').pop();
        return collected(projectPath, {
          github: id === 'local' ? null : githubRemote(`example/${id}`),
        });
      },
    },
    githubProvider: {
      async readMany(repositories, options) {
        remoteCalls.push({ repositories, options });
        return repositories.map((repository, index) => ({
          nameWithOwner: repository.nameWithOwner,
          state: 'ready', openPullRequests: index + 1, checkedAt: 500, errorCode: null,
        }));
      },
    },
    clock: () => 100,
  });

  const statuses = await service.refresh([project('one'), project('local'), project('two')]);

  assert.equal(remoteCalls.length, 1);
  assert.deepEqual(remoteCalls[0].repositories.map((repo) => repo.nameWithOwner), [
    'example/one', 'example/two',
  ]);
  assert.equal(statuses[0].github.openPullRequests, 1);
  assert.equal(statuses[0].github.state, 'ready');
  assert.equal(statuses[1].github, null);
  assert.equal(statuses[2].github.openPullRequests, 2);
  assert.equal(service.get('two'), statuses[2]);
});

test('retains GitHub metadata during forced local refreshes without duplicate change events', async () => {
  const changes = [];
  let forceGithub = null;
  const service = createProjectVcsStatusService({
    collector: {
      async read(projectPath) {
        return collected(projectPath, { github: githubRemote('example/project') });
      },
    },
    githubProvider: {
      async readMany(repositories, options) {
        forceGithub = options.force;
        return [{
          nameWithOwner: repositories[0].nameWithOwner,
          state: 'ready', openPullRequests: 3, checkedAt: 500, errorCode: null,
        }];
      },
    },
    onChange(status) { changes.push(status); },
    clock: () => 100,
  });

  await service.refreshProject(project('one'));
  assert.equal(changes.length, 2);
  const refreshed = await service.refreshProject(project('one'), { force: true, forceGithub: true });

  assert.equal(refreshed.github.openPullRequests, 3);
  assert.equal(changes.length, 2);
  assert.equal(forceGithub, true);
});

test('maps unavailable remote metadata to error and keeps stale pull-request counts', async () => {
  let remoteState = 'unavailable';
  const service = createProjectVcsStatusService({
    collector: {
      async read(projectPath) {
        return collected(projectPath, { github: githubRemote('example/project') });
      },
    },
    githubProvider: {
      async readMany() {
        return [{
          nameWithOwner: 'example/project', state: remoteState,
          openPullRequests: remoteState === 'stale' ? 5 : null,
          checkedAt: 500, errorCode: 'RATE_LIMITED',
        }];
      },
    },
  });

  const unavailable = await service.refreshProject(project('one'));
  assert.equal(unavailable.github.state, 'error');
  assert.equal(unavailable.github.openPullRequests, null);
  remoteState = 'stale';
  const stale = await service.refreshProject(project('one'), { forceGithub: true });
  assert.equal(stale.github.state, 'stale');
  assert.equal(stale.github.stale, true);
  assert.equal(stale.github.openPullRequests, 5);
});

test('contains unexpected GitHub provider failures and preserves local status', async () => {
  const service = createProjectVcsStatusService({
    collector: {
      async read(projectPath) {
        return collected(projectPath, { github: githubRemote('example/project') });
      },
    },
    githubProvider: { async readMany() { throw new Error('private remote detail'); } },
  });

  const status = await service.refreshProject(project('one'));
  assert.equal(status.state, 'ready');
  assert.equal(status.git.branch, 'main');
  assert.equal(status.github.state, 'unknown');
});

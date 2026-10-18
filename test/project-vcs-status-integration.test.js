'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createLocalGitStatusCollector } = require('../src/main/vcs-status/collector');
const { createGitHubMetadataProvider } = require('../src/main/vcs-status/github-metadata-provider');
const { createProjectVcsStatusService } = require('../src/main/vcs-status/service');

function gitAvailable() {
  const result = spawnSync('git', ['--version'], {
    shell: false, windowsHide: true, stdio: 'ignore', timeout: 5_000,
  });
  return result.status === 0;
}

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd, shell: false, windowsHide: true, encoding: 'utf8', timeout: 10_000,
  });
  if (result.status !== 0) {
    throw new Error(`fixture git command failed (${args[0]}): ${result.stderr || result.stdout}`);
  }
}

function createRepository(root, name, options = {}) {
  const repositoryPath = path.join(root, name);
  fs.mkdirSync(repositoryPath, { recursive: true });
  git(repositoryPath, ['init']);
  git(repositoryPath, ['checkout', '-B', 'main']);
  fs.writeFileSync(path.join(repositoryPath, 'tracked.txt'), `${name}\n`, 'utf8');
  git(repositoryPath, ['add', 'tracked.txt']);
  git(repositoryPath, [
    '-c', 'user.name=Agent Universe Fixture',
    '-c', 'user.email=fixture@example.invalid',
    'commit', '-m', 'fixture',
  ]);
  if (options.remote) git(repositoryPath, ['remote', 'add', 'origin', options.remote]);
  if (options.detached) git(repositoryPath, ['checkout', '--detach', 'HEAD']);
  if (options.dirty) {
    fs.appendFileSync(path.join(repositoryPath, 'tracked.txt'), 'uncommitted\n', 'utf8');
    fs.writeFileSync(path.join(repositoryPath, 'untracked.txt'), 'new\n', 'utf8');
  }
  return repositoryPath;
}

function project(id, projectPath, exists = true) {
  return { id, path: projectPath, exists };
}

function graphqlFixture(repositories) {
  const data = {};
  repositories.forEach((repository, index) => {
    const alias = `r${index}`;
    const name = repository.repository;
    data[alias] = name === 'private-project'
      ? null
      : { pullRequests: { totalCount: name === 'clean-project' ? 2 : 0 } };
  });
  return { ok: true, stdout: Buffer.from(JSON.stringify({ data })) };
}

test('integrates real Git fixtures with batched GitHub metadata states', {
  skip: !gitAvailable() && 'Git is unavailable',
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-universe-vcs-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cleanPath = createRepository(root, 'clean', {
    remote: 'https://github.com/example/clean-project.git',
  });
  const dirtyPath = createRepository(root, 'dirty', {
    remote: 'git@github.com:example/dirty-project.git', dirty: true,
  });
  const detachedPath = createRepository(root, 'detached', { detached: true });
  const localPath = createRepository(root, 'local');
  const privatePath = createRepository(root, 'private', {
    remote: 'https://github.com/example/private-project.git',
  });
  let githubReads = 0;
  const githubProvider = createGitHubMetadataProvider({
    clock: () => 500,
    async readBatch(repositories) {
      githubReads++;
      return graphqlFixture(repositories);
    },
  });
  const service = createProjectVcsStatusService({
    collector: createLocalGitStatusCollector(), githubProvider, clock: () => 100,
  });

  const statuses = await service.refresh([
    project('clean', cleanPath),
    project('dirty', dirtyPath),
    project('detached', detachedPath),
    project('local', localPath),
    project('private', privatePath),
    project('missing', path.join(root, 'missing'), false),
  ]);
  const byId = new Map(statuses.map((status) => [status.projectId, status]));

  assert.equal(githubReads, 1);
  assert.equal(byId.get('clean').git.branch, 'main');
  assert.equal(byId.get('clean').git.dirty, false);
  assert.equal(byId.get('clean').github.openPullRequests, 2);
  assert.equal(byId.get('clean').github.state, 'ready');
  assert.equal(byId.get('dirty').git.dirty, true);
  assert.equal(byId.get('dirty').git.changedFiles, 2);
  assert.equal(byId.get('dirty').github.openPullRequests, 0);
  assert.equal(byId.get('detached').git.detached, true);
  assert.equal(byId.get('detached').git.branch, null);
  assert.equal(byId.get('detached').github, null);
  assert.equal(byId.get('local').git.branch, 'main');
  assert.equal(byId.get('local').github, null);
  assert.equal(byId.get('private').github.state, 'error');
  assert.equal(byId.get('private').github.errorCode, 'REPOSITORY_UNAVAILABLE');
  assert.equal(byId.get('missing').state, 'unavailable');
  assert.equal(byId.get('missing').errorCode, 'PROJECT_UNAVAILABLE');
});

test('integrates a real repository with rate-limit stale-count fallback', {
  skip: !gitAvailable() && 'Git is unavailable',
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-universe-rate-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repositoryPath = createRepository(root, 'rate-limited', {
    remote: 'https://github.com/example/rate-limited.git',
  });
  let now = 1_000;
  let rateLimited = false;
  const githubProvider = createGitHubMetadataProvider({
    clock: () => now,
    async readBatch() {
      return rateLimited
        ? { ok: false, code: 'RATE_LIMITED' }
        : { ok: true, stdout: Buffer.from(JSON.stringify({
          data: { r0: { pullRequests: { totalCount: 4 } } },
        })) };
    },
  });
  const service = createProjectVcsStatusService({
    collector: createLocalGitStatusCollector(), githubProvider, clock: () => now,
  });

  const ready = await service.refreshProject(project('rate', repositoryPath));
  rateLimited = true;
  now += 1;
  const stale = await service.refreshProject(project('rate', repositoryPath), { forceGithub: true });

  assert.equal(ready.github.state, 'ready');
  assert.equal(ready.github.openPullRequests, 4);
  assert.equal(stale.github.state, 'stale');
  assert.equal(stale.github.openPullRequests, 4);
  assert.equal(stale.github.errorCode, 'RATE_LIMITED');
});

test('collecting status does not modify the repository index', {
  skip: !gitAvailable() && 'Git is unavailable',
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-universe-read-only-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repositoryPath = createRepository(root, 'read-only');
  const indexPath = path.join(repositoryPath, '.git', 'index');
  const beforeBytes = fs.readFileSync(indexPath);
  const beforeStat = fs.statSync(indexPath, { bigint: true });

  const result = await createLocalGitStatusCollector().read(repositoryPath);

  const afterStat = fs.statSync(indexPath, { bigint: true });
  assert.equal(result.ok, true);
  assert.deepEqual(fs.readFileSync(indexPath), beforeBytes);
  assert.equal(afterStat.mtimeNs, beforeStat.mtimeNs);
  assert.equal(fs.existsSync(`${indexPath}.lock`), false);
});

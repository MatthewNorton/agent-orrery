'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const statusUi = require('../src/renderer/components/project-vcs-status');

test('normalizes GitHub HTTPS and SSH remotes without mutating source data', () => {
  const httpsInput = {
    id: 'one', name: 'One',
    git: { branch: 'main', dirty: false, changedFiles: 0 },
    github: { url: 'https://github.com/octocat/Hello-World.git', openPullRequests: 2 },
  };
  const sshInput = {
    id: 'two', name: 'Two',
    git: { branch: 'feat/status', dirty: true, changedFiles: 3 },
    github: { url: 'git@github.com:openai/codex.git', openPullRequests: 0 },
  };

  const first = statusUi.normalize(httpsInput);
  const second = statusUi.normalize(sshInput);

  assert.equal(first.nameWithOwner, 'octocat/Hello-World');
  assert.equal(first.hasGitHub, true);
  assert.equal(first.openPullRequests, 2);
  assert.equal(second.nameWithOwner, 'openai/codex');
  assert.equal(second.dirty, true);
  assert.equal(second.changedFiles, 3);
  assert.equal(sshInput.github.nameWithOwner, undefined);
});

test('keeps unknown GitHub data distinct from zero open pull requests', () => {
  const unknown = statusUi.normalize({
    name: 'Unknown', git: { branch: 'main' },
    github: { url: 'https://github.com/example/unknown' },
  });
  const zero = statusUi.normalize({
    name: 'Zero', git: { branch: 'main' },
    github: { url: 'https://github.com/example/zero', openPullRequests: 0 },
  });

  assert.equal(unknown.openPullRequests, null);
  assert.equal(unknown.githubState, 'unknown');
  assert.equal(zero.openPullRequests, 0);
  assert.equal(zero.githubState, 'ready');
});

test('reports detached and dirty local repositories without requiring GitHub', () => {
  const status = statusUi.normalize({
    id: 'local', name: 'Local only',
    git: { detached: true, dirty: false, changedFiles: 1 },
  });

  assert.equal(status.branchLabel, 'Detached HEAD');
  assert.equal(status.dirty, true);
  assert.equal(status.hasGitHub, false);
  assert.equal(status.githubState, 'absent');
});

test('filters by GitHub presence and searches project, branch, path, or repository', () => {
  const projects = [
    {
      id: 'github', name: 'Agent Universe', path: 'C:\\work\\agent-universe',
      git: { branch: 'feat/status' },
      github: { url: 'https://github.com/example/agent-universe' },
    },
    {
      id: 'local', name: 'Local Notes', path: 'C:\\work\\notes',
      git: { branch: 'main' },
    },
  ];

  assert.deepEqual(
    statusUi.filterProjects(projects, { filter: statusUi.FILTERS.GITHUB }).map((p) => p.id),
    ['github']
  );
  assert.deepEqual(
    statusUi.filterProjects(projects, { filter: statusUi.FILTERS.LOCAL }).map((p) => p.id),
    ['local']
  );
  assert.deepEqual(
    statusUi.filterProjects(projects, { filter: statusUi.FILTERS.ALL, query: 'feat/status' }).map((p) => p.id),
    ['github']
  );
  assert.deepEqual(
    statusUi.filterProjects(projects, { filter: statusUi.FILTERS.ALL, query: 'example/agent' }).map((p) => p.id),
    ['github']
  );
});

test('reads the live renderer project shape with status nested under vcs', () => {
  const project = {
    id: 'nested', name: 'Nested Status', path: 'C:\\work\\nested',
    vcs: {
      git: { branch: 'feat/live-status', dirty: true, changedFiles: 2 },
      github: {
        nameWithOwner: 'example/nested', url: 'https://github.com/example/nested',
        state: 'ready', openPullRequests: 1,
      },
    },
  };

  const status = statusUi.normalize(project);
  assert.equal(status.projectId, 'nested');
  assert.equal(status.branch, 'feat/live-status');
  assert.equal(status.dirty, true);
  assert.equal(status.nameWithOwner, 'example/nested');
  assert.equal(status.openPullRequests, 1);
  assert.equal(statusUi.matchesFilter(project, statusUi.FILTERS.GITHUB), true);
  assert.equal(statusUi.matchesSearch(project, 'feat/live'), true);
});

test('labels stale pull-request counts without discarding the last known value', () => {
  const status = statusUi.normalize({
    name: 'Stale',
    github: {
      nameWithOwner: 'example/stale', state: 'stale', openPullRequests: 5,
    },
  });

  assert.equal(statusUi.pullRequestLabel(status), '5 open · stale');
});

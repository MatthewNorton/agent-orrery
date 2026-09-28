'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const {
  createLocalGitStatusCollector,
  createGitRunner,
  buildGitSpec,
  parsePorcelainV2,
  parseRemoteConfig,
  githubIdentity,
  selectGithubRemote,
} = require('../src/main/project-vcs-status');

function fakeFs(realPath = path.resolve('C:\\workspace\\project'), isDirectory = true) {
  return {
    promises: {
      async realpath() { return realPath; },
      async stat() { return { isDirectory: () => isDirectory }; },
    },
  };
}

function gitResult(stdout, overrides = {}) {
  return { ok: true, exitCode: 0, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), ...overrides };
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kills = [];
  child.kill = (signal) => { child.kills.push(signal); return true; };
  return child;
}

test('parses porcelain v2 branch and counts tracked, untracked, conflicted, and renamed files', () => {
  const output = [
    '# branch.oid abc123',
    '# branch.head feat/github-status',
    '1 .M N... 100644 100644 100644 abc abc src/app.js',
    '2 R. N... 100644 100644 100644 abc def R100 src/new.js',
    'src/old.js',
    'u UU N... 100644 100644 100644 100644 abc def ghi conflict.js',
    '? new-file.js',
    '',
  ].join('\0');

  assert.deepEqual(parsePorcelainV2(output), {
    branch: 'feat/github-status',
    detached: false,
    dirty: true,
    changedFiles: 4,
  });
});

test('keeps detached clean state distinct from a named branch', () => {
  assert.deepEqual(parsePorcelainV2('# branch.oid abc\0# branch.head (detached)\0'), {
    branch: null,
    detached: true,
    dirty: false,
    changedFiles: 0,
  });
});

test('parses remote config and prefers origin when multiple GitHub remotes exist', () => {
  const remotes = parseRemoteConfig([
    'remote.upstream.url\ngit@github.com:openai/codex.git',
    'remote.origin.url\nhttps://github.com/MatthewNorton/agent-universe-lite.git',
    'remote.mirror.url\nhttps://gitlab.com/example/mirror.git',
    '',
  ].join('\0'));
  const selected = selectGithubRemote(remotes);

  assert.equal(remotes.length, 3);
  assert.deepEqual(selected, {
    remoteName: 'origin',
    owner: 'MatthewNorton',
    repository: 'agent-universe-lite',
    nameWithOwner: 'MatthewNorton/agent-universe-lite',
    url: 'https://github.com/MatthewNorton/agent-universe-lite',
  });
});

test('normalizes supported GitHub URLs and rejects credential-bearing or non-GitHub URLs', () => {
  assert.equal(githubIdentity('git@github.com:openai/codex.git').nameWithOwner, 'openai/codex');
  assert.equal(
    githubIdentity('ssh://git@github.com/MatthewNorton/agent-universe-lite.git').url,
    'https://github.com/MatthewNorton/agent-universe-lite'
  );
  assert.equal(githubIdentity('https://token@github.com/example/private.git'), null);
  assert.equal(githubIdentity('https://gitlab.com/example/project.git'), null);
});

test('builds read-only Git commands with a separate project path argument and no shell', () => {
  const projectPath = path.resolve('C:\\workspace\\project & name');
  const spec = buildGitSpec('git', projectPath, ['status', '--porcelain=v2'], { PATH: 'fixed' });

  assert.equal(spec.command, 'git');
  assert.equal(spec.options.shell, false);
  assert.equal(spec.options.windowsHide, true);
  assert.deepEqual(spec.options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(spec.args.includes(projectPath), true);
  assert.equal(spec.args[spec.args.indexOf('-C') + 1], projectPath);
  assert.equal(spec.args.includes('core.fsmonitor=false'), true);
  assert.equal(spec.options.env.GIT_OPTIONAL_LOCKS, '0');
  assert.equal(spec.options.env.GIT_TERMINAL_PROMPT, '0');
});

test('collects branch, worktree, and sanitized GitHub remote in two bounded commands', async () => {
  const projectPath = path.resolve('C:\\workspace\\project');
  const calls = [];
  const results = [
    gitResult('# branch.oid abc\0# branch.head main\0? new.txt\0'),
    gitResult('remote.origin.url\ngit@github.com:example/project.git\0'),
  ];
  const collector = createLocalGitStatusCollector({
    fsImpl: fakeFs(projectPath),
    async runGit(realPath, args) {
      calls.push({ realPath, args });
      return results.shift();
    },
  });

  const result = await collector.read(projectPath);

  assert.equal(result.ok, true);
  assert.equal(result.projectPath, projectPath);
  assert.deepEqual(result.git, {
    state: 'ready', branch: 'main', detached: false, dirty: true, changedFiles: 1,
  });
  assert.deepEqual(result.github, {
    remoteName: 'origin', owner: 'example', repository: 'project',
    nameWithOwner: 'example/project', url: 'https://github.com/example/project', state: 'unknown',
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, [
    'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal',
  ]);
  assert.deepEqual(calls[1].args, [
    'config', '--null', '--get-regexp', '^remote\\..*\\.url$',
  ]);
});

test('treats missing remotes as a valid local-only repository', async () => {
  const projectPath = path.resolve('C:\\workspace\\local-only');
  const results = [
    gitResult('# branch.oid abc\0# branch.head main\0'),
    { ok: false, code: 'GIT_FAILED', exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) },
  ];
  const collector = createLocalGitStatusCollector({
    fsImpl: fakeFs(projectPath),
    async runGit() { return results.shift(); },
  });

  const result = await collector.read(projectPath);

  assert.equal(result.ok, true);
  assert.equal(result.github, null);
  assert.equal(result.git.dirty, false);
});

test('fails closed for invalid, unavailable, non-repository, timed-out, and oversized projects', async () => {
  let runs = 0;
  const unavailableFs = { promises: { async realpath() { throw new Error('missing'); } } };
  const unavailable = createLocalGitStatusCollector({
    fsImpl: unavailableFs,
    async runGit() { runs++; return gitResult(''); },
  });
  assert.deepEqual(await unavailable.read('relative'), { ok: false, code: 'INVALID_PATH' });
  assert.deepEqual(await unavailable.read(path.resolve('missing')), {
    ok: false, code: 'PROJECT_UNAVAILABLE',
  });
  assert.equal(runs, 0);

  for (const [source, expected] of [
    [{ ok: false, code: 'GIT_FAILED', exitCode: 128 }, 'NOT_REPOSITORY'],
    [{ ok: false, code: 'TIMEOUT' }, 'TIMEOUT'],
    [{ ok: false, code: 'OUTPUT_LIMIT' }, 'OUTPUT_LIMIT'],
  ]) {
    const collector = createLocalGitStatusCollector({
      fsImpl: fakeFs(),
      async runGit() { return source; },
    });
    assert.deepEqual(await collector.read(path.resolve('project')), { ok: false, code: expected });
  }
});

test('runner enforces the output limit and kills the Git child without waiting for close', async () => {
  const child = fakeChild();
  const runner = createGitRunner({
    spawnImpl() {
      process.nextTick(() => child.stdout.emit('data', Buffer.alloc(4_097)));
      return child;
    },
    maxOutputBytes: 4_096,
    timeoutMs: 1_000,
    env: {},
  });

  const result = await runner(path.resolve('project'), ['status']);

  assert.deepEqual(result, { ok: false, code: 'OUTPUT_LIMIT' });
  assert.deepEqual(child.kills, ['SIGKILL']);
});

test('runner returns bounded stdout and stderr without exposing a shell', async () => {
  const child = fakeChild();
  let captured = null;
  const runner = createGitRunner({
    spawnImpl(command, args, options) {
      captured = { command, args, options };
      process.nextTick(() => {
        child.stdout.emit('data', Buffer.from('ok\0'));
        child.stderr.emit('data', Buffer.from('note'));
        child.emit('close', 0, null);
      });
      return child;
    },
    env: { PATH: 'fixed' },
  });

  const result = await runner(path.resolve('project & safe'), ['status']);

  assert.equal(result.ok, true);
  assert.equal(result.stdout.toString(), 'ok\0');
  assert.equal(result.stderr.toString(), 'note');
  assert.equal(captured.options.shell, false);
  assert.equal(captured.args[captured.args.indexOf('-C') + 1], path.resolve('project & safe'));
});

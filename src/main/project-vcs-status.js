'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 4_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const FAILURE_CODES = new Set([
  'INVALID_PATH',
  'PROJECT_UNAVAILABLE',
  'NOT_REPOSITORY',
  'GIT_UNAVAILABLE',
  'GIT_FAILED',
  'TIMEOUT',
  'OUTPUT_LIMIT',
]);

function boundedInteger(value, fallback, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function failure(code) {
  return Object.freeze({ ok: false, code: FAILURE_CODES.has(code) ? code : 'GIT_FAILED' });
}

function stringValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function bufferValue(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (value == null) return Buffer.alloc(0);
  return Buffer.from(String(value), 'utf8');
}

function normalizedProjectPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 32_767 ||
      value.includes('\0') || !path.isAbsolute(value)) return null;
  return path.normalize(value);
}

function splitRecords(value) {
  const source = bufferValue(value).toString('utf8');
  return source.includes('\0') ? source.split('\0') : source.split(/\r?\n/);
}

function parsePorcelainV2(value) {
  const records = splitRecords(value);
  let branch = null;
  let detached = false;
  let changedFiles = 0;

  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    if (record.startsWith('# branch.head ')) {
      const head = record.slice('# branch.head '.length).trim();
      detached = head === '(detached)';
      branch = detached || !head ? null : head;
      continue;
    }
    if (record.startsWith('1 ') || record.startsWith('u ') || record.startsWith('? ')) {
      changedFiles++;
      continue;
    }
    if (record.startsWith('2 ')) {
      changedFiles++;
      // In -z mode a rename/copy record is followed by the original path as a
      // separate NUL-delimited field. It is metadata, not another changed file.
      if (records[index + 1] && !records[index + 1].startsWith('# ')) index++;
    }
  }

  return Object.freeze({
    branch,
    detached,
    dirty: changedFiles > 0,
    changedFiles,
  });
}

function parseRemoteConfig(value) {
  const remotes = [];
  for (const rawRecord of splitRecords(value)) {
    const record = rawRecord.replace(/\r/g, '');
    if (!record) continue;
    const separator = record.indexOf('\n');
    let key;
    let url;
    if (separator >= 0) {
      key = record.slice(0, separator).trim();
      url = record.slice(separator + 1).trim();
    } else {
      const match = record.match(/^(remote\..+\.url)\s+(.+)$/);
      if (!match) continue;
      key = match[1];
      url = match[2].trim();
    }
    const keyMatch = key.match(/^remote\.(.+)\.url$/);
    if (!keyMatch || !url) continue;
    remotes.push(Object.freeze({ name: keyMatch[1], url }));
  }
  return Object.freeze(remotes);
}

function githubIdentity(remoteUrl) {
  const value = stringValue(remoteUrl);
  if (!value || /[\r\n\0]/.test(value)) return null;
  const match = value.match(
    /^(?:https?:\/\/github\.com\/|git:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9.-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i
  );
  if (!match) return null;
  const owner = match[1];
  const repository = match[2];
  const nameWithOwner = `${owner}/${repository}`;
  return Object.freeze({
    owner,
    repository,
    nameWithOwner,
    url: `https://github.com/${nameWithOwner}`,
  });
}

function selectGithubRemote(remotes) {
  const matches = [];
  for (const remote of Array.isArray(remotes) ? remotes : []) {
    if (!remote || typeof remote !== 'object') continue;
    const identity = githubIdentity(remote.url);
    if (!identity) continue;
    matches.push({ name: stringValue(remote.name), identity });
  }
  matches.sort((left, right) => {
    const leftOrigin = left.name.toLowerCase() === 'origin' ? 0 : 1;
    const rightOrigin = right.name.toLowerCase() === 'origin' ? 0 : 1;
    return leftOrigin - rightOrigin || left.name.localeCompare(right.name);
  });
  if (!matches.length) return null;
  const selected = matches[0];
  return Object.freeze({ remoteName: selected.name, ...selected.identity });
}

function gitArgs(projectPath, commandArgs) {
  return [
    '-c', 'core.fsmonitor=false',
    '-c', 'core.untrackedCache=false',
    '-C', projectPath,
    ...commandArgs,
  ];
}

function buildGitSpec(gitCommand, projectPath, commandArgs, env) {
  const root = path.parse(projectPath).root;
  return Object.freeze({
    command: gitCommand,
    args: gitArgs(projectPath, commandArgs),
    options: Object.freeze({
      cwd: root,
      env: Object.freeze({
        ...(env && typeof env === 'object' ? env : {}),
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'Never',
      }),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  });
}

function createGitRunner(options = {}) {
  const settings = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const spawnImpl = typeof settings.spawnImpl === 'function' ? settings.spawnImpl : spawn;
  const gitCommand = stringValue(settings.gitCommand) || 'git';
  const env = settings.env && typeof settings.env === 'object' ? settings.env : process.env;
  const timeoutMs = boundedInteger(settings.timeoutMs, DEFAULT_TIMEOUT_MS, 250, 30_000);
  const maxOutputBytes = boundedInteger(
    settings.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 4_096, 4 * 1024 * 1024
  );

  return async function runGit(projectPath, commandArgs) {
    const spec = buildGitSpec(gitCommand, projectPath, commandArgs, env);
    return new Promise((resolve) => {
      let child;
      try {
        child = spawnImpl(spec.command, spec.args, spec.options);
      } catch {
        resolve({ ok: false, code: 'GIT_UNAVAILABLE' });
        return;
      }
      if (!child || !child.stdout || typeof child.stdout.on !== 'function' ||
          !child.stderr || typeof child.stderr.on !== 'function' || typeof child.once !== 'function') {
        resolve({ ok: false, code: 'GIT_UNAVAILABLE' });
        return;
      }

      const stdout = [];
      const stderr = [];
      let outputBytes = 0;
      let settled = false;
      let timeout = null;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        resolve(result);
      };
      const stop = (code) => {
        try {
          if (typeof child.kill === 'function') child.kill('SIGKILL');
        } catch {
          // The bounded failure is still authoritative if the child exited first.
        }
        finish({ ok: false, code });
      };
      const collect = (target) => (chunk) => {
        if (settled) return;
        const data = bufferValue(chunk);
        outputBytes += data.length;
        if (outputBytes > maxOutputBytes) {
          stop('OUTPUT_LIMIT');
          return;
        }
        target.push(data);
      };

      child.stdout.on('data', collect(stdout));
      child.stderr.on('data', collect(stderr));
      child.once('error', () => finish({ ok: false, code: 'GIT_UNAVAILABLE' }));
      child.once('close', (exitCode, signal) => {
        finish({
          ok: exitCode === 0,
          code: exitCode === 0 ? null : 'GIT_FAILED',
          exitCode: Number.isInteger(exitCode) ? exitCode : null,
          signal: typeof signal === 'string' ? signal : null,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        });
      });
      timeout = setTimeout(() => stop('TIMEOUT'), timeoutMs);
      if (timeout && typeof timeout.unref === 'function') timeout.unref();
    });
  };
}

function createLocalGitStatusCollector(options = {}) {
  const settings = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const fsImpl = settings.fsImpl && typeof settings.fsImpl === 'object' ? settings.fsImpl : fs;
  const runGit = typeof settings.runGit === 'function' ? settings.runGit : createGitRunner(settings);

  return Object.freeze({
    async read(inputPath) {
      const projectPath = normalizedProjectPath(inputPath);
      if (!projectPath) return failure('INVALID_PATH');

      let realPath;
      try {
        realPath = path.normalize(await fsImpl.promises.realpath(projectPath));
        const stat = await fsImpl.promises.stat(realPath);
        if (!stat.isDirectory()) return failure('PROJECT_UNAVAILABLE');
      } catch {
        return failure('PROJECT_UNAVAILABLE');
      }

      const statusResult = await runGit(realPath, [
        'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal',
      ]);
      if (!statusResult || statusResult.ok !== true) {
        if (statusResult && statusResult.code === 'TIMEOUT') return failure('TIMEOUT');
        if (statusResult && statusResult.code === 'OUTPUT_LIMIT') return failure('OUTPUT_LIMIT');
        if (statusResult && statusResult.code === 'GIT_UNAVAILABLE') return failure('GIT_UNAVAILABLE');
        if (statusResult && statusResult.exitCode === 128) return failure('NOT_REPOSITORY');
        return failure('GIT_FAILED');
      }

      const git = parsePorcelainV2(statusResult.stdout);
      const remoteResult = await runGit(realPath, [
        'config', '--null', '--get-regexp', '^remote\\..*\\.url$',
      ]);
      let github = null;
      if (remoteResult && remoteResult.ok === true) {
        github = selectGithubRemote(parseRemoteConfig(remoteResult.stdout));
      } else if (remoteResult && remoteResult.code === 'TIMEOUT') {
        return failure('TIMEOUT');
      } else if (remoteResult && remoteResult.code === 'OUTPUT_LIMIT') {
        return failure('OUTPUT_LIMIT');
      } else if (remoteResult && remoteResult.code === 'GIT_UNAVAILABLE') {
        return failure('GIT_UNAVAILABLE');
      } else if (!remoteResult || remoteResult.exitCode !== 1) {
        return failure('GIT_FAILED');
      }

      return Object.freeze({
        ok: true,
        projectPath: realPath,
        git: Object.freeze({ state: 'ready', ...git }),
        github: github ? Object.freeze({ ...github, state: 'unknown' }) : null,
      });
    },
  });
}

module.exports = {
  createLocalGitStatusCollector,
  createGitRunner,
  buildGitSpec,
  parsePorcelainV2,
  parseRemoteConfig,
  githubIdentity,
  selectGithubRemote,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
};

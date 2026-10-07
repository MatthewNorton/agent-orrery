// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  pathFlavor,
  isCanonicalPath,
  isCanonicalPathFor,
  isInsidePath,
} = require('./path-safety');
const { validGoalId: validTaskId } = require('./shared/ids');

const FAILURE_CODES = new Set(['INVALID', 'UNAVAILABLE', 'FAILED']);
const DEFAULT_CONFIRM_TIMEOUT_MS = 1_000;

// Native @openai/codex architecture packages per host. Only listed hosts are supported;
// anything else fails closed with UNAVAILABLE before any path or filesystem work.
const NATIVE_TARGETS = Object.freeze({
  win32: Object.freeze({
    x64: Object.freeze({ packageName: 'codex-win32-x64', triple: 'x86_64-pc-windows-msvc' }),
    arm64: Object.freeze({ packageName: 'codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' }),
  }),
  darwin: Object.freeze({
    x64: Object.freeze({ packageName: 'codex-darwin-x64', triple: 'x86_64-apple-darwin' }),
    arm64: Object.freeze({ packageName: 'codex-darwin-arm64', triple: 'aarch64-apple-darwin' }),
  }),
  linux: Object.freeze({
    x64: Object.freeze({ packageName: 'codex-linux-x64', triple: 'x86_64-unknown-linux-musl' }),
    arm64: Object.freeze({ packageName: 'codex-linux-arm64', triple: 'aarch64-unknown-linux-musl' }),
  }),
});

/**
 * @typedef {object} AgentLauncherOptions
 * @property {string} [platform]
 * @property {string} [arch]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {typeof fs} [fsImpl]
 * @property {typeof spawn} [spawnImpl]
 * @property {number} [confirmTimeoutMs]
 */

/**
 * @typedef {object} AgentLaunchRequest
 * @property {string} [cwd]
 * @property {string} [taskId]
 * @property {string | null} [text]
 * @property {string | null} [taskText]
 * @property {string} [provider]
 */

/** @param {AgentLauncherOptions} [options] */
function createAgentLauncher(options = {}) {
  const settings = options && typeof options === 'object' && !Array.isArray(options)
    ? options : {};
  const platform = ownValue(settings, 'platform', process.platform);
  const arch = ownValue(settings, 'arch', process.arch);
  const env = ownValue(settings, 'env', process.env);
  const fsImpl = ownValue(settings, 'fsImpl', fs);
  const spawnImpl = ownValue(settings, 'spawnImpl', spawn);
  const requestedTimeout = ownValue(settings, 'confirmTimeoutMs', DEFAULT_CONFIRM_TIMEOUT_MS);
  const confirmTimeoutMs = Number.isInteger(requestedTimeout) &&
    requestedTimeout >= 10 && requestedTimeout <= 5_000
    ? requestedTimeout : DEFAULT_CONFIRM_TIMEOUT_MS;

  return Object.freeze({
    /** @param {AgentLaunchRequest} request */
    async launch(request) {
      const cwd = ownValue(request, 'cwd', null);
      const taskId = ownValue(request, 'taskId', null);
      const text = ownValue(request, 'text', ownValue(request, 'taskText', null));
      const provider = ownValue(request, 'provider', 'codex');
      if (provider !== 'codex' || !validTaskId(taskId) || !validTaskText(text)) {
        return failure('INVALID');
      }
      // Host support is decided before the path is inspected so that an unsupported
      // host reports UNAVAILABLE instead of misreporting its own native paths as INVALID.
      if (!supportedPlatform(platform)) return failure('UNAVAILABLE');
      if (!isCanonicalPathFor(cwd, platform)) return failure('INVALID');

      let executable;
      try {
        executable = resolveCodexExecutable({ platform, arch, env, fsImpl, cwd });
      } catch (error) {
        return failure(error && FAILURE_CODES.has(error.code) ? error.code : 'UNAVAILABLE');
      }

      let spec;
      try {
        spec = buildAgentSpec({ executable, cwd, taskId, text });
      } catch {
        return failure('INVALID');
      }
      if (typeof spawnImpl !== 'function') return failure('FAILED');
      return spawnConfirmed(spawnImpl, spec, confirmTimeoutMs);
    },
  });
}

/**
 * @param {{ executable?: string, cwd?: string, taskId?: string, text?: string | null,
 *   taskText?: string | null }} [input]
 */
function buildAgentSpec({ executable, cwd, taskId, text = null, taskText = null } = {}) {
  const flavor = pathFlavor(cwd);
  if (!flavor || !isCodexExecutablePath(executable) || !isCanonicalPath(cwd) ||
      pathFlavor(executable) !== flavor || isInsidePath(cwd, executable)) {
    throw launchError('INVALID');
  }
  const prompt = buildTaskPrompt({ taskId, text: text === null ? taskText : text });
  return {
    command: executable,
    args: [
      '--ask-for-approval', 'never',
      '--sandbox', 'workspace-write',
      '-C', cwd,
      'exec', prompt,
    ],
    options: {
      cwd,
      shell: false,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    },
  };
}

/**
 * @param {{ platform?: string, arch?: string, env?: NodeJS.ProcessEnv, fsImpl?: typeof fs,
 *   cwd?: string }} [host]
 */
function resolveCodexExecutable({ platform, arch = process.arch, env, fsImpl = fs, cwd } = {}) {
  if (!supportedPlatform(platform)) throw launchError('UNAVAILABLE');
  if (!isCanonicalPathFor(cwd, platform)) throw launchError('INVALID');
  const target = NATIVE_TARGETS[platform][arch];
  if (!target) throw launchError('UNAVAILABLE');
  const pathValue = readPathVariable(env);
  if (pathValue === null) throw launchError('UNAVAILABLE');
  const flavor = flavorForPlatform(platform);
  const executableName = platform === 'win32' ? 'codex.exe' : 'codex';

  const directories = pathValue.split(flavor.delimiter)
    .map((entry) => stripTrailingSeparator(entry.trim(), platform))
    .filter((entry) => entry.length > 0 && isCanonicalPathFor(entry, platform));

  if (!validFilesystem(fsImpl)) throw launchError('UNAVAILABLE');
  for (const directory of directories) {
    // On POSIX hosts the PATH entry is normally a symlink (Homebrew, npm) to the real
    // binary, so a link is followed there and the resolved target is validated instead.
    const direct = validateExecutable(
      flavor.join(directory, executableName), cwd, fsImpl, { allowSymlink: platform !== 'win32' }
    );
    if (direct) return direct;

    // Presence of npm's wrapper anchors the fixed package-relative lookup; its contents
    // are never read. For npm's own layouts (a `codex` symlink on POSIX, `codex.cmd` on
    // Windows) the wrapper itself is never executed: the direct lookup above resolves the
    // symlink and rejects its JavaScript target, and `.cmd` is never a lookup target. A
    // regular executable file named `codex` on a POSIX PATH (pnpm, volta or asdf shims)
    // is different: the direct lookup above accepts it, so it IS spawned (with
    // shell: false) and runs through its shebang.
    const wrapper = platform === 'win32'
      ? flavor.join(directory, 'codex.cmd') : flavor.join(directory, 'codex');
    if (!isNpmWrapper(wrapper, fsImpl, platform)) continue;
    for (const candidate of npmCodexCandidates(directory, target, platform)) {
      const resolved = validateExecutable(candidate, cwd, fsImpl, { allowSymlink: false });
      if (resolved) return resolved;
    }
  }
  throw launchError('UNAVAILABLE');
}

function npmCodexCandidates(directory, target, platform) {
  const flavor = flavorForPlatform(platform);
  const executableName = platform === 'win32' ? 'codex.exe' : 'codex';
  // Windows keeps global packages beside the wrapper; POSIX npm prefixes keep them
  // under <prefix>/lib/node_modules next to <prefix>/bin.
  const packageBase = platform === 'win32'
    ? flavor.join(directory, 'node_modules')
    : flavor.join(directory, '..', 'lib', 'node_modules');
  const packageRoots = [
    // Current npm layout: the architecture package is an optional dependency.
    flavor.join(packageBase, '@openai', 'codex', 'node_modules', '@openai', target.packageName, 'vendor'),
    // Hoisted optional dependency layout used by some npm-compatible installers.
    flavor.join(packageBase, '@openai', target.packageName, 'vendor'),
    // Legacy bundled-vendor fallback in @openai/codex itself.
    flavor.join(packageBase, '@openai', 'codex', 'vendor'),
  ];
  const candidates = [];
  for (const vendorRoot of packageRoots) {
    candidates.push(flavor.join(vendorRoot, target.triple, 'bin', executableName));
    candidates.push(flavor.join(vendorRoot, target.triple, 'codex', executableName));
  }
  return candidates;
}

function validateExecutable(candidate, cwd, fsImpl, { allowSymlink = false } = {}) {
  if (!isCodexExecutablePath(candidate) || isInsidePath(cwd, candidate)) return null;
  try {
    const linkStatus = fsImpl.lstatSync(candidate);
    if (!linkStatus || typeof linkStatus.isSymbolicLink !== 'function') return null;
    const isLink = linkStatus.isSymbolicLink();
    if (isLink && !allowSymlink) return null;
    if (!isLink && !fileStatus(linkStatus)) return null;
    const executeMode = fsImpl.constants && Number.isInteger(fsImpl.constants.X_OK)
      ? fsImpl.constants.X_OK : fs.constants.X_OK;
    fsImpl.accessSync(candidate, executeMode);
    const realCandidate = fsImpl.realpathSync(candidate);
    if (!isCodexExecutablePath(realCandidate) || isInsidePath(cwd, realCandidate)) return null;
    const realStatus = fsImpl.statSync(realCandidate);
    if (!realStatus || typeof realStatus.isFile !== 'function' || !realStatus.isFile()) return null;
    fsImpl.accessSync(realCandidate, executeMode);
    return realCandidate;
  } catch {
    return null;
  }
}

function isNpmWrapper(candidate, fsImpl, platform) {
  if (!isCanonicalPathFor(candidate, platform)) return false;
  try {
    const status = fsImpl.lstatSync(candidate);
    if (platform === 'win32') return fileStatus(status) && !status.isSymbolicLink();
    // npm links <prefix>/bin/codex to the package's JavaScript entry on POSIX hosts.
    return Boolean(status) && typeof status.isSymbolicLink === 'function' &&
      (status.isSymbolicLink() || fileStatus(status));
  } catch {
    return false;
  }
}

function fileStatus(status) {
  return Boolean(status) && typeof status.isFile === 'function' && status.isFile() &&
    typeof status.isSymbolicLink === 'function';
}

function validFilesystem(fsImpl) {
  return Boolean(fsImpl) && typeof fsImpl.lstatSync === 'function' &&
    typeof fsImpl.statSync === 'function' && typeof fsImpl.realpathSync === 'function' &&
    typeof fsImpl.accessSync === 'function';
}

function buildTaskPrompt(input, taskText = null) {
  const taskId = typeof input === 'string' ? input : ownValue(input, 'taskId', null);
  const text = typeof input === 'string'
    ? taskText
    : ownValue(input, 'text', ownValue(input, 'taskText', null));
  if (!validTaskId(taskId) || !validTaskText(text)) throw launchError('INVALID');
  const canonicalId = taskId.toLowerCase();
  const taskContext = typeof text === 'string' && text.length > 0
    ? `\n\nThe tagged task text is:\n${text}` : '';
  return [
    'Complete one Agent Universe task in this repository.',
    `The exact task marker is\nagent-universe:${canonicalId}`,
    'Read and follow the repository instructions and GOALS.md before making changes.',
    'Work only on the TODO item tagged with that exact marker.',
    'Implement the task and validate the result with the relevant tests or checks.',
    'Leave the task checkbox unchanged; Agent Universe will mark it complete when you finish.',
  ].join('\n') + taskContext;
}

function spawnConfirmed(spawnImpl, spec, confirmTimeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(spec.command, spec.args, spec.options);
    } catch {
      resolve(failure('FAILED'));
      return;
    }
    if (!child || typeof child.once !== 'function' || typeof child.unref !== 'function') {
      resolve(failure('FAILED'));
      return;
    }

    let settled = false;
    let timer = null;
    const cleanUp = () => {
      if (timer !== null) clearTimeout(timer);
      if (typeof child.removeListener === 'function') {
        child.removeListener('spawn', onSpawn);
        child.removeListener('error', onError);
      }
    };
    const settle = (result) => {
      if (settled) return;
      settled = true;
      cleanUp();
      resolve(result);
    };
    const onError = () => settle(failure('FAILED'));
    const onSpawn = () => {
      try {
        child.unref();
      } catch {
        settle(failure('FAILED'));
        return;
      }
      // Ignore a late ChildProcess error without retaining its PID, output, or exit lifecycle.
      child.once('error', () => {});
      settle({ ok: true });
    };

    child.once('error', onError);
    if (!settled) child.once('spawn', onSpawn);
    if (!settled) {
      timer = setTimeout(() => {
        child.once('error', () => {});
        settle(failure('FAILED'));
      }, confirmTimeoutMs);
    }
  });
}

function readPathVariable(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return null;
  try {
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() !== 'path') continue;
      const descriptor = Object.getOwnPropertyDescriptor(env, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') ||
          typeof descriptor.value !== 'string') return null;
      return descriptor.value;
    }
  } catch {
    return null;
  }
  return null;
}

function ownValue(object, key, fallback) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return fallback;
  try {
    if (!Object.hasOwn(object, key)) return fallback;
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : fallback;
  } catch {
    return fallback;
  }
}

function validTaskText(value) {
  return value === null || value === undefined ||
    (typeof value === 'string' && value.length <= 10_000 && !value.includes('\0'));
}

function supportedPlatform(platform) {
  return typeof platform === 'string' && Object.hasOwn(NATIVE_TARGETS, platform);
}

function flavorForPlatform(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

// PATH entries are often written with a trailing separator (`C:\Users\x\AppData\Roaming\npm\`).
// Drop exactly one before the canonical-path check; roots (`C:\`, `/`) are left untouched.
function stripTrailingSeparator(entry, platform) {
  const trailing = platform === 'win32' ? /[\\/]$/ : /\/$/;
  const root = platform === 'win32' ? /^[A-Za-z]:[\\/]$/ : /^\/$/;
  return trailing.test(entry) && !root.test(entry) ? entry.slice(0, -1) : entry;
}

function isCodexExecutablePath(value) {
  if (!isCanonicalPath(value)) return false;
  const flavor = path[pathFlavor(value)];
  const expected = flavor === path.win32 ? 'codex.exe' : 'codex';
  const basename = flavor.basename(value);
  return (flavor === path.win32 ? basename.toLowerCase() : basename) === expected;
}

function failure(code) {
  return { ok: false, code: FAILURE_CODES.has(code) ? code : 'FAILED' };
}

function launchError(code) {
  const error = /** @type {NodeJS.ErrnoException} */ (
    new Error(code === 'INVALID' ? 'Invalid agent launch request' : 'Codex unavailable')
  );
  error.code = code;
  return error;
}

module.exports = {
  createAgentLauncher,
  buildAgentSpec,
  resolveCodexExecutable,
  buildTaskPrompt,
};

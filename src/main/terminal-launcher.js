'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ALIAS_SEGMENTS = Object.freeze(['Microsoft', 'WindowsApps', 'wt.exe']);
// macOS: the fixed system launcher opens the stock Terminal app at a directory.
const MAC_OPEN_PATH = '/usr/bin/open';
const MAC_TERMINAL_APP = 'Terminal';
const VALID_FAILURES = new Set(['INVALID', 'UNAVAILABLE', 'FAILED']);

function createTerminalLauncher(options = {}) {
  const settings = options && typeof options === 'object' && !Array.isArray(options)
    ? options : {};
  const platform = Object.hasOwn(settings, 'platform') ? settings.platform : process.platform;
  const env = Object.hasOwn(settings, 'env') ? settings.env : process.env;
  const fsImpl = Object.hasOwn(settings, 'fsImpl') ? settings.fsImpl : fs;
  const spawnImpl = Object.hasOwn(settings, 'spawnImpl') ? settings.spawnImpl : spawn;

  return Object.freeze({
    async open(request) {
      const cwd = ownCwd(request);
      if (platform === 'darwin') return openMacTerminal({ cwd, fsImpl, spawnImpl });
      // Any other non-Windows host has no terminal adapter: fail closed before the
      // path is judged so the caller reports the control as unavailable, not invalid.
      if (platform !== 'win32') return failure('UNAVAILABLE');
      if (!isAbsoluteWindowsPath(cwd)) return failure('INVALID');

      let terminalPath;
      try {
        terminalPath = resolveWindowsTerminal({ platform, env, fsImpl });
      } catch (error) {
        return failure(error && VALID_FAILURES.has(error.code) ? error.code : 'UNAVAILABLE');
      }

      let spec;
      try {
        spec = buildTerminalSpec({ terminalPath, cwd });
      } catch {
        return failure('INVALID');
      }

      const launched = launchDetached(spawnImpl, spec);
      return launched.ok ? { ok: true, terminal: 'windows-terminal' } : launched;
    },
  });
}

async function openMacTerminal({ cwd, fsImpl, spawnImpl }) {
  if (!isAbsolutePosixPath(cwd)) return failure('INVALID');
  try {
    resolveMacOpen({ fsImpl });
  } catch (error) {
    return failure(error && VALID_FAILURES.has(error.code) ? error.code : 'UNAVAILABLE');
  }
  let spec;
  try {
    spec = buildMacTerminalSpec({ cwd });
  } catch {
    return failure('INVALID');
  }
  const launched = launchDetached(spawnImpl, spec);
  return launched.ok ? { ok: true, terminal: 'macos-terminal' } : launched;
}

function launchDetached(spawnImpl, spec) {
  if (typeof spawnImpl !== 'function') return failure('FAILED');
  try {
    const child = spawnImpl(spec.command, spec.args, spec.options);
    if (!child || typeof child.unref !== 'function') return failure('FAILED');
    if (typeof child.once === 'function') child.once('error', () => {});
    child.unref();
  } catch {
    return failure('FAILED');
  }
  return { ok: true };
}

function buildTerminalSpec({ terminalPath, cwd } = {}) {
  if (!isFixedAliasPath(terminalPath) || !isAbsoluteWindowsPath(cwd)) {
    throw launchError('INVALID');
  }

  return {
    command: terminalPath,
    args: ['-d', cwd],
    options: {
      cwd,
      shell: false,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    },
  };
}

function buildMacTerminalSpec({ cwd } = {}) {
  if (!isAbsolutePosixPath(cwd)) throw launchError('INVALID');
  return {
    command: MAC_OPEN_PATH,
    args: ['-a', MAC_TERMINAL_APP, cwd],
    options: {
      cwd,
      shell: false,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    },
  };
}

function resolveWindowsTerminal({ platform, env, fsImpl = fs } = {}) {
  if (platform !== 'win32') throw launchError('UNAVAILABLE');
  if (!env || typeof env !== 'object' || !Object.hasOwn(env, 'LOCALAPPDATA')) {
    throw launchError('UNAVAILABLE');
  }

  const descriptor = Object.getOwnPropertyDescriptor(env, 'LOCALAPPDATA');
  const localAppData = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : null;
  if (!isAbsoluteWindowsPath(localAppData)) throw launchError('UNAVAILABLE');

  const terminalPath = path.win32.join(localAppData, ...ALIAS_SEGMENTS);
  accessOrUnavailable(terminalPath, fsImpl);
  return terminalPath;
}

function resolveMacOpen({ fsImpl = fs } = {}) {
  accessOrUnavailable(MAC_OPEN_PATH, fsImpl);
  return MAC_OPEN_PATH;
}

function accessOrUnavailable(target, fsImpl) {
  try {
    const mode = fsImpl && fsImpl.constants ? fsImpl.constants.F_OK : fs.constants.F_OK;
    if (!fsImpl || typeof fsImpl.accessSync !== 'function') throw launchError('UNAVAILABLE');
    fsImpl.accessSync(target, mode);
  } catch {
    throw launchError('UNAVAILABLE');
  }
}

function ownCwd(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
      !Object.hasOwn(request, 'cwd')) return null;
  const descriptor = Object.getOwnPropertyDescriptor(request, 'cwd');
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : null;
}

function validPathString(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 32767 &&
    !value.includes('\0');
}

function isAbsoluteWindowsPath(value) {
  return validPathString(value) && path.win32.isAbsolute(value) &&
    path.win32.normalize(value) === value;
}

function isAbsolutePosixPath(value) {
  return validPathString(value) && value.startsWith('/') &&
    path.posix.normalize(value) === value;
}

function isFixedAliasPath(value) {
  if (!isAbsoluteWindowsPath(value)) return false;
  const normalized = path.win32.normalize(value);
  const executable = path.win32.basename(normalized);
  const windowsApps = path.win32.basename(path.win32.dirname(normalized));
  const microsoft = path.win32.basename(path.win32.dirname(path.win32.dirname(normalized)));
  return executable.toLowerCase() === 'wt.exe' &&
    windowsApps.toLowerCase() === 'windowsapps' && microsoft.toLowerCase() === 'microsoft';
}

function failure(code) {
  return { ok: false, code: VALID_FAILURES.has(code) ? code : 'FAILED' };
}

function launchError(code) {
  const error = new Error(code === 'INVALID' ? 'Invalid terminal request' : 'Terminal unavailable');
  error.code = code;
  return error;
}

module.exports = {
  createTerminalLauncher,
  buildTerminalSpec,
  buildMacTerminalSpec,
  resolveWindowsTerminal,
  resolveMacOpen,
};

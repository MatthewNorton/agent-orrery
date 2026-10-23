// @ts-check
'use strict';

const path = require('path');
const fs = require('fs');
const { isLocalProjectPath } = require('../provider-adapters');
const guards = require('./guards');
const { validProjectId } = guards;
const { resolveTerminalTarget } = require('../terminal/target');

/** @import { Failure, OpenTerminalResult, TerminalFailureCode } from '../../types/contract' */

function createTerminalIpc(ctx) {
  let terminalLaunchInFlight = false;
  let terminalLaunchCooldownUntil = 0;
  const trustedMainFrame = (event) => guards.trustedMainFrame(ctx, event);

  function liveProjectCwd(projectId) {
    if (!ctx.tracker || !(ctx.tracker.projects instanceof Map)) return null;
    const project = ctx.tracker.projects.get(projectId);
    // Security: project.path originates in transcript content. Refuse UNC/device paths
    // before any filesystem call so no network authentication can be forced.
    if (!project || project.exists !== true || !isLocalProjectPath(project.path) ||
        !path.isAbsolute(project.path)) return null;
    try {
      const real = fs.realpathSync.native(project.path);
      const cwd = path.normalize(real);
      if (!isLocalProjectPath(cwd) || !path.isAbsolute(cwd) || !fs.statSync(cwd).isDirectory()) {
        return null;
      }
      return cwd;
    } catch {
      return null;
    }
  }

  /** @returns {Failure<TerminalFailureCode>} */
  function terminalFailure(code) {
    const allowed = new Set(['INVALID', 'REPLAY', 'NOT_FOUND', 'UNAVAILABLE', 'BUSY', 'FAILED',
      'TERMINAL_NOT_FOUND', 'AMBIGUOUS']);
    return { ok: false, code: allowed.has(code) ? code : 'FAILED' };
  }

  /** @returns {Promise<OpenTerminalResult>} */
  async function handleOpenTerminal(event, targetId) {
    if (!trustedMainFrame(event) || !validProjectId(targetId)) return terminalFailure('INVALID');
    if (!guards.showingLive(ctx)) return terminalFailure('REPLAY');
    if (terminalLaunchInFlight || Date.now() < terminalLaunchCooldownUntil) {
      return terminalFailure('BUSY');
    }
    if (process.platform !== 'win32' && process.platform !== 'darwin' && !ctx.flags.controlTest) {
      return terminalFailure('UNAVAILABLE');
    }
    const target = resolveTerminalTarget(ctx.tracker, targetId);
    if (target.code) return terminalFailure(target.code);
    const cwd = liveProjectCwd(target.projectId);
    if (!cwd) return terminalFailure('NOT_FOUND');
    const adapter = target.session ? ctx.terminalFocus : ctx.terminalLauncher;
    const method = target.session ? 'focus' : 'open';
    if (!adapter || typeof adapter[method] !== 'function') {
      return terminalFailure('UNAVAILABLE');
    }

    terminalLaunchInFlight = true;
    try {
      const outcome = await adapter[method](target.session ? { ...target.session, cwd } : { cwd });
      if (outcome && outcome.ok === true) {
        terminalLaunchCooldownUntil = Date.now() + 750;
        return { ok: true };
      }
      return terminalFailure(outcome && typeof outcome.code === 'string' ? outcome.code : 'FAILED');
    } catch {
      return terminalFailure('FAILED');
    } finally {
      terminalLaunchInFlight = false;
    }
  }

  function reset() {
    terminalLaunchInFlight = false;
    terminalLaunchCooldownUntil = 0;
  }

  return { liveProjectCwd, handleOpenTerminal, reset };
}

module.exports = { createTerminalIpc };

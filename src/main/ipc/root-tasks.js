// @ts-check
'use strict';

const guards = require('./guards');
const { validProjectId } = guards;

/**
 * @import { Failure, RootTaskFailureCode, RootTaskResult, RootTasksChangedPush,
 *   RootTasksSnapshot } from '../../types/contract'
 */

function createRootTasksIpc(ctx) {
  const trustedMainFrame = (event) => guards.trustedMainFrame(ctx, event);

  /** @returns {Failure<RootTaskFailureCode>} */
  function rootTaskFailure(code) {
    const allowed = new Set([
      'INVALID', 'REPLAY', 'NOT_FOUND', 'LIMIT_REACHED', 'PROJECT_IMMUTABLE',
      'INVALID_TRANSITION', 'PROJECT_NOT_FOUND', 'PROJECT_BUSY', 'BUSY',
      'WRITE_FAILED', 'UNAVAILABLE', 'LAUNCH_FAILED', 'FAILED',
    ]);
    return { ok: false, code: allowed.has(code) ? code : 'FAILED' };
  }

  function rootTaskMutationDenied(event) {
    if (!trustedMainFrame(event)) return rootTaskFailure('INVALID');
    if (!guards.showingLive(ctx)) return rootTaskFailure('REPLAY');
    if (!ctx.rootTaskCoordinator) return rootTaskFailure('FAILED');
    return null;
  }

  /** @returns {RootTasksSnapshot} */
  function handleRootTasksGet(event) {
    if (!trustedMainFrame(event) || !ctx.rootTaskCoordinator) return { items: [] };
    try {
      return ctx.rootTaskCoordinator.snapshot();
    } catch {
      return { items: [] };
    }
  }

  /** @returns {RootTaskResult} */
  function handleRootTaskCreate(event, text) {
    const denied = rootTaskMutationDenied(event);
    if (denied) return denied;
    try {
      return ctx.rootTaskCoordinator.create(text);
    } catch {
      return rootTaskFailure('FAILED');
    }
  }

  /** @returns {RootTaskResult} */
  function handleRootTaskRemove(event, taskId) {
    const denied = rootTaskMutationDenied(event);
    if (denied) return denied;
    try {
      return ctx.rootTaskCoordinator.remove(taskId);
    } catch {
      return rootTaskFailure('FAILED');
    }
  }

  /** @returns {Promise<RootTaskResult>} */
  async function handleRootTaskAssign(event, taskId, projectId) {
    const denied = rootTaskMutationDenied(event);
    if (denied) return denied;
    try {
      return await ctx.rootTaskCoordinator.assign(taskId, projectId);
    } catch {
      return rootTaskFailure('FAILED');
    }
  }

  /** @returns {Promise<RootTaskResult>} */
  async function handleRootTaskRetry(event, taskId) {
    const denied = rootTaskMutationDenied(event);
    if (denied) return denied;
    try {
      return await ctx.rootTaskCoordinator.retry(taskId);
    } catch {
      return rootTaskFailure('FAILED');
    }
  }

  function sendRootTasksChanged(value, reason = null) {
    if (!ctx.win || ctx.win.isDestroyed() || !value || typeof value.id !== 'string') return;
    ctx.win.webContents.send('au:root-tasks-changed', /** @satisfies {RootTasksChangedPush} */ ({
      taskId: value.id,
      phase: reason === 'removed' ? null : (typeof value.phase === 'string' ? value.phase : null),
    }));
  }

  function liveProjectShips(projectId) {
    if (!validProjectId(projectId) || !ctx.tracker || !(ctx.tracker.ships instanceof Map)) return [];
    return [...ctx.tracker.ships.values()].filter((ship) => ship && ship.project === projectId);
  }

  return {
    handleRootTasksGet,
    handleRootTaskCreate,
    handleRootTaskRemove,
    handleRootTaskAssign,
    handleRootTaskRetry,
    sendRootTasksChanged,
    liveProjectShips,
  };
}

module.exports = { createRootTasksIpc };

'use strict';

const { appendGoal, readGoalsFile, removeGoal, setGoalDone } = require('../goals');
const guards = require('./guards');
const { validProjectId } = guards;

function createTasksIpc(ctx) {
  const trustedMainFrame = (event) => guards.trustedMainFrame(ctx, event);

  function handleTasksGet(event, projectId) {
    if (!trustedMainFrame(event) || !validProjectId(projectId)) return null;
    if (ctx.activeSource !== ctx.tracker || ctx.replay.replayBoundaryOperations > 0) return null;
    const cwd = ctx.ipc.terminal.liveProjectCwd(projectId);
    if (!cwd) return null;
    try {
      const result = readGoalsFile(cwd);
      if (ctx.taskRuns) ctx.taskRuns.reconcile(projectId, result.items);
      const items = ctx.taskRuns ? ctx.taskRuns.decorate(projectId, result.items) : result.items;
      return { exists: result.exists, path: result.path, items };
    } catch {
      return null;
    }
  }

  function handleTaskAdd(event, projectId, text) {
    if (!trustedMainFrame(event) || !validProjectId(projectId) ||
        ctx.activeSource !== ctx.tracker || ctx.replay.replayBoundaryOperations > 0) {
      return { ok: false, items: [] };
    }
    const cwd = ctx.ipc.terminal.liveProjectCwd(projectId);
    if (!cwd) return { ok: false, items: [] };
    try {
      return taskMutationResult(projectId, appendGoal(cwd, text), true);
    } catch {
      return { ok: false, items: [] };
    }
  }

  function handleTaskSetDone(event, projectId, request) {
    if (!trustedMainFrame(event) || !validProjectId(projectId) ||
        ctx.activeSource !== ctx.tracker || ctx.replay.replayBoundaryOperations > 0) {
      return { ok: false, items: [] };
    }
    const cwd = ctx.ipc.terminal.liveProjectCwd(projectId);
    if (!cwd) return { ok: false, items: [] };
    try {
      return taskMutationResult(projectId, setGoalDone(cwd, request), true);
    } catch {
      return { ok: false, items: [] };
    }
  }

  function handleTaskRemove(event, projectId, request) {
    if (!trustedMainFrame(event) || !validProjectId(projectId) ||
        ctx.activeSource !== ctx.tracker || ctx.replay.replayBoundaryOperations > 0) {
      return { ok: false, items: [] };
    }
    const cwd = ctx.ipc.terminal.liveProjectCwd(projectId);
    if (!cwd) return { ok: false, items: [] };
    try {
      return taskMutationResult(projectId, removeGoal(cwd, request), true);
    } catch {
      return { ok: false, items: [] };
    }
  }

  function taskMutationResult(projectId, result, ok) {
    const items = result && Array.isArray(result.items) ? result.items : [];
    if (ok && ctx.taskRuns) ctx.taskRuns.reconcile(projectId, items);
    return {
      ok: Boolean(ok),
      items: ctx.taskRuns ? ctx.taskRuns.decorate(projectId, items) : items,
    };
  }

  return { handleTasksGet, handleTaskAdd, handleTaskSetDone, handleTaskRemove };
}

module.exports = { createTasksIpc };

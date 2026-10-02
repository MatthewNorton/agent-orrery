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

  function handleTasksSave(event, projectId, items) {
    if (!trustedMainFrame(event) || !validProjectId(projectId)) {
      return { ok: false, items: [] };
    }
    if (ctx.activeSource !== ctx.tracker || ctx.replay.replayBoundaryOperations > 0) {
      return { ok: false, items: [] };
    }
    const cwd = ctx.ipc.terminal.liveProjectCwd(projectId);
    if (!cwd) return { ok: false, items: [] };
    try {
      const current = readGoalsFile(cwd);
      if (!Array.isArray(items) || items.length > 10_000) return taskMutationResult(projectId, current, false);
      const additions = [];
      const changes = [];
      const seen = new Set();
      for (const item of items) {
        if (!item || typeof item !== 'object' || typeof item.text !== 'string' ||
            typeof item.done !== 'boolean') return taskMutationResult(projectId, current, false);
        const existing = typeof item.id === 'string'
          ? current.items.find((goal) => goal.id === item.id.toLowerCase())
          : Number.isSafeInteger(item.line)
            ? current.items.find((goal) => goal.line === item.line)
            : null;
        if (!existing) {
          if (item.id != null || item.line != null) return taskMutationResult(projectId, current, false);
          additions.push(item);
          continue;
        }
        const key = existing.id || `line:${existing.line}`;
        if (seen.has(key) || existing.text !== item.text) {
          return taskMutationResult(projectId, current, false);
        }
        seen.add(key);
        if (existing.done !== item.done) changes.push({ existing, done: item.done });
      }
      if (changes.length === 1 && additions.length === 0) {
        const change = changes[0];
        return taskMutationResult(projectId, setGoalDone(cwd, {
          ...(change.existing.id ? { id: change.existing.id } : { line: change.existing.line }),
          text: change.existing.text,
          done: change.done,
        }), true);
      }
      if (changes.length === 0 && additions.length === 1) {
        return taskMutationResult(projectId, appendGoal(cwd, additions[0].text), true);
      }
      return taskMutationResult(projectId, current, changes.length === 0 && additions.length === 0);
    } catch {
      return { ok: false, items: [] };
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

  return { handleTasksGet, handleTasksSave, handleTaskAdd, handleTaskSetDone, handleTaskRemove };
}

module.exports = { createTasksIpc };

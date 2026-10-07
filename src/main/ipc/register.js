// @ts-check
'use strict';

const { ipcMain, shell } = require('electron');
const { isLocalProjectPath } = require('../provider-adapters');
const { githubIdentity } = require('../project-vcs-status');
const guards = require('./guards');

/** @import { OpenExternalResult } from '../../types/contract' */

function registerIpc(ctx, handlers) {
  const trustedMainFrame = (event) => guards.trustedMainFrame(ctx, event);
  const { visibleSnapshot, visibleSystem, visibleProject, handleReplayCommand } = handlers.replay;
  const { handleOpenTerminal } = handlers.terminal;
  const { handleTasksGet, handleTaskAdd, handleTaskSetDone, handleTaskRemove } = handlers.tasks;
  const {
    handleRootTasksGet, handleRootTaskCreate, handleRootTaskRemove, handleRootTaskAssign, handleRootTaskRetry,
  } = handlers.rootTasks;
  const { handleProjectPathsScan, handleProjectPathLocate, handleProjectPathApply } = handlers.projectPaths;

  ipcMain.handle('au:snapshot', (event) => (trustedMainFrame(event) ? visibleSnapshot() : null));
  ipcMain.handle('au:open-external', /** @returns {Promise<OpenExternalResult>} */ async (event, url) => {
    if (!trustedMainFrame(event)) return { ok: false, code: 'INVALID_URL' };
    const repository = githubIdentity(url);
    if (!repository) return { ok: false, code: 'INVALID_URL' };
    try {
      await shell.openExternal(repository.url);
      return { ok: true };
    } catch {
      return { ok: false, code: 'OPEN_FAILED' };
    }
  });
  ipcMain.handle('au:system', (event, id) => (trustedMainFrame(event) ? visibleSystem(id) : null));
  ipcMain.handle('au:planet', (event, id, name) => {
    if (!trustedMainFrame(event) || typeof id !== 'string' || typeof name !== 'string' ||
        name.length > 255) return null;
    return (ctx.activeSource || ctx.tracker).getPlanet(id, name);
  });
  ipcMain.handle('au:replay', (event, command) => (
    trustedMainFrame(event) ? handleReplayCommand(command) : null
  ));
  ipcMain.handle('au:open-terminal', (event, projectId) => handleOpenTerminal(event, projectId));
  ipcMain.handle('au:tasks-get', (event, projectId) => handleTasksGet(event, projectId));
  ipcMain.handle('au:task-add', (event, projectId, text) => handleTaskAdd(event, projectId, text));
  ipcMain.handle('au:task-set-done', (event, projectId, request) => (
    handleTaskSetDone(event, projectId, request)
  ));
  ipcMain.handle('au:task-remove', (event, projectId, request) => (
    handleTaskRemove(event, projectId, request)
  ));
  ipcMain.handle('au:root-tasks-get', (event) => handleRootTasksGet(event));
  ipcMain.handle('au:root-task-create', (event, text) => handleRootTaskCreate(event, text));
  ipcMain.handle('au:root-task-remove', (event, taskId) => handleRootTaskRemove(event, taskId));
  ipcMain.handle('au:root-task-assign', (event, taskId, projectId) => (
    handleRootTaskAssign(event, taskId, projectId)
  ));
  ipcMain.handle('au:root-task-retry', (event, taskId) => handleRootTaskRetry(event, taskId));
  ipcMain.handle('au:project-paths-scan', (event) => handleProjectPathsScan(event));
  ipcMain.handle('au:project-path-locate', (event, projectId) => handleProjectPathLocate(event, projectId));
  ipcMain.handle('au:project-path-apply', (event, projectId, token) => (
    handleProjectPathApply(event, projectId, token)
  ));
  ipcMain.handle('au:open', (event, id) => {
    if (!trustedMainFrame(event)) return '';
    const p = visibleProject(id);
    if (ctx.flags.polishTest || ctx.flags.providerTest || ctx.flags.historyTest || ctx.flags.controlTest) {
      ctx.harness.openedProjects.push(id);
      return '';
    }
    // Security: only open local directories; a UNC path would force an SMB round-trip.
    if (p && p.exists && isLocalProjectPath(p.path)) return shell.openPath(p.path);
    return '';
  });
}

module.exports = { registerIpc };

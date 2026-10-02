'use strict';

const { app, ipcMain, shell } = require('electron');
const { isLocalProjectPath } = require('./provider-adapters');
const { githubIdentity } = require('./project-vcs-status');
const { readFlags } = require('./flags');
const fixtures = require('./harness/fixtures');
const { createDriver } = require('./harness/driver');
const { createMetrics } = require('./harness/metrics');
const shots = require('./harness/modes/shots');
const control = require('./harness/modes/control');
const history = require('./harness/modes/history');
const provider = require('./harness/modes/provider');
const polish = require('./harness/modes/polish');
const { createAppContext } = require('./app-context');
const { createWindow } = require('./window');
const { createReplayControl } = require('./replay-control');
const guards = require('./ipc/guards');
const { createTerminalIpc } = require('./ipc/terminal');
const { createTasksIpc } = require('./ipc/tasks');
const { createRootTasksIpc } = require('./ipc/root-tasks');
const { createProjectPathsIpc } = require('./ipc/project-paths');

const flags = readFlags(process.argv);
const POLISH_TEST = flags.polishTest;
const PROVIDER_TEST = flags.providerTest;
const HISTORY_TEST = flags.historyTest;
const CONTROL_TEST = flags.controlTest;
const ctx = createAppContext({ flags, fixtures });
ctx.replay = createReplayControl(ctx);
const { visibleSnapshot, visibleSystem, visibleProject, handleReplayCommand } = ctx.replay;
ctx.ipc = {
  terminal: createTerminalIpc(ctx),
  tasks: createTasksIpc(ctx),
  rootTasks: createRootTasksIpc(ctx),
  projectPaths: createProjectPathsIpc(ctx),
};
const { handleOpenTerminal } = ctx.ipc.terminal;
const { handleTasksGet, handleTasksSave, handleTaskAdd, handleTaskSetDone, handleTaskRemove } = ctx.ipc.tasks;
const {
  handleRootTasksGet, handleRootTaskCreate, handleRootTaskRemove, handleRootTaskAssign, handleRootTaskRetry,
} = ctx.ipc.rootTasks;
const { handleProjectPathsScan, handleProjectPathLocate, handleProjectPathApply } = ctx.ipc.projectPaths;
const driver = createDriver(ctx);
const metrics = createMetrics(ctx, driver);
ctx.harness.runTestMode = () => {
  if (CONTROL_TEST) control.run(ctx, driver, metrics);
  else if (HISTORY_TEST) history.run(ctx, driver, metrics);
  else if (PROVIDER_TEST) provider.run(ctx, driver, metrics);
  else if (POLISH_TEST) polish.run(ctx, driver, metrics);
  else shots.run(ctx, driver, metrics);
};

const trustedMainFrame = (event) => guards.trustedMainFrame(ctx, event);

ipcMain.handle('au:snapshot', (event) => (trustedMainFrame(event) ? visibleSnapshot() : null));
ipcMain.handle('au:open-external', async (event, url) => {
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
ipcMain.handle('au:tasks-save', (event, projectId, items) => handleTasksSave(event, projectId, items));
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
  if (POLISH_TEST || PROVIDER_TEST || HISTORY_TEST || CONTROL_TEST) {
    ctx.harness.openedProjects.push(id);
    return '';
  }
  // Security: only open local directories; a UNC path would force an SMB round-trip.
  if (p && p.exists && isLocalProjectPath(p.path)) return shell.openPath(p.path);
  return '';
});

app.whenReady().then(() => {
  ctx.win = createWindow(ctx);
  ctx.start();
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', ctx.cleanup);

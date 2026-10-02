'use strict';

const { app, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { isLocalProjectPath } = require('./provider-adapters');
const { scanProjectCandidates, isPathInside } = require('./project-paths');
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
const { validProjectId } = guards;
const { createTerminalIpc } = require('./ipc/terminal');
const { createTasksIpc } = require('./ipc/tasks');
const { createRootTasksIpc } = require('./ipc/root-tasks');

const flags = readFlags(process.argv);
const POLISH_TEST = flags.polishTest;
const PROVIDER_TEST = flags.providerTest;
const HISTORY_TEST = flags.historyTest;
const CONTROL_TEST = flags.controlTest;
let projectPathDialogInFlight = false;
let projectPathScanAbort = null;
const projectPathCandidates = new Map();
const PROJECT_PATH_CANDIDATE_TTL_MS = 10 * 60 * 1000;
const ctx = createAppContext({ flags, fixtures });
ctx.replay = createReplayControl(ctx);
const { visibleSnapshot, visibleSystem, visibleProject, handleReplayCommand } = ctx.replay;
// Interim: these concerns still live here until ipc/ owns them.
ctx.ipc = {
  terminal: createTerminalIpc(ctx),
  tasks: createTasksIpc(ctx),
  rootTasks: createRootTasksIpc(ctx),
  projectPaths: {
    revokeProjectPathCandidates,
    reset() {
      if (projectPathScanAbort) projectPathScanAbort.abort();
      projectPathScanAbort = null;
      projectPathDialogInFlight = false;
      projectPathCandidates.clear();
    },
  },
};
const { handleOpenTerminal } = ctx.ipc.terminal;
const { handleTasksGet, handleTasksSave, handleTaskAdd, handleTaskSetDone, handleTaskRemove } = ctx.ipc.tasks;
const {
  handleRootTasksGet, handleRootTaskCreate, handleRootTaskRemove, handleRootTaskAssign, handleRootTaskRetry,
} = ctx.ipc.rootTasks;
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

function projectPathFailure(code) {
  const allowed = new Set([
    'INVALID', 'REPLAY', 'BUSY', 'NOT_FOUND', 'NOT_MISSING',
    'IN_USE', 'EXPIRED', 'FAILED',
  ]);
  return { ok: false, code: allowed.has(code) ? code : 'FAILED' };
}

function projectPathRequestAllowed(event) {
  if (!trustedMainFrame(event)) return projectPathFailure('INVALID');
  if (!ctx.tracker || ctx.activeSource !== ctx.tracker || ctx.replay.replayBoundaryOperations > 0) {
    return projectPathFailure('REPLAY');
  }
  return null;
}

function missingLiveProject(projectId) {
  if (!validProjectId(projectId) || !ctx.tracker || !(ctx.tracker.projects instanceof Map)) return null;
  const project = ctx.tracker.projects.get(projectId);
  return project && project.exists === false ? project : null;
}

function nearestExistingDirectory(inputPath) {
  let candidate = typeof inputPath === 'string' && path.isAbsolute(inputPath)
    ? path.normalize(inputPath) : null;
  if (candidate) {
    try {
      if (!fs.statSync(candidate).isDirectory()) candidate = path.dirname(candidate);
    } catch {
      candidate = path.dirname(candidate);
    }
    while (candidate && path.isAbsolute(candidate)) {
      try {
        if (fs.statSync(candidate).isDirectory()) return candidate;
      } catch { /* keep walking toward the filesystem root */ }
      const parent = path.dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }
  }
  try {
    const documents = app.getPath('documents');
    if (documents && fs.statSync(documents).isDirectory()) return documents;
  } catch { /* dialog can choose its own default */ }
  return undefined;
}

function currentMissingProjects() {
  if (!ctx.tracker || !(ctx.tracker.projects instanceof Map)) return [];
  return [...ctx.tracker.projects.values()]
    .filter((project) => project && project.exists === false)
    .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
}

function pruneProjectPathCandidates() {
  const now = Date.now();
  for (const [token, candidate] of projectPathCandidates) {
    if (!candidate || candidate.expiresAt <= now) projectPathCandidates.delete(token);
  }
}

function revokeProjectPathCandidates(projectId) {
  for (const [token, candidate] of projectPathCandidates) {
    if (candidate && candidate.projectId === projectId) projectPathCandidates.delete(token);
  }
}

function sameFilesystemPath(left, right) {
  const a = path.normalize(left);
  const b = path.normalize(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function pathRecoveryError(error) {
  return projectPathFailure(error && typeof error.code === 'string' ? error.code : 'FAILED');
}

async function handleProjectPathsScan(event) {
  const denied = projectPathRequestAllowed(event);
  if (denied) return denied;
  if (projectPathDialogInFlight) return projectPathFailure('BUSY');
  const projects = currentMissingProjects();
  if (projects.length === 0) {
    return { ok: true, canceled: false, root: null, directoriesVisited: 0, truncated: false, matches: [] };
  }

  projectPathDialogInFlight = true;
  try {
    const selection = await dialog.showOpenDialog(ctx.win, {
      title: 'Choose a folder to scan for moved projects',
      buttonLabel: 'Scan this folder',
      defaultPath: nearestExistingDirectory(projects[0].path),
      properties: ['openDirectory'],
    });
    if (selection.canceled || !selection.filePaths[0]) return { ok: true, canceled: true };
    const afterSelectionDenied = projectPathRequestAllowed(event);
    if (afterSelectionDenied) return afterSelectionDenied;

    projectPathScanAbort = new AbortController();
    const result = await scanProjectCandidates(selection.filePaths[0], projects, {
      signal: projectPathScanAbort.signal,
    });
    const afterScanDenied = projectPathRequestAllowed(event);
    if (afterScanDenied) return afterScanDenied;
    const stillMissing = new Set(currentMissingProjects().map((project) => project.id));
    const scanId = crypto.randomUUID();
    const expiresAt = Date.now() + PROJECT_PATH_CANDIDATE_TTL_MS;
    projectPathCandidates.clear();
    const matches = result.matches.filter((match) => stillMissing.has(match.projectId)).map((match) => ({
      projectId: match.projectId,
      candidates: match.candidates.map((candidatePath) => {
        const token = crypto.randomUUID();
        projectPathCandidates.set(token, {
          scanId,
          projectId: match.projectId,
          path: candidatePath,
          root: result.root,
          expiresAt,
        });
        return { token, path: candidatePath };
      }),
    }));
    return {
      ok: true,
      canceled: false,
      scanId,
      root: result.root,
      directoriesVisited: result.directoriesVisited,
      truncated: result.truncated,
      matches,
    };
  } catch (error) {
    return pathRecoveryError(error);
  } finally {
    projectPathScanAbort = null;
    projectPathDialogInFlight = false;
  }
}

async function handleProjectPathLocate(event, projectId) {
  const denied = projectPathRequestAllowed(event);
  if (denied) return denied;
  if (!validProjectId(projectId)) return projectPathFailure('INVALID');
  if (!ctx.tracker.projects.has(projectId)) return projectPathFailure('NOT_FOUND');
  const project = missingLiveProject(projectId);
  if (!project) return projectPathFailure('NOT_MISSING');
  if (projectPathDialogInFlight) return projectPathFailure('BUSY');

  projectPathDialogInFlight = true;
  try {
    const selection = await dialog.showOpenDialog(ctx.win, {
      title: `Locate ${project.name || 'project'}`,
      buttonLabel: 'Use this folder',
      defaultPath: nearestExistingDirectory(project.path),
      properties: ['openDirectory'],
    });
    if (selection.canceled || !selection.filePaths[0]) return { ok: true, canceled: true };
    const afterSelectionDenied = projectPathRequestAllowed(event);
    if (afterSelectionDenied) return afterSelectionDenied;
    if (!ctx.tracker.projects.has(projectId)) return projectPathFailure('NOT_FOUND');
    if (!missingLiveProject(projectId)) return projectPathFailure('NOT_MISSING');
    const recovered = ctx.tracker.remapProjectPath(projectId, selection.filePaths[0]);
    revokeProjectPathCandidates(projectId);
    return { ok: true, canceled: false, project: recovered };
  } catch (error) {
    return pathRecoveryError(error);
  } finally {
    projectPathDialogInFlight = false;
  }
}

function handleProjectPathApply(event, projectId, token) {
  const denied = projectPathRequestAllowed(event);
  if (denied) return denied;
  if (!validProjectId(projectId) || typeof token !== 'string' || !token || token.length > 128) {
    return projectPathFailure('INVALID');
  }
  if (!ctx.tracker.projects.has(projectId)) return projectPathFailure('NOT_FOUND');
  if (!missingLiveProject(projectId)) return projectPathFailure('NOT_MISSING');
  pruneProjectPathCandidates();
  const candidate = projectPathCandidates.get(token);
  if (!candidate || candidate.projectId !== projectId) return projectPathFailure('EXPIRED');

  try {
    const realRoot = path.normalize(fs.realpathSync.native(candidate.root));
    const realCandidate = path.normalize(fs.realpathSync.native(candidate.path));
    if (!sameFilesystemPath(realRoot, candidate.root) ||
        !sameFilesystemPath(realCandidate, candidate.path) ||
        !fs.statSync(realCandidate).isDirectory() || !isPathInside(realRoot, realCandidate)) {
      return projectPathFailure('INVALID');
    }
    const project = ctx.tracker.remapProjectPath(projectId, realCandidate);
    revokeProjectPathCandidates(projectId);
    return { ok: true, canceled: false, project };
  } catch (error) {
    return pathRecoveryError(error);
  }
}

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

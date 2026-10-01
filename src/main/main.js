'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { Tracker } = require('./tracker');
const { ReplaySource } = require('./replay-source');
const { isLocalProjectPath } = require('./provider-adapters');
const { createTerminalLauncher } = require('./terminal-launcher');
const { createAgentLauncher } = require('./agent-launcher');
const { appendGoal, readGoalsFile, removeGoal, setGoalDone } = require('./goals');
const { TaskRunTracker } = require('./task-runs');
const { RootTaskStore } = require('./root-tasks');
const { RootTaskCoordinator } = require('./root-task-coordinator');
const { scanProjectCandidates, isPathInside } = require('./project-paths');
const { createLocalGitStatusCollector, githubIdentity } = require('./project-vcs-status');
const { createGitHubMetadataProvider } = require('./github-metadata-provider');
const { createProjectVcsStatusService } = require('./project-vcs-status-service');
const { createProjectVcsStatusController } = require('./project-vcs-status-controller');
const {
  rendererUrl,
  trustedMainFrame: isTrustedMainFrame,
  hardenWebContents,
} = require('./window-security');
const { readFlags } = require('./flags');
const {
  createProviderFixture,
  createHistoryFixture,
  createControlFixture,
  createRecordingTerminalLauncher,
} = require('./harness/fixtures');
const { createDriver } = require('./harness/driver');
const { createMetrics } = require('./harness/metrics');
const shots = require('./harness/modes/shots');
const control = require('./harness/modes/control');
const history = require('./harness/modes/history');
const provider = require('./harness/modes/provider');
const polish = require('./harness/modes/polish');

const flags = readFlags(process.argv);
const POLISH_TEST = flags.polishTest;
const PROVIDER_TEST = flags.providerTest;
const HISTORY_TEST = flags.historyTest;
const CONTROL_TEST = flags.controlTest;
const TEST_MODE = flags.testMode;
const RENDERER_ENTRY_PATH = path.join(__dirname, '..', 'renderer', 'index.html');
const RENDERER_ENTRY_URL = rendererUrl(RENDERER_ENTRY_PATH);
let win = null;
let tracker = null;
let replaySource = null;
let activeSource = null;
let terminalLauncher = null;
let taskRuns = null;
let rootTasks = null;
let rootTaskCoordinator = null;
let taskRunSweepTimer = null;
let projectVcsStatusController = null;
let streamEpoch = 1;
let replayOperation = 0;
let replayBoundaryOperations = 0;
let replayIndexPromise = null;
let replayStateLastSent = 0;
let replayStateTimer = null;
let providerFixtureRoot = null;
let historyFixtureRoot = null;
let historyFixture = null;
let controlFixture = null;
let terminalLaunchInFlight = false;
let terminalLaunchCooldownUntil = 0;
let projectPathDialogInFlight = false;
let projectPathScanAbort = null;
const projectPathCandidates = new Map();
const PROJECT_PATH_CANDIDATE_TTL_MS = 10 * 60 * 1000;
const rendererTestErrors = [];
const openedProjects = [];
const ctx = {
  flags,
  get win() { return win; },
  get tracker() { return tracker; },
  get replaySource() { return replaySource; },
  get terminalLauncher() { return terminalLauncher; },
  get streamEpoch() { return streamEpoch; },
  replay: { boundedReplayStatus },
  cleanup: cleanupForExit,
  harness: {
    rendererTestErrors,
    get controlFixture() { return controlFixture; },
    get historyFixture() { return historyFixture; },
    openedProjects,
  },
};
const driver = createDriver(ctx);
const metrics = createMetrics(ctx, driver);

function cleanupForExit() {
  replayOperation++;
  if (projectPathScanAbort) projectPathScanAbort.abort();
  projectPathScanAbort = null;
  projectPathDialogInFlight = false;
  projectPathCandidates.clear();
  if (replayStateTimer) clearTimeout(replayStateTimer);
  replayStateTimer = null;
  if (taskRunSweepTimer) clearInterval(taskRunSweepTimer);
  taskRunSweepTimer = null;
  if (projectVcsStatusController) projectVcsStatusController.stop();
  projectVcsStatusController = null;
  if (replaySource) {
    replaySource.stop();
    replaySource = null;
  }
  if (tracker) {
    tracker.stop();
    tracker = null;
  }
  activeSource = null;
  terminalLauncher = null;
  rootTaskCoordinator = null;
  rootTasks = null;
  taskRuns = null;
  terminalLaunchInFlight = false;
  terminalLaunchCooldownUntil = 0;
  replayBoundaryOperations = 0;
  if (providerFixtureRoot) {
    try { fs.rmSync(providerFixtureRoot, { recursive: true, force: true }); } catch { /* temporary test fixture */ }
    providerFixtureRoot = null;
  }
  if (historyFixtureRoot) {
    const target = path.resolve(historyFixtureRoot);
    const tempRoot = path.resolve(os.tmpdir());
    if (target.startsWith(`${tempRoot}${path.sep}`)) {
      try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* temporary test fixture */ }
    }
    historyFixtureRoot = null;
    historyFixture = null;
    controlFixture = null;
  }
}

function boundedReplayStatus(mode = null) {
  const raw = replaySource ? replaySource.status() : {};
  const minTs = Number.isFinite(raw.minTs) ? raw.minTs :
    (Number.isFinite(raw.minMs) ? raw.minMs : null);
  const maxTs = Number.isFinite(raw.maxTs) ? raw.maxTs :
    (Number.isFinite(raw.maxMs) ? raw.maxMs : null);
  let cursorTs = Number.isFinite(raw.cursorTs) ? raw.cursorTs :
    (Number.isFinite(raw.cursorMs) ? raw.cursorMs : null);
  const visibleMode = mode || (activeSource === replaySource ? 'replay' : 'live');
  if (visibleMode === 'live' && Number.isFinite(maxTs)) cursorTs = maxTs;
  return {
    mode: visibleMode,
    available: typeof raw.available === 'boolean'
      ? raw.available : Boolean(Number.isFinite(minTs) && Number.isFinite(maxTs)),
    indexing: typeof raw.indexing === 'boolean' ? raw.indexing : raw.phase === 'indexing',
    minTs,
    maxTs,
    cursorTs,
    playing: visibleMode === 'replay' && Boolean(raw.playing),
    speed: [1, 10, 100, 1000].includes(Number(raw.speed)) ? Number(raw.speed) : 1,
    sourceCount: Number.isFinite(raw.sourceCount) ? raw.sourceCount :
      (Number.isFinite(raw.sessionCount) ? raw.sessionCount : 0),
    truncated: typeof raw.truncated === 'boolean' ? raw.truncated : Boolean(raw.partial),
  };
}

function visibleSnapshot() {
  const source = activeSource || tracker;
  let snapshot = source ? source.snapshot() : {
    projects: [], ships: [], feed: [], eventSequence: 0,
  };
  if (projectVcsStatusController) {
    snapshot = projectVcsStatusController.enrichSnapshot(source, snapshot);
  }
  return {
    ...snapshot,
    streamEpoch,
    playback: boundedReplayStatus(source === replaySource ? 'replay' : 'live'),
  };
}

function visibleSystem(projectId) {
  const source = activeSource || tracker;
  const system = source ? source.getSystem(projectId) : null;
  return projectVcsStatusController
    ? projectVcsStatusController.enrichSystem(source, system)
    : system;
}

function sendProjectVcsStatusChanged(status) {
  if (!status || activeSource !== tracker || !win || win.isDestroyed()) return;
  win.webContents.send('au:project-vcs-status-changed', status, {
    streamEpoch,
    mode: 'live',
  });
}

function replayResult(includeSnapshot = false) {
  const playback = boundedReplayStatus(activeSource === replaySource ? 'replay' : 'live');
  return {
    playback,
    streamEpoch,
    ...(includeSnapshot ? { snapshot: visibleSnapshot() } : {}),
  };
}

function sendReplayState() {
  if (!win || win.isDestroyed()) return;
  const now = Date.now();
  const remaining = 100 - (now - replayStateLastSent);
  if (remaining > 0) {
    if (!replayStateTimer) {
      replayStateTimer = setTimeout(() => {
        replayStateTimer = null;
        sendReplayState();
      }, remaining);
    }
    return;
  }
  replayStateLastSent = now;
  win.webContents.send('au:replay-state', {
    ...boundedReplayStatus(activeSource === replaySource ? 'replay' : 'live'),
    streamEpoch,
  });
}

async function ensureReplayIndex(force = false) {
  if (!replaySource) throw new Error('history playback is unavailable');
  const current = boundedReplayStatus('replay');
  if (!force && current.available && !current.indexing) return current;
  if (!replayIndexPromise) {
    replayIndexPromise = replaySource.index()
      .finally(() => { replayIndexPromise = null; });
  }
  await replayIndexPromise;
  return boundedReplayStatus('replay');
}

function validateReplayCommand(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throw new TypeError('replay command must be an object');
  }
  const action = command.action;
  if (!['index', 'seek', 'play', 'pause', 'speed', 'live'].includes(action)) {
    throw new TypeError('unsupported replay action');
  }
  if (action === 'seek' && (typeof command.ts !== 'number' || !Number.isFinite(command.ts))) {
    throw new TypeError('replay seek timestamp must be finite');
  }
  if (action === 'speed' && (typeof command.speed !== 'number' ||
      ![1, 10, 100, 1000].includes(command.speed))) {
    throw new RangeError('unsupported replay speed');
  }
  return action;
}

async function handleReplayCommand(command) {
  const action = validateReplayCommand(command);
  const operation = ++replayOperation;

  if (action === 'index') {
    if (activeSource === replaySource) throw new Error('return to LIVE before rebuilding the history index');
    await ensureReplayIndex(true);
    return replayResult(false);
  }

  if (action === 'seek') {
    replayBoundaryOperations++;
    try {
      await ensureReplayIndex(false);
      const status = boundedReplayStatus('replay');
      if (!status.available) throw new Error('no historical records are available');
      const target = Math.max(status.minTs, Math.min(status.maxTs, command.ts));
      // Forward scrubs can reuse parsed source cursors and the current reducer.
      // Backward scrubs still take the deterministic cold-seek path.
      if (activeSource === replaySource && Number.isFinite(status.cursorTs) &&
          target >= status.cursorTs) {
        // Cancel a scheduled/in-flight playback generation before reusing its
        // source cursors. Otherwise a timer tick and this seek can interleave
        // reads against the same mutable cursor.
        replaySource.pause();
        await replaySource.advanceTo(target, { emit: false });
      } else {
        await replaySource.seek(target);
      }
      if (operation !== replayOperation) return replayResult(false);
      replaySource.pause();
      activeSource = replaySource;
      streamEpoch++;
      sendReplayState();
      return replayResult(true);
    } finally {
      replayBoundaryOperations = Math.max(0, replayBoundaryOperations - 1);
    }
  }

  if (action === 'live') {
    replaySource.pause();
    if (activeSource !== tracker) {
      activeSource = tracker;
      streamEpoch++;
    }
    sendReplayState();
    return replayResult(true);
  }

  if (activeSource !== replaySource) {
    throw new Error(`${action} requires replay mode`);
  }
  if (action === 'play') replaySource.play();
  else if (action === 'pause') replaySource.pause();
  else replaySource.setSpeed(Number(command.speed));
  return replayResult(false);
}

function visibleProject(id) {
  const source = activeSource || tracker;
  if (source && source.projects instanceof Map) return source.projects.get(id) || null;
  const snapshot = source ? source.snapshot() : null;
  return snapshot && Array.isArray(snapshot.projects)
    ? snapshot.projects.find((project) => project.id === id) || null
    : null;
}

function validProjectId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 &&
    value.trim().length > 0 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function trustedMainFrame(event) {
  return isTrustedMainFrame(event, win, RENDERER_ENTRY_URL);
}

function liveProjectCwd(projectId) {
  if (!tracker || !(tracker.projects instanceof Map)) return null;
  const project = tracker.projects.get(projectId);
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

function terminalFailure(code) {
  const allowed = new Set(['INVALID', 'REPLAY', 'NOT_FOUND', 'UNAVAILABLE', 'BUSY', 'FAILED']);
  return { ok: false, code: allowed.has(code) ? code : 'FAILED' };
}

async function handleOpenTerminal(event, projectId) {
  if (!trustedMainFrame(event) || !validProjectId(projectId)) return terminalFailure('INVALID');
  if (activeSource !== tracker || replayBoundaryOperations > 0) return terminalFailure('REPLAY');
  if (terminalLaunchInFlight || Date.now() < terminalLaunchCooldownUntil) {
    return terminalFailure('BUSY');
  }
  if (process.platform !== 'win32' && process.platform !== 'darwin' && !CONTROL_TEST) {
    return terminalFailure('UNAVAILABLE');
  }
  const cwd = liveProjectCwd(projectId);
  if (!cwd) return terminalFailure('NOT_FOUND');
  if (!terminalLauncher || typeof terminalLauncher.open !== 'function') {
    return terminalFailure('UNAVAILABLE');
  }

  terminalLaunchInFlight = true;
  try {
    const outcome = await terminalLauncher.open({ cwd });
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

function handleTasksGet(event, projectId) {
  if (!trustedMainFrame(event) || !validProjectId(projectId)) return null;
  if (activeSource !== tracker || replayBoundaryOperations > 0) return null;
  const cwd = liveProjectCwd(projectId);
  if (!cwd) return null;
  try {
    const result = readGoalsFile(cwd);
    if (taskRuns) taskRuns.reconcile(projectId, result.items);
    const items = taskRuns ? taskRuns.decorate(projectId, result.items) : result.items;
    return { exists: result.exists, path: result.path, items };
  } catch {
    return null;
  }
}

function handleTasksSave(event, projectId, items) {
  if (!trustedMainFrame(event) || !validProjectId(projectId)) {
    return { ok: false, items: [] };
  }
  if (activeSource !== tracker || replayBoundaryOperations > 0) {
    return { ok: false, items: [] };
  }
  const cwd = liveProjectCwd(projectId);
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
      activeSource !== tracker || replayBoundaryOperations > 0) {
    return { ok: false, items: [] };
  }
  const cwd = liveProjectCwd(projectId);
  if (!cwd) return { ok: false, items: [] };
  try {
    return taskMutationResult(projectId, appendGoal(cwd, text), true);
  } catch {
    return { ok: false, items: [] };
  }
}

function handleTaskSetDone(event, projectId, request) {
  if (!trustedMainFrame(event) || !validProjectId(projectId) ||
      activeSource !== tracker || replayBoundaryOperations > 0) {
    return { ok: false, items: [] };
  }
  const cwd = liveProjectCwd(projectId);
  if (!cwd) return { ok: false, items: [] };
  try {
    return taskMutationResult(projectId, setGoalDone(cwd, request), true);
  } catch {
    return { ok: false, items: [] };
  }
}

function handleTaskRemove(event, projectId, request) {
  if (!trustedMainFrame(event) || !validProjectId(projectId) ||
      activeSource !== tracker || replayBoundaryOperations > 0) {
    return { ok: false, items: [] };
  }
  const cwd = liveProjectCwd(projectId);
  if (!cwd) return { ok: false, items: [] };
  try {
    return taskMutationResult(projectId, removeGoal(cwd, request), true);
  } catch {
    return { ok: false, items: [] };
  }
}

function taskMutationResult(projectId, result, ok) {
  const items = result && Array.isArray(result.items) ? result.items : [];
  if (ok && taskRuns) taskRuns.reconcile(projectId, items);
  return {
    ok: Boolean(ok),
    items: taskRuns ? taskRuns.decorate(projectId, items) : items,
  };
}

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
  if (!tracker || activeSource !== tracker || replayBoundaryOperations > 0) {
    return rootTaskFailure('REPLAY');
  }
  if (!rootTaskCoordinator) return rootTaskFailure('FAILED');
  return null;
}

function handleRootTasksGet(event) {
  if (!trustedMainFrame(event) || !rootTaskCoordinator) return { items: [] };
  try {
    return rootTaskCoordinator.snapshot();
  } catch {
    return { items: [] };
  }
}

function handleRootTaskCreate(event, text) {
  const denied = rootTaskMutationDenied(event);
  if (denied) return denied;
  try {
    return rootTaskCoordinator.create(text);
  } catch {
    return rootTaskFailure('FAILED');
  }
}

function handleRootTaskRemove(event, taskId) {
  const denied = rootTaskMutationDenied(event);
  if (denied) return denied;
  try {
    return rootTaskCoordinator.remove(taskId);
  } catch {
    return rootTaskFailure('FAILED');
  }
}

async function handleRootTaskAssign(event, taskId, projectId) {
  const denied = rootTaskMutationDenied(event);
  if (denied) return denied;
  try {
    return await rootTaskCoordinator.assign(taskId, projectId);
  } catch {
    return rootTaskFailure('FAILED');
  }
}

async function handleRootTaskRetry(event, taskId) {
  const denied = rootTaskMutationDenied(event);
  if (denied) return denied;
  try {
    return await rootTaskCoordinator.retry(taskId);
  } catch {
    return rootTaskFailure('FAILED');
  }
}

function sendRootTasksChanged(value, reason = null) {
  if (!win || win.isDestroyed() || !value || typeof value.id !== 'string') return;
  win.webContents.send('au:root-tasks-changed', {
    taskId: value.id,
    phase: reason === 'removed' ? null : (typeof value.phase === 'string' ? value.phase : null),
  });
}

function liveProjectShips(projectId) {
  if (!validProjectId(projectId) || !tracker || !(tracker.ships instanceof Map)) return [];
  return [...tracker.ships.values()].filter((ship) => ship && ship.project === projectId);
}

function projectPathFailure(code) {
  const allowed = new Set([
    'INVALID', 'REPLAY', 'BUSY', 'NOT_FOUND', 'NOT_MISSING',
    'IN_USE', 'EXPIRED', 'FAILED',
  ]);
  return { ok: false, code: allowed.has(code) ? code : 'FAILED' };
}

function projectPathRequestAllowed(event) {
  if (!trustedMainFrame(event)) return projectPathFailure('INVALID');
  if (!tracker || activeSource !== tracker || replayBoundaryOperations > 0) {
    return projectPathFailure('REPLAY');
  }
  return null;
}

function missingLiveProject(projectId) {
  if (!validProjectId(projectId) || !tracker || !(tracker.projects instanceof Map)) return null;
  const project = tracker.projects.get(projectId);
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
  if (!tracker || !(tracker.projects instanceof Map)) return [];
  return [...tracker.projects.values()]
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
    const selection = await dialog.showOpenDialog(win, {
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
  if (!tracker.projects.has(projectId)) return projectPathFailure('NOT_FOUND');
  const project = missingLiveProject(projectId);
  if (!project) return projectPathFailure('NOT_MISSING');
  if (projectPathDialogInFlight) return projectPathFailure('BUSY');

  projectPathDialogInFlight = true;
  try {
    const selection = await dialog.showOpenDialog(win, {
      title: `Locate ${project.name || 'project'}`,
      buttonLabel: 'Use this folder',
      defaultPath: nearestExistingDirectory(project.path),
      properties: ['openDirectory'],
    });
    if (selection.canceled || !selection.filePaths[0]) return { ok: true, canceled: true };
    const afterSelectionDenied = projectPathRequestAllowed(event);
    if (afterSelectionDenied) return afterSelectionDenied;
    if (!tracker.projects.has(projectId)) return projectPathFailure('NOT_FOUND');
    if (!missingLiveProject(projectId)) return projectPathFailure('NOT_MISSING');
    const recovered = tracker.remapProjectPath(projectId, selection.filePaths[0]);
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
  if (!tracker.projects.has(projectId)) return projectPathFailure('NOT_FOUND');
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
    const project = tracker.remapProjectPath(projectId, realCandidate);
    revokeProjectPathCandidates(projectId);
    return { ok: true, canceled: false, project };
  } catch (error) {
    return pathRecoveryError(error);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: PROVIDER_TEST || HISTORY_TEST || CONTROL_TEST ? 1200 : 1680,
    height: PROVIDER_TEST || HISTORY_TEST || CONTROL_TEST ? 720 : 980,
    minWidth: 1200,
    minHeight: 720,
    backgroundColor: '#04050a',
    autoHideMenuBar: true,
    title: 'Agent Universe',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Visual runners can execute from an occluded desktop session. Keep
      // their render loop alive so debug-ready can observe a completed frame.
      backgroundThrottling: !TEST_MODE,
    },
  });
  hardenWebContents(win.webContents, RENDERER_ENTRY_URL);

  if (TEST_MODE) {
    // Register load diagnostics before navigation starts. A warm renderer can
    // finish loading while the synchronous tracker setup below is still
    // running; attaching these after loadFile() can miss did-finish-load and
    // leave the visual harness waiting forever.
    win.webContents.on('console-message', (...args) => {
      const d = args.find((a) => a && typeof a === 'object' && 'message' in a);
      const msg = d ? `${d.level ?? ''} ${d.message}` : `${args[1] ?? ''} ${args[2] ?? ''}`;
      console.log(`[renderer] ${msg}`);
      if (/Uncaught|ReferenceError|TypeError|SyntaxError|is not defined|Failed to load resource|boot-failure/i.test(msg)) {
        rendererTestErrors.push(msg);
      }
    });
    win.webContents.once('did-finish-load', () => {
      if (CONTROL_TEST) control.run(ctx, driver, metrics);
      else if (HISTORY_TEST) history.run(ctx, driver, metrics);
      else if (PROVIDER_TEST) provider.run(ctx, driver, metrics);
      else if (POLISH_TEST) polish.run(ctx, driver, metrics);
      else shots.run(ctx, driver, metrics);
    });
    win.webContents.on('did-fail-load', (e, code, desc) => {
      console.error(`did-fail-load: ${code} ${desc}`);
      app.exit(1);
    });
  }
  win.loadFile(RENDERER_ENTRY_PATH);

  const providerFixture = PROVIDER_TEST ? createProviderFixture() : null;
  controlFixture = CONTROL_TEST ? createControlFixture() : null;
  historyFixture = CONTROL_TEST ? controlFixture : (HISTORY_TEST ? createHistoryFixture() : null);
  if (providerFixture) providerFixtureRoot = providerFixture.root;
  if (historyFixture) historyFixtureRoot = historyFixture.root;
  const fixture = historyFixture || providerFixture;
  const trackerOptions = historyFixture ? historyFixture.trackerOptions : providerFixture?.options;
  tracker = fixture
    ? new Tracker(fixture.statePath, trackerOptions)
    : new Tracker(path.join(app.getPath('userData'), 'universe-state.json'));
  const projectVcsStatusService = createProjectVcsStatusService({
    collector: createLocalGitStatusCollector(),
    githubProvider: createGitHubMetadataProvider(),
    onChange: sendProjectVcsStatusChanged,
  });
  projectVcsStatusController = createProjectVcsStatusController({
    tracker,
    service: projectVcsStatusService,
    onError(error) {
      console.warn(`[git] project status refresh failed: ${error && error.message ? error.message : error}`);
    },
  });
  const workflowStateDirectory = fixture
    ? path.dirname(fixture.statePath)
    : app.getPath('userData');
  const taskRunStatePath = path.join(workflowStateDirectory, 'task-runs.json');
  rootTasks = new RootTaskStore(path.join(workflowStateDirectory, 'root-tasks.json'));
  taskRuns = new TaskRunTracker({
    statePath: taskRunStatePath,
    resolveProjectRoot: liveProjectCwd,
    onChange: ({ run }) => {
      if (!run) return;
      let rootObserved = false;
      if (rootTaskCoordinator) {
        try { rootObserved = rootTaskCoordinator.observeRun(run).ok === true; } catch {
          rootObserved = false;
        }
      }
      if (!rootObserved) sendRootTasksChanged(run);
      if (win && !win.isDestroyed()) {
        win.webContents.send('au:tasks-changed', {
          projectId: run.projectId,
          taskId: run.id,
          phase: run.phase,
        });
      }
    },
  });
  rootTaskCoordinator = new RootTaskCoordinator({
    store: rootTasks,
    taskRuns,
    launcher: createAgentLauncher(),
    resolveProjectRoot: liveProjectCwd,
    listShips: liveProjectShips,
    onChange: ({ reason, item }) => sendRootTasksChanged(item, reason),
  });
  for (const item of rootTasks.list()) {
    const run = taskRuns.get(item.id);
    if (run) rootTaskCoordinator.observeRun(run);
  }
  taskRunSweepTimer = setInterval(() => {
    if (!taskRuns) return;
    try { taskRuns.expire(); } catch (error) {
      console.warn(`[tasks] stale-run cleanup failed: ${error && error.message ? error.message : error}`);
    }
  }, 30_000);
  if (typeof taskRunSweepTimer.unref === 'function') taskRunSweepTimer.unref();
  const replayOptions = historyFixture
    ? historyFixture.replayOptions
    : providerFixture
      ? {
          claudeProjectsDir: providerFixture.options.claudeProjectsDir,
          codexSessionDirs: [providerFixture.options.codexSessionsDir],
        }
      : {};
  replaySource = new ReplaySource(replayOptions);
  terminalLauncher = CONTROL_TEST
    ? createRecordingTerminalLauncher(controlFixture)
    : createTerminalLauncher();
  terminalLaunchInFlight = false;
  terminalLaunchCooldownUntil = 0;
  activeSource = tracker;
  tracker.on('events', (batch) => {
    if (projectVcsStatusController) projectVcsStatusController.observeEvents(batch);
    for (const event of Array.isArray(batch) ? batch : []) {
      if (event.type === 'project-updated' && event.project && event.project.exists === true) {
        revokeProjectPathCandidates(event.project.id);
      }
    }
    if (taskRuns) {
      try { taskRuns.observe(batch); } catch (error) {
        console.warn(`[tasks] completion tracking failed: ${error && error.message ? error.message : error}`);
      }
    }
    if (activeSource === tracker && win && !win.isDestroyed()) {
      win.webContents.send('au:events', batch, { streamEpoch, mode: 'live' });
    }
  });
  replaySource.on('events', (batch) => {
    if (activeSource === replaySource && win && !win.isDestroyed()) {
      win.webContents.send('au:events', batch, { streamEpoch, mode: 'replay' });
    }
  });
  replaySource.on('state', sendReplayState);
  tracker.start();
  projectVcsStatusController.start();
  win.on('focus', () => {
    if (projectVcsStatusController) projectVcsStatusController.refreshAll();
  });
  if (HISTORY_TEST || CONTROL_TEST || !TEST_MODE) {
    ensureReplayIndex(false).catch((error) => {
      console.warn(`[history] index unavailable: ${error && error.message ? error.message : error}`);
    });
  }
  if (PROVIDER_TEST) {
    const claudeShip = [...tracker.ships.values()].find((ship) => ship.provider === 'claude');
    if (claudeShip) {
      claudeShip.attention = 'question';
      claudeShip.attentionSince = Date.now();
      // Keep the rendered provider fixture in the same state after the five-second
      // tracker sweep. A direct attention assignment alone is intentionally
      // transient and made this gate depend on renderer startup speed.
      claudeShip.pending.set('provider-test-question', {
        tool: 'AskUserQuestion',
        ts: Date.now() - 3_000,
      });
    }
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
  return (activeSource || tracker).getPlanet(id, name);
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
    openedProjects.push(id);
    return '';
  }
  // Security: only open local directories; a UNC path would force an SMB round-trip.
  if (p && p.exists && isLocalProjectPath(p.path)) return shell.openPath(p.path);
  return '';
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
app.on('before-quit', cleanupForExit);

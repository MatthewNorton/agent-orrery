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

const SHOT_MODE = process.argv.includes('--shots');
const POLISH_TEST = process.argv.includes('--polish-test');
const PROVIDER_TEST = process.argv.includes('--provider-test');
const HISTORY_TEST = process.argv.includes('--history-test');
const CONTROL_TEST = process.argv.includes('--control-test');
const TEST_MODE = SHOT_MODE || POLISH_TEST || PROVIDER_TEST || HISTORY_TEST || CONTROL_TEST;
const RENDERER_ENTRY_PATH = path.join(__dirname, '..', 'renderer', 'index.html');
const RENDERER_ENTRY_URL = rendererUrl(RENDERER_ENTRY_PATH);
const polishOutputArg = process.argv.find((arg) => arg.startsWith('--polish-output='));
const POLISH_OUTPUT = polishOutputArg
  ? path.resolve(polishOutputArg.slice('--polish-output='.length))
  : path.join(__dirname, '..', '..', '.shots', 'polish');
const providerOutputArg = process.argv.find((arg) => arg.startsWith('--provider-output='));
const PROVIDER_OUTPUT = providerOutputArg
  ? path.resolve(providerOutputArg.slice('--provider-output='.length))
  : path.join(__dirname, '..', '..', '.shots', 'providers');
const historyOutputArg = process.argv.find((arg) => arg.startsWith('--history-output='));
const HISTORY_OUTPUT = historyOutputArg
  ? path.resolve(historyOutputArg.slice('--history-output='.length))
  : path.join(__dirname, '..', '..', '.shots', 'history');
const controlOutputArg = process.argv.find((arg) => arg.startsWith('--control-output='));
const CONTROL_OUTPUT = controlOutputArg
  ? path.resolve(controlOutputArg.slice('--control-output='.length))
  : path.join(__dirname, '..', '..', '.shots', 'control');
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
let controlTerminalUnrefs = 0;
const controlTerminalCalls = [];
const rendererTestErrors = [];
const openedProjects = [];
const pointerInputEvents = [];

function createProviderFixture() {
  providerFixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-universe-provider-render-'));
  const projectDir = path.join(providerFixtureRoot, 'workspace', 'provider-fixture');
  const claudeRoot = path.join(providerFixtureRoot, '.claude', 'projects');
  const codexRoot = path.join(providerFixtureRoot, '.codex', 'sessions');
  const signalRoot = path.join(providerFixtureRoot, 'signal-logs');
  const statePath = path.join(providerFixtureRoot, 'state', 'universe-state.json');
  const configPath = path.join(providerFixtureRoot, 'state', 'providers.json');
  fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'src', 'fixture.js'), '/* provider fixture */\n');

  const claudeDir = path.join(claudeRoot, 'fixture-provider-project');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'claude-render.jsonl'), JSON.stringify({
    type: 'user', timestamp: new Date().toISOString(), cwd: projectDir,
    message: { role: 'user', content: 'fixture' },
  }) + '\n');

  const codexId = '019f0000-0000-7000-8000-000000000005';
  const codexDir = path.join(codexRoot, '2026', '07', '21');
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, `rollout-2026-07-21T00-00-00-${codexId}.jsonl`),
    JSON.stringify({
      timestamp: new Date().toISOString(), type: 'session_meta',
      payload: { id: codexId, session_id: codexId, cwd: projectDir, source: 'cli' },
    }) + '\n'
  );

  fs.mkdirSync(signalRoot, { recursive: true });
  fs.writeFileSync(path.join(signalRoot, 'builder.log'), 'fixture\n');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    watch: [{ directory: signalRoot, projectPath: projectDir, label: 'Fixture' }],
  }));
  return {
    statePath,
    options: { claudeProjectsDir: claudeRoot, codexSessionsDir: codexRoot, providerConfigPath: configPath },
  };
}

function historyLine(value) {
  return `${JSON.stringify(value)}\n`;
}

function createHistoryFixture() {
  historyFixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-universe-history-render-'));
  const projectDir = path.join(historyFixtureRoot, 'workspace', 'history-fixture');
  const claudeRoot = path.join(historyFixtureRoot, '.claude', 'projects');
  const codexActive = path.join(historyFixtureRoot, '.codex', 'sessions');
  const codexArchive = path.join(historyFixtureRoot, '.codex', 'archived_sessions');
  const statePath = path.join(historyFixtureRoot, 'state', 'universe-state.json');
  const providerConfigPath = path.join(historyFixtureRoot, 'state', 'providers.json');
  const t0 = Date.now() - 12 * 60 * 1000;
  const iso = (offset) => new Date(t0 + offset).toISOString();

  fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'live'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'src', 'fixture.js'), '// history fixture\n');

  const claudeDir = path.join(claudeRoot, 'fixture-history-project');
  fs.mkdirSync(claudeDir, { recursive: true });
  const claudeFile = path.join(claudeDir, 'history-render.jsonl');
  fs.writeFileSync(claudeFile, [
    { type: 'user', timestamp: iso(0), cwd: projectDir,
      message: { role: 'user', content: 'private fixture prompt' } },
    { type: 'assistant', timestamp: iso(5_000), cwd: projectDir,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'history-read',
        name: 'Read', input: { file_path: path.join(projectDir, 'src', 'fixture.js') } }] } },
    { type: 'user', timestamp: iso(8_000), cwd: projectDir,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'history-read', content: 'private' }] } },
    { type: 'assistant', timestamp: iso(30_000), cwd: projectDir,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'history-edit',
        name: 'Edit', input: { file_path: path.join(projectDir, 'src', 'historical.js'), new_string: 'private' } }] } },
    { type: 'user', timestamp: iso(35_000), cwd: projectDir,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'history-edit', content: 'private' }] } },
    { type: 'system', subtype: 'turn_duration', timestamp: iso(600_000), cwd: projectDir },
  ].map(historyLine).join(''));

  const codexId = '019f0000-0000-7000-8000-000000000106';
  const codexDay = path.join(codexActive, '2026', '07', '21');
  fs.mkdirSync(codexDay, { recursive: true });
  fs.mkdirSync(codexArchive, { recursive: true });
  fs.writeFileSync(path.join(codexDay, `rollout-history-${codexId}.jsonl`), [
    { timestamp: iso(2_000), type: 'session_meta', payload: {
      id: codexId, session_id: codexId, cwd: projectDir, thread_source: 'user',
      base_instructions: 'private fixture instructions' } },
    { timestamp: iso(12_000), type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: iso(40_000), type: 'response_item', payload: {
      type: 'custom_tool_call', call_id: 'history-patch', name: 'apply_patch', input: 'private' } },
    { timestamp: iso(45_000), type: 'event_msg', payload: {
      type: 'patch_apply_end', call_id: 'history-patch', success: true,
      changes: { [path.join(projectDir, 'docs', 'history.md')]: { type: 'add', content: 'private' } } } },
    { timestamp: iso(50_000), type: 'event_msg', payload: {
      type: 'task_complete', last_agent_message: 'private' } },
  ].map(historyLine).join(''));

  return {
    projectDir,
    claudeFile,
    claudeRoot,
    t0,
    earlyTs: t0 + 10_000,
    lateTs: t0 + 60_000,
    forwardTs: t0 + 300_000,
    statePath,
    trackerOptions: {
      claudeProjectsDir: claudeRoot,
      codexSessionDirs: [codexActive, codexArchive],
      providerConfigPath,
    },
    replayOptions: {
      claudeProjectsDir: claudeRoot,
      codexSessionDirs: [codexActive, codexArchive],
    },
  };
}

function createControlFixture() {
  const fixture = createHistoryFixture();
  fixture.localAppData = path.win32.join(historyFixtureRoot, 'Local App Data & (Orbit)');
  return fixture;
}

function createRecordingTerminalLauncher(fixture) {
  controlTerminalCalls.length = 0;
  controlTerminalUnrefs = 0;
  const fakeFs = {
    constants: { F_OK: fs.constants.F_OK },
    accessSync() { /* fixed app alias is deliberately intercepted */ },
  };
  const launcher = createTerminalLauncher({
    platform: 'win32',
    env: { LOCALAPPDATA: fixture.localAppData },
    fsImpl: fakeFs,
    spawnImpl(command, args, options) {
      controlTerminalCalls.push({
        command,
        args: Array.isArray(args) ? args.slice() : args,
        options: options && typeof options === 'object' ? { ...options } : options,
      });
      return {
        once() { return this; },
        unref() { controlTerminalUnrefs++; },
      };
    },
  });
  let delayFirstOpen = true;
  return Object.freeze({
    async open(request) {
      if (delayFirstOpen) {
        delayFirstOpen = false;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return launcher.open(request);
    },
  });
}

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
      if (CONTROL_TEST) runControlMode();
      else if (HISTORY_TEST) runHistoryMode();
      else if (PROVIDER_TEST) runProviderMode();
      else if (POLISH_TEST) runPolishMode();
      else runShotMode();
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

// --shots: cycle the three views, capture each to .shots/, then exit.
// Used for automated visual verification.
async function runShotMode() {
  const outDir = path.join(__dirname, '..', '..', '.shots');
  fs.mkdirSync(outDir, { recursive: true });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(4000);
  for (const view of ['universe', 'system', 'planet']) {
    const ready = new Promise((resolve) => ipcMain.once('au:debug-ready', resolve));
    win.webContents.send('au:debug-view', view);
    await ready;
    await wait(1800);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, `shot-${view}.png`), img.toPNG());
    console.log(`captured ${view}`);
    if (view === 'system') {
      const asteroidPreview = await rendererEval(`(() => {
        const scene = BABYLON.EngineStore.LastCreatedScene;
        const camera = scene && scene.activeCamera;
        if (!scene || !camera || !window.AUR) return false;
        for (const mesh of scene.meshes) mesh.setEnabled(false);
        const asteroid = AUR.createAsteroidMesh(scene, 'asteroid-visual-proof', 0xa57e10d, 1);
        const material = new BABYLON.StandardMaterial('asteroid-visual-proof-material', scene);
        AUR.applyAsteroidSurface(scene, material, 1);
        asteroid.material = material;
        asteroid.rotation.set(0.34, -0.62, 0.18);
        asteroid.setEnabled(true);
        const proofLight = new BABYLON.DirectionalLight(
          'asteroid-visual-proof-light', new BABYLON.Vector3(0.6, -0.45, 0.8), scene);
        proofLight.intensity = 2.4;
        camera.setTarget(BABYLON.Vector3.Zero());
        camera.lowerRadiusLimit = 1.8;
        camera.radius = 2.65;
        return true;
      })()`);
      if (asteroidPreview) {
        await wait(650);
        const asteroidImage = await win.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, 'shot-asteroid.png'), asteroidImage.toPNG());
        console.log('captured asteroid close-up');
      }
    }
  }

  const directoryReady = new Promise((resolve) => ipcMain.once('au:debug-ready', resolve));
  win.webContents.send('au:debug-view', 'universe');
  await directoryReady;
  await wait(500);
  await screenshotClick('#command-rail-toggle');
  await wait(200);
  const compactRailState = await rendererEval(`(() => {
    const rail = document.getElementById('sidebar');
    return {
      compact: Boolean(rail && rail.classList.contains('compact')),
      compactButtons: document.querySelectorAll('.compact-rail-button').length,
    };
  })()`);
  await wait(350);
  const compactRailImage = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, 'shot-command-rail-compact.png'), compactRailImage.toPNG());
  console.log('captured command rail compact');
  const railStillCompact = await rendererEval(`(() => {
    const rail = document.getElementById('sidebar');
    return Boolean(rail && rail.classList.contains('compact'));
  })()`);
  if (railStillCompact) await screenshotClick('#command-rail-toggle');
  await wait(350);

  await screenshotClick('#project-directory-button');
  await wait(200);
  const directoryState = await rendererEval(`(() => {
    const panel = document.getElementById('project-directory');
    return {
      open: Boolean(panel && !panel.classList.contains('hidden')),
      projectCount: document.querySelectorAll('.project-directory-row').length,
      selectedCount: document.querySelectorAll('.project-directory-row.selected').length,
    };
  })()`);
  await wait(350);
  const directoryImage = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, 'shot-projects.png'), directoryImage.toPNG());
  console.log('captured projects');
  await rendererEval(`(() => {
    const input = document.getElementById('project-directory-input');
    if (!input) return;
    input.value = 'agent-universe';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await wait(250);
  const directorySearchState = await rendererEval(`(() => ({
    query: document.getElementById('project-directory-input')?.value || '',
    resultCount: document.querySelectorAll('.project-directory-row').length,
    resultNames: Array.from(document.querySelectorAll('.project-directory-name'))
      .map((element) => element.textContent),
  }))()`);
  await screenshotClick('#project-directory-close');
  fs.writeFileSync(
    path.join(outDir, 'ux-state.json'),
    JSON.stringify({
      directory: directoryState,
      directorySearch: directorySearchState,
      commandRail: compactRailState,
    }, null, 2)
  );
  fs.writeFileSync(path.join(outDir, 'state.json'), JSON.stringify(tracker.snapshot(), null, 2));
  app.quit();
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function rendererEval(source) {
  return win.webContents.executeJavaScript(source, true);
}

async function readViewState() {
  return rendererEval(`(() => {
    const scene = BABYLON.EngineStore.LastCreatedScene;
    const camera = scene && scene.activeCamera;
    const cameraName = camera ? camera.name : null;
    const byCamera = { ucam: 'universe', scam: 'system', pcam: 'planet' };
    const shown = (id) => {
      const el = document.getElementById(id);
      return Boolean(el && !el.classList.contains('hidden') && getComputedStyle(el).display !== 'none');
    };
    const engines = BABYLON.EngineStore.Instances || [];
    let liveScenes = 0;
    for (const engine of engines) {
      for (const item of engine.scenes || []) if (!item.isDisposed) liveScenes++;
    }
    return {
      view: (scene && scene.metadata && scene.metadata.view) || byCamera[cameraName] || null,
      camera: cameraName,
      summary: document.querySelector('#summary-card .summary-title')?.textContent || '',
      projectCard: document.getElementById('project-card')?.textContent || '',
      planetCard: document.getElementById('planet-card')?.textContent || '',
      backText: document.getElementById('back-btn')?.textContent || '',
      backVisible: shown('back-btn'),
      tabbarVisible: shown('tabbar'),
      liveScenes,
    };
  })()`);
}

async function waitForView(expected, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < until) {
    try { last = await readViewState(); } catch { /* renderer is still booting */ }
    if (last && last.view === expected && last.liveScenes === 1) return last;
    await wait(100);
  }
  throw new Error(`timed out waiting for ${expected}; last=${JSON.stringify(last)}`);
}

async function readPolishStats() {
  return rendererEval(`(() => {
    const scene = BABYLON.EngineStore.LastCreatedScene;
    if (!scene || !scene.metadata || typeof scene.metadata.polishStats !== 'function') return null;
    return scene.metadata.polishStats();
  })()`);
}

async function findCanvasTarget(kind, preferHidden, requiredId) {
  return rendererEval(`(() => {
    const kind = ${JSON.stringify(kind)};
    const preferHidden = ${preferHidden ? 'true' : 'false'};
    const requiredId = ${JSON.stringify(requiredId || null)};
    const scene = BABYLON.EngineStore.LastCreatedScene;
    if (!scene || !scene.activeCamera) return null;
    const engine = scene.getEngine();
    const canvas = engine.getRenderingCanvas();
    const rect = canvas.getBoundingClientRect();
    const viewport = scene.activeCamera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight());
    const stats = scene.metadata && typeof scene.metadata.polishStats === 'function'
      ? scene.metadata.polishStats() : null;
    const labelById = new Map(((stats && stats.labels) || []).map((item) => [item.id, item]));
    const matches = scene.meshes.filter((mesh) => mesh.metadata &&
      (kind === 'sun' ? mesh.metadata.isSun : mesh.metadata.isPlanet));
    const choices = [];
    for (const mesh of matches) {
      mesh.computeWorldMatrix(true);
      const center = mesh.getBoundingInfo().boundingSphere.centerWorld;
      const p = BABYLON.Vector3.Project(center, BABYLON.Matrix.IdentityReadOnly,
        scene.getTransformMatrix(), viewport);
      const x = Math.round(rect.left + p.x * rect.width / engine.getRenderWidth());
      const y = Math.round(rect.top + p.y * rect.height / engine.getRenderHeight());
      if (p.z < 0 || p.z > 1 || x < rect.left || y < rect.top || x >= rect.right || y >= rect.bottom) continue;
      if (document.elementFromPoint(x, y) !== canvas) continue;
      const id = kind === 'sun' ? mesh.metadata.projectId : mesh.metadata.planetName;
      if (requiredId != null && id !== requiredId) continue;
      const label = labelById.get(id);
      choices.push({
        id, meshName: mesh.name, x, y,
        available: kind !== 'sun' || mesh.metadata.projectExists !== false,
        hiddenLabel: Boolean(label && !label.visible),
        centerDistance: Math.hypot(x - rect.width * 0.52, y - rect.height * 0.48),
      });
    }
    choices.sort((a, b) => {
      if (a.available !== b.available) return a.available ? -1 : 1;
      if (preferHidden && a.hiddenLabel !== b.hiddenLabel) return a.hiddenLabel ? -1 : 1;
      return a.centerDistance - b.centerDistance || String(a.id).localeCompare(String(b.id));
    });
    return choices[0] || null;
  })()`);
}

async function validatePointerPick(target, kind) {
  sendTestInput({ type: 'mouseMove', x: target.x, y: target.y });
  await wait(90);
  return rendererEval(`(() => {
    const scene = BABYLON.EngineStore.LastCreatedScene;
    // Match the production POINTERPICK path exactly: no predicate may see
    // through an occluding pickable mesh.
    const pick = scene && scene.pick(scene.pointerX, scene.pointerY);
    if (!pick || !pick.hit || !pick.pickedMesh) return null;
    const metadata = pick.pickedMesh.metadata;
    if (!metadata || !(${JSON.stringify(kind)} === 'sun' ? metadata.isSun : metadata.isPlanet)) return null;
    return {
      meshName: pick.pickedMesh.name,
      id: ${JSON.stringify(kind)} === 'sun' ? metadata.projectId : metadata.planetName,
    };
  })()`);
}

async function acquirePointerTarget(kind, preferHidden, requiredId) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const target = await findCanvasTarget(kind, preferHidden, requiredId);
    if (target) {
      const picked = await validatePointerPick(target, kind);
      if (picked && picked.id === target.id) return { ...target, picked };
    }
    await wait(80);
  }
  throw new Error(`could not validate a ${kind} pointer target`);
}

function sendTestInput(event) {
  if (!POLISH_TEST && !HISTORY_TEST && !CONTROL_TEST) {
    throw new Error('test input attempted outside an input test mode');
  }
  pointerInputEvents.push({
    type: event.type,
    x: event.x,
    y: event.y,
    button: event.button || null,
    clickCount: event.clickCount || null,
    deltaX: event.deltaX || null,
    deltaY: event.deltaY || null,
  });
  win.webContents.sendInputEvent(event);
}

function clickPoint(point) {
  const start = pointerInputEvents.length;
  sendTestInput({ type: 'mouseMove', x: point.x, y: point.y });
  sendTestInput({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  sendTestInput({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  return { start, end: pointerInputEvents.length, x: point.x, y: point.y };
}

// Screenshot-capture path: real input events, but outside the proof-recording
// test modes, so it must not go through sendTestInput (which throws there).
async function screenshotClick(selector) {
  const point = await elementCenter(selector);
  if (!point) return false;
  win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
  win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  return true;
}

async function elementCenter(selector) {
  return rendererEval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el || getComputedStyle(el).display === 'none') return null;
    const rect = el.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), text: el.textContent };
  })()`);
}

async function capture(outDir, name) {
  await wait(350);
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, `${name}.png`), image.toPNG());
  return image;
}

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function backdropLuma(image) {
  const size = image.getSize();
  const bitmap = image.toBitmap();
  const values = [];
  const x0 = Math.floor(size.width * 0.22);
  const x1 = Math.floor(size.width * 0.72);
  const y0 = Math.floor(size.height * 0.09);
  const y1 = Math.floor(size.height * 0.82);
  for (let y = y0; y < y1; y += 5) {
    for (let x = x0; x < x1; x += 5) {
      const offset = (y * size.width + x) * 4;
      const b = bitmap[offset];
      const g = bitmap[offset + 1];
      const r = bitmap[offset + 2];
      values.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
    }
  }
  values.sort((a, b) => a - b);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const round = (value) => Math.round(value * 10) / 10;
  return {
    mean: round(mean), median: round(percentile(values, 0.5)),
    p90: round(percentile(values, 0.9)), p99: round(percentile(values, 0.99)),
    stddev: round(Math.sqrt(variance)), samples: values.length,
  };
}

async function exerciseCamera() {
  const point = await rendererEval(`(() => {
    const canvas = document.getElementById('renderCanvas');
    const rect = canvas.getBoundingClientRect();
    const options = [[0.42, 0.2], [0.5, 0.18], [0.36, 0.28]];
    for (const [fx, fy] of options) {
      const x = Math.round(rect.left + rect.width * fx);
      const y = Math.round(rect.top + rect.height * fy);
      if (document.elementFromPoint(x, y) === canvas) return { x, y };
    }
    return null;
  })()`);
  if (!point) throw new Error('no clear canvas point for camera input');
  sendTestInput({ type: 'mouseMove', x: point.x, y: point.y });
  sendTestInput({ type: 'mouseWheel', x: point.x, y: point.y, deltaY: 120, deltaX: 0, canScroll: true });
  sendTestInput({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  sendTestInput({ type: 'mouseMove', x: point.x + 70, y: point.y + 24, movementX: 70, movementY: 24 });
  sendTestInput({ type: 'mouseUp', x: point.x + 70, y: point.y + 24, button: 'left', clickCount: 1 });
  await wait(900);
}

async function readHistoryMetrics() {
  return rendererEval(`(() => typeof AUR.historyTestMetrics === 'function'
    ? AUR.historyTestMetrics() : null)()`);
}

async function waitForHistory(predicate, label, timeoutMs = 12_000) {
  const until = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < until) {
    try { last = await readHistoryMetrics(); } catch { /* renderer transition */ }
    if (last && predicate(last)) return last;
    await wait(25);
  }
  throw new Error(`timed out waiting for ${label}; last=${JSON.stringify(last)}`);
}

async function clickHistoryControl(selector) {
  const point = await elementCenter(selector);
  if (!point) throw new Error(`history control unavailable: ${selector}`);
  clickPoint(point);
  return point;
}

async function historyScrubberPoint(timestamp) {
  return rendererEval(`(() => {
    const el = document.getElementById('history-scrubber');
    if (!el || el.disabled) return null;
    const rect = el.getBoundingClientRect();
    const min = Number(el.dataset.minTs), max = Number(el.dataset.maxTs);
    const ts = ${JSON.stringify(timestamp)};
    const ratio = max > min ? Math.max(0, Math.min(1, (ts - min) / (max - min))) : 0;
    return {
      x: Math.round(rect.left + 8 + ratio * Math.max(1, rect.width - 16)),
      y: Math.round(rect.top + rect.height / 2), min, max,
    };
  })()`);
}

async function scrubHistory(timestamp) {
  const target = await historyScrubberPoint(timestamp);
  if (!target) throw new Error('history scrubber was disabled');
  clickPoint(target);
  return target;
}

async function dragHistory(fromTimestamp, toTimestamp, moveCount = 80) {
  return rendererEval(`new Promise((resolve, reject) => {
    const el = document.getElementById('history-scrubber');
    if (!el || el.disabled) { reject(new Error('history scrubber was disabled')); return; }
    const minTs = Number(el.dataset.minTs), maxTs = Number(el.dataset.maxTs);
    const sliderMin = Number(el.min), sliderMax = Number(el.max);
    const position = (ts) => sliderMin + Math.max(0, Math.min(1,
      (ts - minTs) / Math.max(1, maxTs - minTs))) * (sliderMax - sliderMin);
    const start = position(${JSON.stringify(fromTimestamp)});
    const end = position(${JSON.stringify(toTimestamp)});
    const count = ${JSON.stringify(moveCount)};
    let index = 0;
    const frame = () => {
      // Several pointer samples can arrive inside one display frame. Dispatch
      // them in groups to prove the preview renderer coalesces that workload.
      for (let sample = 0; sample < 4 && index < count; sample++) {
        index++;
        el.value = String(start + (end - start) * (index / count));
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (index < count) requestAnimationFrame(frame);
      else {
        el.dispatchEvent(new Event('change', { bubbles: true }));
        resolve({ start, end, moveCount: count });
      }
    };
    requestAnimationFrame(frame);
  })`);
}

function snapshotBuilds(snapshot) {
  const project = snapshot && Array.isArray(snapshot.projects) ? snapshot.projects[0] : null;
  return {
    total: project ? project.totalBuilds || 0 : 0,
    buckets: project && project.buckets ? { ...project.buckets } : {},
  };
}

function liveTrackerBuilds() {
  const project = tracker && tracker.projects instanceof Map
    ? [...tracker.projects.values()][0]
    : null;
  return {
    total: project ? project.totalBuilds || 0 : 0,
    buckets: project && project.buckets ? { ...project.buckets } : {},
  };
}

async function readControlMetrics() {
  return rendererEval(`(() => {
    const button = document.getElementById('project-terminal');
    const status = document.getElementById('project-control-status');
    const card = document.getElementById('project-card');
    const scene = BABYLON.EngineStore.LastCreatedScene;
    const visible = (el) => Boolean(el && !el.classList.contains('hidden') &&
      getComputedStyle(el).display !== 'none');
    const bounds = (el) => {
      if (!visible(el)) return null;
      const rect = el.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
        width: rect.width, height: rect.height };
    };
    const intersects = (a, b) => Boolean(a && b && a.left < b.right && a.right > b.left &&
      a.top < b.bottom && a.bottom > b.top);
    const targetRects = [bounds(button), bounds(status)].filter(Boolean);
    const blockerIds = ['back-btn', 'sidebar', 'summary-card', 'planet-card', 'tabbar', 'history-bar'];
    const overlapIds = [];
    for (const id of blockerIds) {
      const blocker = bounds(document.getElementById(id));
      if (targetRects.some((target) => intersects(target, blocker))) overlapIds.push(id);
    }
    let clippedCount = 0;
    for (const rect of targetRects) {
      if (rect.width <= 0 || rect.height <= 0 || rect.left < 0 || rect.top < 0 ||
          rect.right > innerWidth || rect.bottom > innerHeight) clippedCount++;
    }
    const forbiddenText = card ? /(?:Launch|New)\\s+(?:Claude|Codex)|prompt|resume/i.test(card.textContent) : false;
    const forbiddenInputs = card ? card.querySelectorAll('select,textarea,input').length : 0;
    return {
      view: scene && scene.metadata ? scene.metadata.view : null,
      ids: ['project-terminal', 'project-control-status'].filter((id) => document.getElementById(id)),
      exactText: button ? button.textContent.trim() : null,
      disabled: button ? button.disabled : null,
      busy: button ? button.getAttribute('aria-busy') === 'true' : null,
      state: button ? button.dataset.state || '' : '',
      note: status ? status.textContent.trim() : null,
      terminalCount: document.querySelectorAll('#project-terminal').length,
      overlapIds,
      overlapCount: overlapIds.length,
      clippedCount,
      noProviderOrPromptControls: !forbiddenText && forbiddenInputs === 0,
    };
  })()`);
}

async function waitForControl(predicate, label, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < until) {
    try { last = await readControlMetrics(); } catch { /* renderer transition */ }
    if (last && predicate(last)) return last;
    await wait(30);
  }
  throw new Error(`timed out waiting for ${label}; last=${JSON.stringify(last)}`);
}

function safeRecordedTerminalCalls(cwd) {
  if (!controlFixture || controlTerminalCalls.length === 0) return false;
  const expectedCommand = path.win32.join(
    controlFixture.localAppData, 'Microsoft', 'WindowsApps', 'wt.exe'
  );
  const optionKeys = ['cwd', 'detached', 'shell', 'stdio', 'windowsHide'];
  return controlTerminalCalls.every((call) => call && call.command === expectedCommand &&
    Array.isArray(call.args) && call.args.length === 2 && call.args[0] === '-d' &&
    call.args[1] === cwd && call.options && call.options.cwd === cwd &&
    call.options.shell === false && call.options.detached === true &&
    call.options.stdio === 'ignore' && call.options.windowsHide === false &&
    Object.keys(call.options).sort().join('|') === optionKeys.sort().join('|'));
}

async function runControlMode() {
  fs.mkdirSync(CONTROL_OUTPUT, { recursive: true });
  const result = {
    schemaVersion: 1,
    passed: false,
    windowSize: { width: 1200, height: 720 },
    steps: [],
    controls: {},
    metrics: {},
    rendererErrors: rendererTestErrors,
  };
  try {
    if (!controlFixture) throw new Error('control fixture was not created');
    await waitForView('universe');
    await waitForHistory((value) => value.playback?.mode === 'live' &&
      value.playback.available && !value.playback.indexing, 'control history index');

    const project = [...tracker.projects.values()].find((item) =>
      item && item.exists && item.path === controlFixture.projectDir);
    if (!project) throw new Error('control project was not discovered');
    const canonicalCwd = path.normalize(fs.realpathSync.native(project.path));

    const systemTarget = await acquirePointerTarget('sun', false, project.id);
    clickPoint(systemTarget);
    await waitForView('system');
    const initialControl = await waitForControl((value) => value.view === 'system' &&
      value.terminalCount === 1 && value.exactText === 'Open Terminal' && value.disabled === false,
    'live system terminal action');
    const systemButton = await elementCenter('#project-terminal');
    if (!systemButton) throw new Error('live terminal action was not visible');
    clickPoint(systemButton);
    const pendingControl = await waitForControl((value) => value.state === 'pending' &&
      value.busy === true && value.disabled === true, 'pending terminal action');
    win.webContents.send('au:replay-state', {
      ...boundedReplayStatus('live'),
      streamEpoch,
    });
    const rerenderedPendingControl = await waitForControl((value) => value.state === 'pending' &&
      value.busy === true && value.disabled === true, 'pending action after card rerender');
    const pendingButton = await elementCenter('#project-terminal');
    if (!pendingButton) throw new Error('pending terminal action was not visible');
    clickPoint(pendingButton);
    await wait(50);
    const pendingLaunchCount = controlTerminalCalls.length;
    const launchedControl = await waitForControl((value) => controlTerminalCalls.length === 1 &&
      value.note === 'Terminal launch requested' && value.disabled === false,
    'first terminal launch');
    result.steps.push({ action: 'system-terminal', actualInput: true });
    result.metrics.initialLaunchCount = controlTerminalCalls.length;
    result.metrics.pendingRerenderPreserved = pendingControl.busy === true &&
      rerenderedPendingControl.busy === true && pendingLaunchCount === 0;
    await capture(CONTROL_OUTPUT, 'control-live');

    await scrubHistory(controlFixture.earlyTs);
    await waitForHistory((value) => value.playback?.mode === 'replay', 'control replay mode');
    await waitForView('system');
    const replayControl = await waitForControl((value) => value.view === 'system' &&
      value.disabled === true && value.state === 'replay' &&
      value.note === 'Return to LIVE to open a terminal.', 'disabled replay terminal action');
    const replayButton = await elementCenter('#project-terminal');
    if (!replayButton) throw new Error('replay terminal action was not rendered');
    clickPoint(replayButton);
    await wait(120);
    const replayCountAfterInput = controlTerminalCalls.length;
    const forged = await rendererEval(
      `AU.openTerminal(${JSON.stringify(project.id)})`
    );
    await wait(80);
    result.steps.push({ action: 'replay-blocked', actualInput: true });
    result.metrics.replayLaunchCount = controlTerminalCalls.length;
    result.metrics.replayMainRejected = Boolean(forged && forged.ok === false && forged.code === 'REPLAY');
    await capture(CONTROL_OUTPUT, 'control-replay');

    await clickHistoryControl('#history-live');
    await waitForHistory((value) => value.playback?.mode === 'live', 'control LIVE return');
    await waitForView('system');
    const liveControl = await waitForControl((value) => value.view === 'system' &&
      value.disabled === false && value.exactText === 'Open Terminal', 'restored live terminal action');
    await wait(800);
    const restoredButton = await elementCenter('#project-terminal');
    if (!restoredButton) throw new Error('restored terminal action was not visible');
    clickPoint(restoredButton);
    await waitForControl((value) => controlTerminalCalls.length === 2 &&
      value.note === 'Terminal launch requested', 'second terminal launch');
    result.steps.push({ action: 'live-return', actualInput: true });
    result.metrics.finalLaunchCount = controlTerminalCalls.length;

    const planetTarget = await acquirePointerTarget('planet', false);
    clickPoint(planetTarget);
    await waitForView('planet');
    const planetControl = await waitForControl((value) => value.view === 'planet' &&
      value.terminalCount === 1 && value.exactText === 'Open Terminal', 'planet terminal action');
    result.steps.push({ action: 'planet-proof', actualInput: true });

    const layouts = [initialControl, launchedControl, replayControl, liveControl, planetControl];
    result.controls = {
      ids: launchedControl.ids,
      exactText: launchedControl.exactText,
      liveEnabled: initialControl.disabled === false && liveControl.disabled === false,
      replayDisabled: replayControl.disabled === true,
      replayNote: replayControl.note,
      overlapCount: layouts.reduce((sum, item) => sum + item.overlapCount, 0),
      clippedCount: layouts.reduce((sum, item) => sum + item.clippedCount, 0),
      singleTerminalButton: layouts.every((item) => item.terminalCount === 1),
      noProviderOrPromptControls: layouts.every((item) => item.noProviderOrPromptControls),
    };
    result.metrics.safeWindowsSpec = safeRecordedTerminalCalls(canonicalCwd);
    result.metrics.sameCanonicalCwd = controlTerminalCalls.every((call) =>
      call.args?.[1] === canonicalCwd && call.options?.cwd === canonicalCwd);
    result.metrics.planetRendered = planetControl.view === 'planet' &&
      planetControl.terminalCount === 1 && controlTerminalCalls.length === 2;
    result.metrics.noProcessOwnership = controlTerminalUnrefs === controlTerminalCalls.length &&
      controlTerminalCalls.length === 2;

    result.passed = result.metrics.initialLaunchCount === 1 &&
      replayCountAfterInput === 1 && result.metrics.replayLaunchCount === 1 &&
      result.metrics.finalLaunchCount === 2 && result.metrics.safeWindowsSpec &&
      result.metrics.sameCanonicalCwd && result.metrics.replayMainRejected &&
      result.metrics.planetRendered && result.metrics.noProcessOwnership &&
      result.metrics.pendingRerenderPreserved &&
      result.controls.liveEnabled && result.controls.replayDisabled &&
      result.controls.replayNote === 'Return to LIVE to open a terminal.' &&
      result.controls.overlapCount === 0 && result.controls.clippedCount === 0 &&
      result.controls.singleTerminalButton && result.controls.noProviderOrPromptControls &&
      rendererTestErrors.length === 0;
    if (!result.passed) throw new Error('control fixture metrics did not satisfy the rendered contract');
  } catch (error) {
    console.error(`[control-test] ${error && error.stack ? error.stack : error}`);
    result.error = 'control proof failed';
  } finally {
    result.rendererErrors = rendererTestErrors.slice();
    fs.writeFileSync(path.join(CONTROL_OUTPUT, 'result.json'), JSON.stringify(result, null, 2));
    if (result.passed) app.quit();
    else {
      cleanupForExit();
      app.exit(1);
    }
  }
}

async function runHistoryMode() {
  fs.mkdirSync(HISTORY_OUTPUT, { recursive: true });
  const result = {
    schemaVersion: 1,
    passed: false,
    windowSize: { width: 1200, height: 720 },
    steps: [],
    controls: {},
    metrics: {},
    rendererErrors: rendererTestErrors,
  };
  try {
    if (!historyFixture) throw new Error('history fixture was not created');
    await waitForView('universe');
    const initial = await waitForHistory((value) =>
      value.playback && value.playback.mode === 'live' && value.playback.available &&
      !value.playback.indexing && Number.isInteger(value.streamEpoch), 'history index');
    result.metrics.initialEpoch = initial.streamEpoch;

    const newProjectDir = path.join(path.dirname(historyFixture.projectDir), 'new-timeline-project');
    const newProjectSource = path.join(historyFixture.claudeRoot, 'fixture-new-timeline-project');
    fs.mkdirSync(newProjectDir, { recursive: true });
    fs.mkdirSync(newProjectSource, { recursive: true });
    fs.writeFileSync(path.join(newProjectSource, 'new-project.jsonl'), historyLine({
      type: 'user', timestamp: new Date().toISOString(), cwd: newProjectDir,
      message: { role: 'user', content: 'private new project fixture' },
    }));
    tracker.scan(false);
    tracker.pollFiles();
    const liveTimeline = await waitForHistory((value) => value.store?.projectCount >= 2 &&
      value.controls?.newMarkerCount >= 1 &&
      value.controls?.projectEventText === 'NEW SYSTEM · new-timeline-project',
    'new project timeline marker');
    result.metrics.liveTimeline = liveTimeline.controls.contextText === 'LIVE TIMELINE' &&
      Boolean(liveTimeline.controls.startText) && liveTimeline.controls.endText === 'LATEST' &&
      liveTimeline.controls.markerCount >= 2;
    console.log('[history-test] live timeline ready');

    const dragBefore = liveTimeline.performance;
    await dragHistory(initial.playback.maxTs, historyFixture.lateTs, 96);
    console.log('[history-test] drag committed');
    const lateUi = await waitForHistory((value) => value.playback?.mode === 'replay' &&
      !value.playback.indexing && Math.abs(value.playback.cursorTs - historyFixture.lateTs) < 5_000,
    'late replay seek');
    const dragAfter = lateUi.performance;
    result.metrics.dragInputEvents = dragAfter.inputEvents - dragBefore.inputEvents;
    result.metrics.dragPreviewFrames = dragAfter.previewFrames - dragBefore.previewFrames;
    result.metrics.dragSeekRequests = dragAfter.seekRequests - dragBefore.seekRequests;
    result.metrics.dragResponsive = result.metrics.dragInputEvents >= 8 &&
      result.metrics.dragPreviewFrames < result.metrics.dragInputEvents &&
      result.metrics.dragSeekRequests === 1 && dragAfter.maxInputHandlerMs < 16;
    const lateBuilds = snapshotBuilds(replaySource.snapshot());
    console.log('[history-test] late seek ready');

    await scrubHistory(historyFixture.earlyTs);
    const earlyUi = await waitForHistory((value) => value.playback?.mode === 'replay' &&
      Math.abs(value.playback.cursorTs - historyFixture.earlyTs) < 5_000,
    'backward replay seek');
    const earlyBuilds = snapshotBuilds(replaySource.snapshot());
    console.log('[history-test] backward seek ready');
    result.steps.push({ action: 'scrub', actualInput: true,
      fromBuilds: lateUi.store.totalBuilds, toBuilds: earlyUi.store.totalBuilds });
    result.metrics.replayEpoch = earlyUi.streamEpoch;
    result.metrics.seekReset = lateUi.store.totalBuilds > earlyUi.store.totalBuilds &&
      earlyUi.store.totalBuilds === 0 && lateUi.store.totalBuilds === lateBuilds.total &&
      earlyUi.store.totalBuilds === earlyBuilds.total;

    await capture(HISTORY_OUTPUT, 'replay-universe');
    win.webContents.send('au:debug-view', 'system');
    await waitForView('system');
    await capture(HISTORY_OUTPUT, 'system-before-build');

    for (const expected of ['10x', '100x', '1000x']) {
      await clickHistoryControl('#history-speed');
      await waitForHistory((value) => value.controls?.speedText === expected, `speed ${expected}`);
    }
    result.steps.push({ action: 'speed', actualInput: true, value: 1000 });

    fs.appendFileSync(historyFixture.claudeFile, historyLine({
      type: 'assistant', timestamp: new Date().toISOString(), cwd: historyFixture.projectDir,
      message: { role: 'assistant', content: [{
        type: 'tool_use', id: 'history-live-only', name: 'Edit',
        input: { file_path: path.join(historyFixture.projectDir, 'live', 'only-live.js'), new_string: 'private' },
      }] },
    }));
    tracker.scan(false);
    tracker.pollFiles();
    const liveUntil = Date.now() + 5_000;
    while (Date.now() < liveUntil && !liveTrackerBuilds().buckets.live) await wait(25);
    if (!liveTrackerBuilds().buckets.live) {
      const tailMetrics = [...tracker.files.values()].map((tail) => ({
        provider: tail.provider || 'claude', offset: tail.offset, catchup: tail.catchup,
      }));
      console.warn(`[history-test] live-tail diagnostics ${JSON.stringify({
        tails: tailMetrics, builds: liveTrackerBuilds(),
      })}`);
      throw new Error('background live tracker did not consume the appended record');
    }

    await clickHistoryControl('#history-play');
    await waitForHistory((value) => value.playback?.playing === true, 'replay play');
    result.steps.push({ action: 'play', actualInput: true });
    const buildUntil = Date.now() + 4_000;
    while (Date.now() < buildUntil && snapshotBuilds(replaySource.snapshot()).total <= earlyBuilds.total) {
      await wait(10);
    }
    if (snapshotBuilds(replaySource.snapshot()).total <= earlyBuilds.total) {
      throw new Error('timed replay did not cross a historical build');
    }
    console.log('[history-test] playback crossed build');

    await scrubHistory(historyFixture.forwardTs);
    const seekWhilePlaying = await waitForHistory((value) =>
      value.playback?.mode === 'replay' && value.playback.playing === false &&
      Math.abs(value.playback.cursorTs - historyFixture.forwardTs) < 5_000,
    'forward seek while replay is playing');
    result.steps.push({ action: 'seek-while-playing', actualInput: true });
    result.metrics.seekWhilePlaying = seekWhilePlaying.playback.playing === false &&
      Math.abs(seekWhilePlaying.playback.cursorTs - historyFixture.forwardTs) < 5_000;
    result.metrics.replayEpoch = seekWhilePlaying.streamEpoch;
    console.log('[history-test] seek while playing ready');

    await clickHistoryControl('#history-play');
    await waitForHistory((value) => value.playback?.playing === true, 'replay resume');
    await clickHistoryControl('#history-play');
    const paused = await waitForHistory((value) => value.playback?.mode === 'replay' &&
      value.playback.playing === false, 'replay pause');
    result.steps.push({ action: 'pause', actualInput: true });
    const pausedCursor = paused.playback.cursorTs;
    await wait(300);
    const stable = await readHistoryMetrics();
    result.metrics.pauseStable = stable.playback.playing === false &&
      stable.playback.cursorTs === pausedCursor;
    const advancedBuilds = snapshotBuilds(replaySource.snapshot());
    result.metrics.buildAdvanced = stable.store.totalBuilds > earlyUi.store.totalBuilds &&
      stable.store.totalBuilds === advancedBuilds.total;
    result.metrics.streamIsolation = !Object.hasOwn(advancedBuilds.buckets, 'live') &&
      stable.streamEpoch === result.metrics.replayEpoch &&
      stable.store.totalBuilds === advancedBuilds.total;
    result.controls.feedModeDuringReplay = stable.controls.feedMode;
    result.controls.speedText = stable.controls.speedText;
    await capture(HISTORY_OUTPUT, 'system-after-build');

    win.webContents.send('au:debug-view', 'planet');
    const planetView = await waitForView('planet');
    const planetChrome = await readHistoryMetrics();
    result.metrics.planetChromeClear = planetView.tabbarVisible === true &&
      planetChrome.layout?.inViewport === true &&
      (planetChrome.layout?.overlapIds?.length || 0) === 0;

    await clickHistoryControl('#history-live');
    const live = await waitForHistory((value) => value.playback?.mode === 'live' &&
      value.controls?.feedMode === 'LIVE', 'LIVE return');
    result.steps.push({ action: 'live', actualInput: true });
    result.metrics.liveEpoch = live.streamEpoch;
    const liveBuilds = liveTrackerBuilds();
    result.metrics.liveCaughtUp = Boolean(liveBuilds.buckets.live) &&
      live.store.totalBuilds === liveBuilds.total;
    result.controls.feedModeAfterLive = live.controls.feedMode;
    result.controls.chromeOverlapCount = live.layout?.overlapIds?.length || 0;
    result.controls.controlIds = await rendererEval(`Array.from(document.querySelectorAll(
      '#history-play,#history-speed,#history-scrubber,#history-time,#history-live')).map((el) => el.id)`);
    await capture(HISTORY_OUTPUT, 'live-return');

    const epochOrder = Number.isInteger(result.metrics.initialEpoch) &&
      Number.isInteger(result.metrics.replayEpoch) && Number.isInteger(result.metrics.liveEpoch) &&
      result.metrics.initialEpoch < result.metrics.replayEpoch &&
      result.metrics.replayEpoch < result.metrics.liveEpoch;
    result.passed = result.metrics.seekReset && result.metrics.dragResponsive &&
      result.metrics.liveTimeline && result.metrics.buildAdvanced &&
      result.metrics.seekWhilePlaying && result.metrics.pauseStable &&
      result.metrics.liveCaughtUp && result.metrics.streamIsolation &&
      result.metrics.planetChromeClear && epochOrder && result.controls.feedModeDuringReplay === 'REPLAY' &&
      result.controls.feedModeAfterLive === 'LIVE' && result.controls.speedText === '1000x' &&
      result.controls.chromeOverlapCount === 0 && rendererTestErrors.length === 0;
    if (!result.passed) throw new Error('history fixture metrics did not satisfy the rendered contract');
  } catch (error) {
    result.error = error && error.stack ? error.stack : String(error);
    console.error(`[history-test] ${result.error}`);
  } finally {
    result.rendererErrors = rendererTestErrors.slice();
    fs.writeFileSync(path.join(HISTORY_OUTPUT, 'result.json'), JSON.stringify(result, null, 2));
    if (result.passed) app.quit();
    else {
      cleanupForExit();
      app.exit(1);
    }
  }
}

async function runProviderMode() {
  fs.mkdirSync(PROVIDER_OUTPUT, { recursive: true });
  const result = { schemaVersion: 1, passed: false, rendererErrors: rendererTestErrors };
  try {
    await waitForView('universe');
    let dom = null;
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      dom = await rendererEval(`(() => ({
        badgeText: document.querySelector('.brand-badge')?.textContent?.trim() || '',
        tags: Array.from(document.querySelectorAll('.agent-provider-tag')).map((el) => el.textContent.trim()),
        attentionTagCount: document.querySelectorAll('.agent-row.has-attention .agent-provider-tag').length,
        rows: Array.from(document.querySelectorAll('.agent-row')).map((el) => ({
          shipId: el.dataset.shipId || '', provider: el.dataset.provider || ''
        })),
        stats: (() => {
          const scene = BABYLON.EngineStore.LastCreatedScene;
          return scene?.metadata?.providerStats ? scene.metadata.providerStats() : null;
        })(),
        visuals: (() => {
          const scene = BABYLON.EngineStore.LastCreatedScene;
          return (scene?.meshes || []).filter((mesh) => mesh.metadata?.isShip === true).map((mesh) => ({
            shipId: mesh.metadata.shipId || '',
            providerKey: mesh.metadata.providerKey || '',
            assetHullId: mesh.metadata.assetHullId || null,
            visualKind: mesh.metadata.visualKind || null,
          }));
        })()
      }))()`);
      const physicalReady = ['claude', 'codex'].every((key) =>
        dom?.visuals?.some((visual) => visual.providerKey === key && visual.assetHullId));
      const signalReady = dom?.visuals?.some((visual) =>
        visual.providerKey === 'generic' && visual.visualKind === 'signal-marker' && !visual.assetHullId);
      if (dom && dom.tags.length >= 3 && dom.stats && dom.stats.shipMeshCount >= 3 &&
          physicalReady && signalReady) break;
      await wait(100);
    }
    const snapshot = tracker.snapshot();
    const publicProviderCounts = { claude: 0, codex: 0, generic: 0 };
    for (const ship of snapshot.ships) {
      if (Object.hasOwn(publicProviderCounts, ship.provider)) publicProviderCounts[ship.provider]++;
    }
    const meshProviderCounts = dom?.stats?.providerCounts || {};
    result.badgeText = dom?.badgeText || '';
    result.sidebarProviderTags = dom?.tags || [];
    result.providerMetrics = {
      publicProviderCounts,
      meshProviderCounts,
      distinctProviderColors: dom?.stats?.distinctColorCount || 0,
      sidebarProviderTags: result.sidebarProviderTags,
      rows: dom?.rows || [],
      visuals: dom?.visuals || [],
      attentionProviderTagCount: dom?.attentionTagCount || 0,
      scene: dom?.stats || null,
    };
    await capture(PROVIDER_OUTPUT, 'universe');
    const rowCounts = { claude: 0, codex: 0, generic: 0 };
    for (const row of dom?.rows || []) {
      if (Object.hasOwn(rowCounts, row.provider)) rowCounts[row.provider]++;
    }
    result.providerMetrics.rowProviderCounts = rowCounts;
    const physicalModelsReady = ['claude', 'codex'].every((key) =>
      result.providerMetrics.visuals.some((visual) => visual.providerKey === key && visual.assetHullId));
    const signalMarkerReady = result.providerMetrics.visuals.some((visual) =>
      visual.providerKey === 'generic' && visual.visualKind === 'signal-marker' && !visual.assetHullId);
    result.passed = result.badgeText === 'MULTI-PROVIDER' &&
      ['claude', 'codex', 'generic'].every((key) =>
        publicProviderCounts[key] >= 1 && meshProviderCounts[key] >= 1 && rowCounts[key] >= 1) &&
      ['CLAUDE', 'CODEX', 'SIGNAL'].every((label) => result.sidebarProviderTags.includes(label)) &&
      result.providerMetrics.attentionProviderTagCount >= 1 &&
      result.providerMetrics.distinctProviderColors >= 3 &&
      physicalModelsReady && signalMarkerReady &&
      dom?.stats?.colorMismatchCount === 0 && rendererTestErrors.length === 0;
    if (!result.passed) throw new Error('provider fixture metrics did not satisfy the rendered contract');
  } catch (error) {
    result.error = error && error.stack ? error.stack : String(error);
    console.error(`[provider-test] ${result.error}`);
  } finally {
    result.rendererErrors = rendererTestErrors.slice();
    fs.writeFileSync(path.join(PROVIDER_OUTPUT, 'result.json'), JSON.stringify(result, null, 2));
    if (result.passed) app.quit();
    else {
      cleanupForExit();
      app.exit(1);
    }
  }
}

async function runPolishMode() {
  fs.mkdirSync(POLISH_OUTPUT, { recursive: true });
  const result = {
    schemaVersion: 1,
    passed: false,
    views: [],
    steps: [],
    projectId: null,
    planetName: null,
    openedProjectId: null,
    labelMetrics: null,
    galaxyMetrics: null,
    backdropMetrics: null,
  };
  try {
    const universe = await waitForView('universe');
    if (universe.camera !== 'ucam' || universe.backVisible || universe.summary !== 'UNIVERSE SUMMARY') {
      throw new Error(`bad universe chrome: ${JSON.stringify(universe)}`);
    }
    result.views.push('universe');
    await wait(1200);
    const initialLabels = await readPolishStats();
    result.galaxyMetrics = initialLabels && initialLabels.galaxyMetrics
      ? initialLabels.galaxyMetrics : null;
    const universeImage = await capture(POLISH_OUTPUT, 'universe');
    result.backdropMetrics = backdropLuma(universeImage);

    const hoverTarget = await acquirePointerTarget('sun', true);
    const initiallyHidden = initialLabels.labels.some((label) => label.id === hoverTarget.id && !label.visible);
    await wait(180);
    const hoveredLabels = await readPolishStats();
    const hoverVisible = hoveredLabels.labels.some((label) => label.id === hoverTarget.id && label.visible);
    await capture(POLISH_OUTPUT, 'hover');
    await exerciseCamera();
    const cameraLabels = await readPolishStats();
    await capture(POLISH_OUTPUT, 'camera');
    result.labelMetrics = {
      glyphCount: initialLabels.glyphCount,
      totalLabels: initialLabels.totalLabels,
      pickableSunCount: initialLabels.pickableSunCount,
      labelControlCount: initialLabels.labelControlCount,
      visibleLabels: initialLabels.visibleLabels,
      hiddenLabels: initialLabels.hiddenLabels,
      overlaps: initialLabels.overlaps,
      afterHoverOverlaps: hoveredLabels.overlaps,
      afterCameraOverlaps: cameraLabels.overlaps,
      measuredLabelCount: initialLabels.measuredLabelCount,
      measuredOverlaps: initialLabels.measuredOverlaps,
      measuredChromeOcclusions: initialLabels.measuredChromeOcclusions,
      afterHoverMeasuredOverlaps: hoveredLabels.measuredOverlaps,
      afterHoverChromeOcclusions: hoveredLabels.measuredChromeOcclusions,
      afterCameraMeasuredOverlaps: cameraLabels.measuredOverlaps,
      afterCameraChromeOcclusions: cameraLabels.measuredChromeOcclusions,
      hoverReveal: initiallyHidden && hoverVisible,
      hoverProjectId: hoverTarget.id,
      finiteProjections: initialLabels.finiteProjections,
    };

    const sunTarget = await acquirePointerTarget('sun', false, hoverTarget.id);
    result.projectId = sunTarget.id;
    const sunInput = clickPoint(sunTarget);
    const system = await waitForView('system');
    if (system.camera !== 'scam' || !system.backVisible || system.backText !== '← Universe' ||
        system.summary !== 'PROJECT SUMMARY' || !system.projectCard.includes('PROJECT:')) {
      throw new Error(`bad system chrome: ${JSON.stringify(system)}`);
    }
    result.views.push('system');
    result.steps.push({ action: 'canvas-sun-click', input: sunInput, pickValidated: true, from: 'universe', to: 'system', id: sunTarget.id });
    result.systemColorMetrics = await readPolishStats();
    await capture(POLISH_OUTPUT, 'system');

    const openFolder = await elementCenter('#project-card .pc-btn');
    if (!openFolder) throw new Error('Open Folder button missing');
    result.openFolderInput = clickPoint(openFolder);
    const openUntil = Date.now() + 2000;
    while (Date.now() < openUntil && openedProjects[openedProjects.length - 1] !== result.projectId) await wait(40);
    result.openedProjectId = openedProjects[openedProjects.length - 1] || null;

    const planetTarget = await acquirePointerTarget('planet', false);
    result.planetName = planetTarget.id;
    const planetInput = clickPoint(planetTarget);
    const planet = await waitForView('planet');
    if (planet.camera !== 'pcam' || !planet.backVisible || !planet.tabbarVisible ||
        planet.summary !== 'PLANET SUMMARY' || !planet.planetCard.includes('PLANET:')) {
      throw new Error(`bad planet chrome: ${JSON.stringify(planet)}`);
    }
    result.views.push('planet');
    result.steps.push({ action: 'canvas-planet-click', input: planetInput, pickValidated: true, from: 'system', to: 'planet', id: planetTarget.id });
    await capture(POLISH_OUTPUT, 'planet');

    const backToSystem = await elementCenter('#back-btn');
    if (!backToSystem) throw new Error('planet Back button missing');
    const backSystemInput = clickPoint(backToSystem);
    const systemAgain = await waitForView('system');
    if (systemAgain.summary !== 'PROJECT SUMMARY' || systemAgain.backText !== '← Universe') {
      throw new Error(`bad returned system chrome: ${JSON.stringify(systemAgain)}`);
    }
    result.views.push('system');
    result.steps.push({ action: 'back-button-click', input: backSystemInput, from: 'planet', to: 'system' });
    await capture(POLISH_OUTPUT, 'back-system');

    const backToUniverse = await elementCenter('#back-btn');
    if (!backToUniverse) throw new Error('system Back button missing');
    const backUniverseInput = clickPoint(backToUniverse);
    const universeAgain = await waitForView('universe');
    if (universeAgain.backVisible || universeAgain.summary !== 'UNIVERSE SUMMARY') {
      throw new Error(`bad returned universe chrome: ${JSON.stringify(universeAgain)}`);
    }
    result.views.push('universe');
    result.steps.push({ action: 'back-button-click', input: backUniverseInput, from: 'system', to: 'universe' });
    await capture(POLISH_OUTPUT, 'back-universe');

    if (rendererTestErrors.length) throw new Error(`renderer errors: ${rendererTestErrors.join(' | ')}`);
    if (result.openedProjectId !== result.projectId) throw new Error('Open Folder project id mismatch');
    result.passed = true;
  } catch (error) {
    result.error = error && error.stack ? error.stack : String(error);
    console.error(`[polish-test] ${result.error}`);
  } finally {
    result.rendererErrors = rendererTestErrors;
    result.inputEvents = pointerInputEvents;
    fs.writeFileSync(path.join(POLISH_OUTPUT, 'result.json'), JSON.stringify(result, null, 2));
    if (result.passed) app.quit();
    else app.exit(1);
  }
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
app.on('before-quit', cleanupForExit);

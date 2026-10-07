// @ts-check
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { Tracker } = require('./tracker');
const { ReplaySource } = require('./replay-source');
const { createTerminalLauncher } = require('./terminal-launcher');
const { createAgentLauncher } = require('./agent-launcher');
const { TaskRunTracker } = require('./task-runs');
const { RootTaskStore } = require('./root-tasks');
const { RootTaskCoordinator } = require('./root-task-coordinator');
const { createLocalGitStatusCollector } = require('./project-vcs-status');
const { createGitHubMetadataProvider } = require('./github-metadata-provider');
const { createProjectVcsStatusService } = require('./project-vcs-status-service');
const { createProjectVcsStatusController } = require('./project-vcs-status-controller');

/** @import { AUEvent, BatchMeta, TasksChangedPush } from '../types/contract' */

/**
 * @param {{ flags: ReturnType<typeof import('./flags').readFlags>,
 *   fixtures: typeof import('./harness/fixtures') }} options
 * @param {Pick<typeof import('electron'), 'app'>} [electron]
 */
function createAppContext({ flags, fixtures }, electron = require('electron')) {
  const { app } = electron;
  let providerFixtureRoot = null;
  let historyFixtureRoot = null;
  const ctx = {
    flags,
    win: null,
    tracker: null,
    replaySource: null,
    activeSource: null,
    terminalLauncher: null,
    taskRuns: null,
    rootTasks: null,
    rootTaskCoordinator: null,
    projectVcsStatusController: null,
    taskRunSweepTimer: null,
    streamEpoch: 1,
    harness: {
      rendererTestErrors: [],
      openedProjects: [],
      controlFixture: null,
      historyFixture: null,
    },
    start,
    cleanup,
  };

  // main.js attaches ctx.replay and ctx.ipc after this factory returns. Name what is
  // missing before any service is built instead of failing halfway through start().
  function assertWired(caller) {
    const ipc = ctx.ipc || {};
    const missing = [
      ['ctx.replay', ctx.replay],
      ['ctx.ipc.terminal', ipc.terminal],
      ['ctx.ipc.rootTasks', ipc.rootTasks],
      ['ctx.ipc.projectPaths', ipc.projectPaths],
    ].filter(([, value]) => !value).map(([name]) => name);
    if (missing.length) {
      throw new Error(`${caller}() needs ${missing.join(', ')}; attach them after createAppContext (see main.js)`);
    }
  }

  function start() {
    assertWired('start');
    const providerFixture = ctx.flags.providerTest ? fixtures.createProviderFixture() : null;
    ctx.harness.controlFixture = ctx.flags.controlTest ? fixtures.createControlFixture() : null;
    ctx.harness.historyFixture = ctx.flags.controlTest
      ? ctx.harness.controlFixture
      : (ctx.flags.historyTest ? fixtures.createHistoryFixture() : null);
    if (providerFixture) providerFixtureRoot = providerFixture.root;
    if (ctx.harness.historyFixture) historyFixtureRoot = ctx.harness.historyFixture.root;
    const fixture = ctx.harness.historyFixture || providerFixture;
    const trackerOptions = ctx.harness.historyFixture ? ctx.harness.historyFixture.trackerOptions : providerFixture?.options;
    ctx.tracker = fixture
      ? new Tracker(fixture.statePath, trackerOptions)
      : new Tracker(path.join(app.getPath('userData'), 'universe-state.json'));
    const projectVcsStatusService = createProjectVcsStatusService({
      collector: createLocalGitStatusCollector(),
      githubProvider: createGitHubMetadataProvider(),
      onChange: ctx.replay.sendProjectVcsStatusChanged,
    });
    ctx.projectVcsStatusController = createProjectVcsStatusController({
      tracker: ctx.tracker,
      service: projectVcsStatusService,
      onError(error) {
        console.warn(`[git] project status refresh failed: ${error && error.message ? error.message : error}`);
      },
    });
    const workflowStateDirectory = fixture
      ? path.dirname(fixture.statePath)
      : app.getPath('userData');
    const taskRunStatePath = path.join(workflowStateDirectory, 'task-runs.json');
    ctx.rootTasks = new RootTaskStore(path.join(workflowStateDirectory, 'root-tasks.json'));
    ctx.taskRuns = new TaskRunTracker({
      statePath: taskRunStatePath,
      resolveProjectRoot: ctx.ipc.terminal.liveProjectCwd,
      onChange: ({ run }) => {
        if (!run) return;
        let rootObserved = false;
        if (ctx.rootTaskCoordinator) {
          try { rootObserved = ctx.rootTaskCoordinator.observeRun(run).ok === true; } catch {
            rootObserved = false;
          }
        }
        if (!rootObserved) ctx.ipc.rootTasks.sendRootTasksChanged(run);
        if (ctx.win && !ctx.win.isDestroyed()) {
          ctx.win.webContents.send('au:tasks-changed', /** @satisfies {TasksChangedPush} */ ({
            projectId: run.projectId,
            taskId: run.id,
            phase: run.phase,
          }));
        }
      },
    });
    ctx.rootTaskCoordinator = new RootTaskCoordinator({
      store: ctx.rootTasks,
      taskRuns: ctx.taskRuns,
      launcher: createAgentLauncher(),
      resolveProjectRoot: ctx.ipc.terminal.liveProjectCwd,
      listShips: ctx.ipc.rootTasks.liveProjectShips,
      onChange: ({ reason, item }) => ctx.ipc.rootTasks.sendRootTasksChanged(item, reason),
    });
    for (const item of ctx.rootTasks.list()) {
      const run = ctx.taskRuns.get(item.id);
      if (run) ctx.rootTaskCoordinator.observeRun(run);
    }
    ctx.taskRunSweepTimer = setInterval(() => {
      if (!ctx.taskRuns) return;
      try { ctx.taskRuns.expire(); } catch (error) {
        console.warn(`[tasks] stale-run cleanup failed: ${error && error.message ? error.message : error}`);
      }
    }, 30_000);
    if (typeof ctx.taskRunSweepTimer.unref === 'function') ctx.taskRunSweepTimer.unref();
    const replayOptions = ctx.harness.historyFixture
      ? ctx.harness.historyFixture.replayOptions
      : providerFixture
        ? {
            claudeProjectsDir: providerFixture.options.claudeProjectsDir,
            codexSessionDirs: [providerFixture.options.codexSessionsDir],
          }
        : {};
    ctx.replaySource = new ReplaySource(replayOptions);
    ctx.terminalLauncher = ctx.flags.controlTest
      ? fixtures.createRecordingTerminalLauncher(ctx.harness.controlFixture)
      : createTerminalLauncher();
    ctx.ipc.terminal.reset();
    ctx.activeSource = ctx.tracker;
    ctx.tracker.on('events', (/** @type {AUEvent[]} */ batch) => {
      if (ctx.projectVcsStatusController) ctx.projectVcsStatusController.observeEvents(batch);
      for (const event of Array.isArray(batch) ? batch : []) {
        if (event.type === 'project-updated' && event.project && event.project.exists === true) {
          ctx.ipc.projectPaths.revokeProjectPathCandidates(event.project.id);
        }
      }
      if (ctx.taskRuns) {
        try { ctx.taskRuns.observe(batch); } catch (error) {
          console.warn(`[tasks] completion tracking failed: ${error && error.message ? error.message : error}`);
        }
      }
      if (ctx.activeSource === ctx.tracker && ctx.win && !ctx.win.isDestroyed()) {
        ctx.win.webContents.send('au:events', batch,
          /** @satisfies {BatchMeta} */ ({ streamEpoch: ctx.streamEpoch, mode: 'live' }));
      }
    });
    ctx.replaySource.on('events', (/** @type {AUEvent[]} */ batch) => {
      if (ctx.activeSource === ctx.replaySource && ctx.win && !ctx.win.isDestroyed()) {
        ctx.win.webContents.send('au:events', batch,
          /** @satisfies {BatchMeta} */ ({ streamEpoch: ctx.streamEpoch, mode: 'replay' }));
      }
    });
    ctx.replaySource.on('state', ctx.replay.sendReplayState);
    ctx.tracker.start();
    ctx.projectVcsStatusController.start();
    ctx.win.on('focus', () => {
      if (ctx.projectVcsStatusController) ctx.projectVcsStatusController.refreshAll();
    });
    if (ctx.flags.historyTest || ctx.flags.controlTest || !ctx.flags.testMode) {
      ctx.replay.ensureReplayIndex(false).catch((error) => {
        console.warn(`[history] index unavailable: ${error && error.message ? error.message : error}`);
      });
    }
    if (ctx.flags.providerTest) {
      const claudeShip = [...ctx.tracker.ships.values()].find((ship) => ship.provider === 'claude');
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

  function cleanup() {
    assertWired('cleanup');
    ctx.replay.reset();
    ctx.ipc.projectPaths.reset();
    if (ctx.taskRunSweepTimer) clearInterval(ctx.taskRunSweepTimer);
    ctx.taskRunSweepTimer = null;
    if (ctx.projectVcsStatusController) ctx.projectVcsStatusController.stop();
    ctx.projectVcsStatusController = null;
    if (ctx.replaySource) {
      ctx.replaySource.stop();
      ctx.replaySource = null;
    }
    if (ctx.tracker) {
      ctx.tracker.stop();
      ctx.tracker = null;
    }
    ctx.activeSource = null;
    ctx.terminalLauncher = null;
    ctx.rootTaskCoordinator = null;
    ctx.rootTasks = null;
    ctx.taskRuns = null;
    ctx.ipc.terminal.reset();
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
      ctx.harness.historyFixture = null;
      ctx.harness.controlFixture = null;
    }
  }

  return ctx;
}

module.exports = { createAppContext };

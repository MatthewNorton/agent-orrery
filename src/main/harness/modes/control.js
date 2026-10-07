// @ts-check
'use strict';

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { wait } = require('../driver');

async function runControlMode(ctx, driver, metrics) {
  const { rendererEval, waitForView, acquirePointerTarget, clickPoint, elementCenter, capture } = driver;
  const {
    waitForHistory, clickHistoryControl, scrubHistory, waitForControl, safeRecordedTerminalCalls,
  } = metrics;
  fs.mkdirSync(ctx.flags.outputs.control, { recursive: true });
  const result = {
    schemaVersion: 1,
    passed: false,
    windowSize: { width: 1200, height: 720 },
    steps: [],
    controls: {},
    metrics: {},
    rendererErrors: ctx.harness.rendererTestErrors,
  };
  try {
    if (!ctx.harness.controlFixture) throw new Error('control fixture was not created');
    await waitForView('universe');
    await waitForHistory((value) => value.playback?.mode === 'live' &&
      value.playback.available && !value.playback.indexing, 'control history index');

    const project = [...ctx.tracker.projects.values()].find((item) =>
      item && item.exists && item.path === ctx.harness.controlFixture.projectDir);
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
    ctx.win.webContents.send('au:replay-state', {
      ...ctx.replay.boundedReplayStatus('live'),
      streamEpoch: ctx.streamEpoch,
    });
    const rerenderedPendingControl = await waitForControl((value) => value.state === 'pending' &&
      value.busy === true && value.disabled === true, 'pending action after card rerender');
    const pendingButton = await elementCenter('#project-terminal');
    if (!pendingButton) throw new Error('pending terminal action was not visible');
    clickPoint(pendingButton);
    await wait(50);
    const pendingLaunchCount = ctx.terminalLauncher.calls.length;
    const launchedControl = await waitForControl((value) => ctx.terminalLauncher.calls.length === 1 &&
      value.note === 'Terminal launch requested' && value.disabled === false,
    'first terminal launch');
    result.steps.push({ action: 'system-terminal', actualInput: true });
    result.metrics.initialLaunchCount = ctx.terminalLauncher.calls.length;
    result.metrics.pendingRerenderPreserved = pendingControl.busy === true &&
      rerenderedPendingControl.busy === true && pendingLaunchCount === 0;
    await capture(ctx.flags.outputs.control, 'control-live');

    await scrubHistory(ctx.harness.controlFixture.earlyTs);
    await waitForHistory((value) => value.playback?.mode === 'replay', 'control replay mode');
    await waitForView('system');
    const replayControl = await waitForControl((value) => value.view === 'system' &&
      value.disabled === true && value.state === 'replay' &&
      value.note === 'Return to LIVE to open a terminal.', 'disabled replay terminal action');
    const replayButton = await elementCenter('#project-terminal');
    if (!replayButton) throw new Error('replay terminal action was not rendered');
    clickPoint(replayButton);
    await wait(120);
    const replayCountAfterInput = ctx.terminalLauncher.calls.length;
    const forged = await rendererEval(
      `AU.openTerminal(${JSON.stringify(project.id)})`
    );
    await wait(80);
    result.steps.push({ action: 'replay-blocked', actualInput: true });
    result.metrics.replayLaunchCount = ctx.terminalLauncher.calls.length;
    result.metrics.replayMainRejected = Boolean(forged && forged.ok === false && forged.code === 'REPLAY');
    await capture(ctx.flags.outputs.control, 'control-replay');

    await clickHistoryControl('#history-live');
    await waitForHistory((value) => value.playback?.mode === 'live', 'control LIVE return');
    await waitForView('system');
    const liveControl = await waitForControl((value) => value.view === 'system' &&
      value.disabled === false && value.exactText === 'Open Terminal', 'restored live terminal action');
    await wait(800);
    const restoredButton = await elementCenter('#project-terminal');
    if (!restoredButton) throw new Error('restored terminal action was not visible');
    clickPoint(restoredButton);
    await waitForControl((value) => ctx.terminalLauncher.calls.length === 2 &&
      value.note === 'Terminal launch requested', 'second terminal launch');
    result.steps.push({ action: 'live-return', actualInput: true });
    result.metrics.finalLaunchCount = ctx.terminalLauncher.calls.length;

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
    result.metrics.sameCanonicalCwd = ctx.terminalLauncher.calls.every((call) =>
      call.args?.[1] === canonicalCwd && call.options?.cwd === canonicalCwd);
    result.metrics.planetRendered = planetControl.view === 'planet' &&
      planetControl.terminalCount === 1 && ctx.terminalLauncher.calls.length === 2;
    result.metrics.noProcessOwnership = ctx.terminalLauncher.unrefs === ctx.terminalLauncher.calls.length &&
      ctx.terminalLauncher.calls.length === 2;

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
      ctx.harness.rendererTestErrors.length === 0;
    if (!result.passed) throw new Error('control fixture metrics did not satisfy the rendered contract');
  } catch (error) {
    console.error(`[control-test] ${error && error.stack ? error.stack : error}`);
    result.error = 'control proof failed';
  } finally {
    result.rendererErrors = ctx.harness.rendererTestErrors.slice();
    fs.writeFileSync(path.join(ctx.flags.outputs.control, 'result.json'), JSON.stringify(result, null, 2));
    if (result.passed) app.quit();
    else {
      ctx.cleanup();
      app.exit(1);
    }
  }
}

module.exports = { run: runControlMode };

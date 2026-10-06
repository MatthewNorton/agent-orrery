'use strict';

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { wait } = require('../driver');
const { historyLine } = require('../fixtures');

async function runHistoryMode(ctx, driver, metrics) {
  const { rendererEval, waitForView, capture } = driver;
  const {
    readHistoryMetrics, waitForHistory, clickHistoryControl, scrubHistory, dragHistory,
    snapshotBuilds, liveTrackerBuilds,
  } = metrics;
  fs.mkdirSync(ctx.flags.outputs.history, { recursive: true });
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
    if (!ctx.harness.historyFixture) throw new Error('history fixture was not created');
    await waitForView('universe');
    const initial = await waitForHistory((value) =>
      value.playback && value.playback.mode === 'live' && value.playback.available &&
      !value.playback.indexing && Number.isInteger(value.streamEpoch), 'history index');
    result.metrics.initialEpoch = initial.streamEpoch;

    const newProjectDir = path.join(path.dirname(ctx.harness.historyFixture.projectDir), 'new-timeline-project');
    const newProjectSource = path.join(ctx.harness.historyFixture.claudeRoot, 'fixture-new-timeline-project');
    fs.mkdirSync(newProjectDir, { recursive: true });
    fs.mkdirSync(newProjectSource, { recursive: true });
    fs.writeFileSync(path.join(newProjectSource, 'new-project.jsonl'), historyLine({
      type: 'user', timestamp: new Date().toISOString(), cwd: newProjectDir,
      message: { role: 'user', content: 'private new project fixture' },
    }));
    ctx.tracker.scan(false);
    ctx.tracker.pollFiles();
    const liveTimeline = await waitForHistory((value) => value.store?.projectCount >= 2 &&
      value.controls?.newMarkerCount >= 1 &&
      value.controls?.projectEventText === 'NEW SYSTEM · new-timeline-project',
    'new project timeline marker');
    result.metrics.liveTimeline = liveTimeline.controls.contextText === 'LIVE TIMELINE' &&
      Boolean(liveTimeline.controls.startText) && liveTimeline.controls.endText === 'LATEST' &&
      liveTimeline.controls.markerCount >= 2;
    console.log('[history-test] live timeline ready');

    const dragBefore = liveTimeline.performance;
    await dragHistory(initial.playback.maxTs, ctx.harness.historyFixture.lateTs, 96);
    console.log('[history-test] drag committed');
    const lateUi = await waitForHistory((value) => value.playback?.mode === 'replay' &&
      !value.playback.indexing && Math.abs(value.playback.cursorTs - ctx.harness.historyFixture.lateTs) < 5_000,
    'late replay seek');
    const dragAfter = lateUi.performance;
    result.metrics.dragInputEvents = dragAfter.inputEvents - dragBefore.inputEvents;
    result.metrics.dragPreviewFrames = dragAfter.previewFrames - dragBefore.previewFrames;
    result.metrics.dragSeekRequests = dragAfter.seekRequests - dragBefore.seekRequests;
    result.metrics.dragResponsive = result.metrics.dragInputEvents >= 8 &&
      result.metrics.dragPreviewFrames < result.metrics.dragInputEvents &&
      result.metrics.dragSeekRequests === 1 && dragAfter.maxInputHandlerMs < 16;
    const lateBuilds = snapshotBuilds(ctx.replaySource.snapshot());
    console.log('[history-test] late seek ready');

    await scrubHistory(ctx.harness.historyFixture.earlyTs);
    const earlyUi = await waitForHistory((value) => value.playback?.mode === 'replay' &&
      Math.abs(value.playback.cursorTs - ctx.harness.historyFixture.earlyTs) < 5_000,
    'backward replay seek');
    const earlyBuilds = snapshotBuilds(ctx.replaySource.snapshot());
    console.log('[history-test] backward seek ready');
    result.steps.push({ action: 'scrub', actualInput: true,
      fromBuilds: lateUi.store.totalBuilds, toBuilds: earlyUi.store.totalBuilds });
    result.metrics.replayEpoch = earlyUi.streamEpoch;
    result.metrics.seekReset = lateUi.store.totalBuilds > earlyUi.store.totalBuilds &&
      earlyUi.store.totalBuilds === 0 && lateUi.store.totalBuilds === lateBuilds.total &&
      earlyUi.store.totalBuilds === earlyBuilds.total;

    await capture(ctx.flags.outputs.history, 'replay-universe');
    ctx.win.webContents.send('au:debug-view', 'system');
    await waitForView('system');
    await capture(ctx.flags.outputs.history, 'system-before-build');

    for (const expected of ['10x', '100x', '1000x']) {
      await clickHistoryControl('#history-speed');
      await waitForHistory((value) => value.controls?.speedText === expected, `speed ${expected}`);
    }
    result.steps.push({ action: 'speed', actualInput: true, value: 1000 });

    fs.appendFileSync(ctx.harness.historyFixture.claudeFile, historyLine({
      type: 'assistant', timestamp: new Date().toISOString(), cwd: ctx.harness.historyFixture.projectDir,
      message: { role: 'assistant', content: [{
        type: 'tool_use', id: 'history-live-only', name: 'Edit',
        input: { file_path: path.join(ctx.harness.historyFixture.projectDir, 'live', 'only-live.js'), new_string: 'private' },
      }] },
    }));
    ctx.tracker.scan(false);
    ctx.tracker.pollFiles();
    const liveUntil = Date.now() + 5_000;
    while (Date.now() < liveUntil && !liveTrackerBuilds().buckets.live) await wait(25);
    if (!liveTrackerBuilds().buckets.live) {
      const tailMetrics = [...ctx.tracker.files.values()].map((tail) => ({
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
    while (Date.now() < buildUntil && snapshotBuilds(ctx.replaySource.snapshot()).total <= earlyBuilds.total) {
      await wait(10);
    }
    if (snapshotBuilds(ctx.replaySource.snapshot()).total <= earlyBuilds.total) {
      throw new Error('timed replay did not cross a historical build');
    }
    console.log('[history-test] playback crossed build');

    await scrubHistory(ctx.harness.historyFixture.forwardTs);
    const seekWhilePlaying = await waitForHistory((value) =>
      value.playback?.mode === 'replay' && value.playback.playing === false &&
      Math.abs(value.playback.cursorTs - ctx.harness.historyFixture.forwardTs) < 5_000,
    'forward seek while replay is playing');
    result.steps.push({ action: 'seek-while-playing', actualInput: true });
    result.metrics.seekWhilePlaying = seekWhilePlaying.playback.playing === false &&
      Math.abs(seekWhilePlaying.playback.cursorTs - ctx.harness.historyFixture.forwardTs) < 5_000;
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
    const advancedBuilds = snapshotBuilds(ctx.replaySource.snapshot());
    result.metrics.buildAdvanced = stable.store.totalBuilds > earlyUi.store.totalBuilds &&
      stable.store.totalBuilds === advancedBuilds.total;
    result.metrics.streamIsolation = !Object.hasOwn(advancedBuilds.buckets, 'live') &&
      stable.streamEpoch === result.metrics.replayEpoch &&
      stable.store.totalBuilds === advancedBuilds.total;
    result.controls.feedModeDuringReplay = stable.controls.feedMode;
    result.controls.speedText = stable.controls.speedText;
    await capture(ctx.flags.outputs.history, 'system-after-build');

    ctx.win.webContents.send('au:debug-view', 'planet');
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
    await capture(ctx.flags.outputs.history, 'live-return');

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
      result.controls.chromeOverlapCount === 0 && ctx.harness.rendererTestErrors.length === 0;
    if (!result.passed) throw new Error('history fixture metrics did not satisfy the rendered contract');
  } catch (error) {
    result.error = error && error.stack ? error.stack : String(error);
    console.error(`[history-test] ${result.error}`);
  } finally {
    result.rendererErrors = ctx.harness.rendererTestErrors.slice();
    fs.writeFileSync(path.join(ctx.flags.outputs.history, 'result.json'), JSON.stringify(result, null, 2));
    if (result.passed) app.quit();
    else {
      ctx.cleanup();
      app.exit(1);
    }
  }
}

module.exports = { run: runHistoryMode };

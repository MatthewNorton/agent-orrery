// @ts-check
// Stream epochs, playback state, and replay commands (live/history switching).
'use strict';

/**
 * @import { PlaybackStatus, ReplayCommand, ReplayResult, ReplayStatePush } from '../../types/contract'
 */

(function () {
  const AUR = window.AUR;
  const AU = window.AU;
  const A = AUR.app;
  if (!A) throw new Error('app/state.js must load before app/replay.js');
  const S = A.state, CHROME = A.const.CHROME;
  // What a replay command in flight disables, and what its settling re-enables.
  const REPLAY_BUSY_CHROME = CHROME.HISTORY | CHROME.PROJECT | CHROME.FOCUS | CHROME.SETTINGS | CHROME.IDEAS;

  // ---------- epoch / playback / replay helpers ----------
  A.epochOf = function epochOf(value) {
    return value && value.streamEpoch != null ? value.streamEpoch : null;
  };

  A.sameEpoch = function sameEpoch(a, b) {
    return a != null && b != null && String(a) === String(b);
  };

  A.isRetiredEpoch = function isRetiredEpoch(value) {
    if (S.retiredEpochs.has(String(value))) return true;
    return Number.isInteger(value) && Number.isInteger(S.streamEpoch) && value < S.streamEpoch;
  };

  function retireEpoch(value) {
    if (value == null) return;
    S.retiredEpochs.add(String(value));
    while (S.retiredEpochs.size > 64) S.retiredEpochs.delete(S.retiredEpochs.values().next().value);
  }

  // Main's PlaybackStatus is complete (replay-control.js boundedReplayStatus), but a time it
  // has not indexed is null, and the bar keeps the last known one.
  /** @param {PlaybackStatus} value */
  function normalizePlayback(value) {
    /** @param {'minTs' | 'maxTs' | 'cursorTs'} name */
    const known = (name) => (Number.isFinite(value[name]) ? value[name] : S.playback[name]);
    const { mode } = value;
    const maxTs = known('maxTs');
    return {
      mode,
      available: value.available,
      indexing: value.indexing,
      minTs: known('minTs'),
      maxTs,
      cursorTs: mode === 'live' && Number.isFinite(maxTs) ? maxTs : known('cursorTs'),
      playing: value.playing,
      speed: value.speed,
      truncated: value.truncated,
    };
  }

  A.applyPlayback = function applyPlayback(value, updateChrome = true) {
    if (value && typeof value === 'object') S.playback = normalizePlayback(value);
    if (updateChrome) {
      A.renderChromeNow(CHROME.HISTORY | CHROME.FEED | CHROME.PROJECT | CHROME.SETTINGS | CHROME.IDEAS);
    }
  };

  /** @param {ReplayStatePush} next */
  A.handleReplayState = function handleReplayState(next) {
    if (S.replayTransitionPending) return;
    const nextEpoch = A.epochOf(next);
    if (nextEpoch != null && S.streamEpoch != null && !A.sameEpoch(nextEpoch, S.streamEpoch)) return;
    A.applyPlayback(next);
  };

  A.playbackReferenceTs = function playbackReferenceTs() {
    return S.playback.mode === 'replay' && Number.isFinite(S.playback.cursorTs)
      ? S.playback.cursorTs : Date.now();
  };

  /** @param {ReplayResult} result */
  function adoptReplayResult(result, forceReset) {
    if (!result || typeof result !== 'object') return;
    const snap = result.snapshot && typeof result.snapshot === 'object' ? result.snapshot : null;
    // Set replay mode before any historical ship update can consider desktop
    // notifications. Historical attention stays visible but never pages.
    A.applyPlayback(result.playback, false);

    const nextEpoch = result.streamEpoch != null
      ? result.streamEpoch : A.epochOf(snap);
    const changedEpoch = nextEpoch != null && !A.sameEpoch(nextEpoch, S.streamEpoch);
    if (snap && (forceReset || changedEpoch || S.streamEpoch == null)) {
      const previousRoute = { ...S.current };
      S.routeRequestGeneration++;
      if (S.streamEpoch != null && changedEpoch) retireEpoch(S.streamEpoch);
      if (nextEpoch != null) S.streamEpoch = nextEpoch;
      A.seedStore(snap);
      S.lastEventSequence = Number.isFinite(snap.eventSequence) ? snap.eventSequence : -Infinity;
      S.notificationByShip.clear();
      S.lastNotificationAt = -Infinity;
      S.historyPreviewTs = null;
      // A complete route rebuild is the safe reconciliation point: it removes
      // projects, galaxies, and ships that do not exist at the new cursor
      // without adding reset branches to each scene.
      if (!S.booting && S.activeView) A.rebuildRoute(previousRoute);
      else if (!S.booting) A.renderChrome();
      drainDeferredEpochEvents();
      return;
    }
    // issueReplay re-renders the history bar and the project card as it settles.
    A.renderChromeNow(CHROME.FEED);
  }

  /** @param {ReplayResult} result */
  A.adoptLiveRestart = function adoptLiveRestart(result) {
    adoptReplayResult(result, true);
  };

  A.rebuildRoute = function rebuildRoute(route) {
    if (!route || route.view === 'universe' || !route.projectId ||
        !S.store.projects.has(route.projectId)) {
      A.showUniverse();
      return;
    }
    if (route.view === 'planet' && route.planetName) {
      A.openPlanet(route.projectId, route.planetName);
      return;
    }
    A.openSystem(route.projectId);
  };

  function drainDeferredEpochEvents() {
    if (S.deferredEpochBatches.length === 0) return;
    const queued = S.deferredEpochBatches;
    S.deferredEpochBatches = [];
    for (const packet of queued) {
      const incomingEpoch = A.epochOf(packet.meta);
      if (incomingEpoch == null || A.sameEpoch(incomingEpoch, S.streamEpoch)) {
        A.handleSequencedEvents(packet.batch, packet.meta);
      } else if (!A.isRetiredEpoch(incomingEpoch)) {
        S.deferredEpochBatches.push(packet);
      }
    }
  }

  /** @param {ReplayCommand} command */
  A.issueReplay = async function issueReplay(command) {
    const request = ++S.replayRequest;
    const modeBoundary = command.action === 'seek' || command.action === 'live';
    if (modeBoundary) S.replayTransitionPending = true;
    S.replayBusy = true;
    A.renderChromeNow(REPLAY_BUSY_CHROME);
    try {
      const result = await AU.replay(command);
      if (request !== S.replayRequest) return;
      adoptReplayResult(result, modeBoundary);
    } catch (error) {
      if (request === S.replayRequest) AUR.log('replay command failed', error && error.message);
    } finally {
      if (request === S.replayRequest) {
        S.replayTransitionPending = false;
        S.replayBusy = false;
        S.historyPreviewTs = null;
        const queued = S.transitionEventQueue;
        S.transitionEventQueue = [];
        for (const packet of queued) A.handleSequencedEvents(packet.batch, packet.meta);
        A.renderChromeNow(REPLAY_BUSY_CHROME);
      }
    }
  };
})();

// app-playback.js — epoch/playback/replay helpers, live/history controls, history test metrics.
'use strict';

(function () {
  const AUR = window.AUR;
  const AU = window.AU;
  const A = AUR.app;               // created by app-state.js; throw if missing
  if (!A) throw new Error('app-state.js must load before app-playback.js');
  const S = A.state, C = A.const;

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

  A.seedStore = function seedStore(snap) {
    S.store.projects.clear();
    S.store.ships.clear();
    S.store.feed = [];
    if (snap && Array.isArray(snap.projects)) {
      for (const p of snap.projects) S.store.projects.set(p.id, p);
    }
    if (snap && Array.isArray(snap.ships)) {
      for (const s of snap.ships) S.store.ships.set(s.id, s);
    }
    if (snap && Array.isArray(snap.feed)) {
      S.store.feed = snap.feed.slice(-C.FEED_CAP);
    }
  };

  function finiteField(value, names, fallback) {
    for (const name of names) {
      if (value && Number.isFinite(value[name])) return value[name];
    }
    return fallback;
  }

  function normalizePlayback(value) {
    if (!value || typeof value !== 'object') return S.playback;
    const minTs = finiteField(value, ['minTs', 'startTs', 'start'], S.playback.minTs);
    const maxTs = finiteField(value, ['maxTs', 'endTs', 'end'], S.playback.maxTs);
    let cursorTs = finiteField(value, ['cursorTs', 'cursor', 'ts'], S.playback.cursorTs);
    const stateWord = typeof value.state === 'string' ? value.state.toLowerCase() : '';
    let mode = value.mode === 'replay' || value.mode === 'live' ? value.mode : S.playback.mode;
    if (stateWord === 'live') mode = 'live';
    else if (!value.mode && (stateWord === 'playing' || stateWord === 'paused')) mode = 'replay';
    if (mode === 'live' && Number.isFinite(maxTs)) cursorTs = maxTs;
    const requestedSpeed = Number(value.speed);
    const speed = C.REPLAY_SPEEDS.includes(requestedSpeed) ? requestedSpeed : S.playback.speed;
    const available = typeof value.available === 'boolean'
      ? value.available
      : (Number.isFinite(minTs) && Number.isFinite(maxTs) && maxTs >= minTs);
    const playingValue = typeof value.playing === 'boolean'
      ? value.playing : stateWord === 'playing';
    return {
      mode,
      available,
      indexing: typeof value.indexing === 'boolean' ? value.indexing : S.playback.indexing,
      minTs,
      maxTs,
      cursorTs,
      playing: mode === 'replay' && playingValue,
      speed,
      truncated: typeof value.truncated === 'boolean' ? value.truncated : S.playback.truncated,
    };
  }

  A.applyPlayback = function applyPlayback(value, updateChrome = true) {
    if (value && typeof value === 'object') S.playback = normalizePlayback(value);
    if (updateChrome) {
      A.renderHistory();
      A.renderFeed();
      A.renderProjectCard();
      A.renderProjectSettings();
      A.renderIdeas();
    }
  };

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

  function adoptReplayResult(result, forceReset) {
    if (!result || typeof result !== 'object') return;
    const snap = result.snapshot && typeof result.snapshot === 'object' ? result.snapshot : null;
    const nextPlayback = result.playback || (snap && snap.playback);
    // Set replay mode before any historical ship update can consider desktop
    // notifications. Historical attention stays visible but never pages.
    A.applyPlayback(nextPlayback, false);

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
    A.renderHistory();
    A.renderFeed();
    A.renderProjectCard();
  }

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

  async function issueReplay(command) {
    const request = ++S.replayRequest;
    const modeBoundary = command.action === 'seek' || command.action === 'live';
    if (modeBoundary) S.replayTransitionPending = true;
    S.replayBusy = true;
    A.renderHistory();
    A.renderProjectCard();
    A.renderAgentFocus();
    A.renderProjectSettings();
    A.renderIdeas();
    try {
      const result = await AU.replay(command);
      if (request !== S.replayRequest) return;
      const forceReset = command.action === 'seek' || command.action === 'live';
      adoptReplayResult(result, forceReset);
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
        A.renderHistory();
        A.renderProjectCard();
        A.renderAgentFocus();
        A.renderProjectSettings();
        A.renderIdeas();
      }
    }
  }

  // ---------- live/history controls ----------
  A.wireHistoryBar = function wireHistoryBar() {
    S.historyEls = {
      bar: document.getElementById('history-bar'),
      play: document.getElementById('history-play'),
      speed: document.getElementById('history-speed'),
      scrubber: document.getElementById('history-scrubber'),
      time: document.getElementById('history-time'),
      context: document.getElementById('history-context'),
      start: document.getElementById('history-start'),
      end: document.getElementById('history-end'),
      markers: document.getElementById('history-markers'),
      projectEvent: document.getElementById('history-project-event'),
      live: document.getElementById('history-live'),
      feedMode: document.getElementById('feed-mode'),
      feedLabel: document.getElementById('feed-mode-label'),
    };
    if (!S.historyEls.bar || !S.historyEls.play || !S.historyEls.speed ||
        !S.historyEls.scrubber || !S.historyEls.time || !S.historyEls.live) return;

    S.historyEls.play.addEventListener('click', () => {
      if (S.playback.mode !== 'replay' || !S.playback.available) return;
      issueReplay({ action: S.playback.playing ? 'pause' : 'play' });
    });
    S.historyEls.speed.addEventListener('click', () => {
      if (S.playback.mode !== 'replay' || !S.playback.available) return;
      const index = Math.max(0, C.REPLAY_SPEEDS.indexOf(S.playback.speed));
      const speed = C.REPLAY_SPEEDS[(index + 1) % C.REPLAY_SPEEDS.length];
      issueReplay({ action: 'speed', speed });
    });
    S.historyEls.scrubber.addEventListener('input', () => {
      const started = performance.now();
      S.historyPerf.inputEvents++;
      S.historyPendingPreviewTs = historyTimestampFromPosition(S.historyEls.scrubber.value);
      if (S.historyPreviewFrame === null) {
        S.historyPreviewFrame = requestAnimationFrame(flushHistoryPreview);
      }
      S.historyPerf.maxInputHandlerMs = Math.max(
        S.historyPerf.maxInputHandlerMs, performance.now() - started
      );
    });
    S.historyEls.scrubber.addEventListener('change', () => {
      S.historyPendingPreviewTs = historyTimestampFromPosition(S.historyEls.scrubber.value);
      flushHistoryPreview();
      if (Number.isFinite(S.historyPreviewTs) && !S.replayBusy) {
        S.historyPerf.seekRequests++;
        issueReplay({ action: 'seek', ts: S.historyPreviewTs });
      }
    });
    S.historyEls.live.addEventListener('click', () => {
      if (S.playback.mode !== 'live') issueReplay({ action: 'live' });
    });
    A.renderHistory();
  };

  let historyTimeFormatter = null;
  let historyEdgeFormatter = null;
  try {
    historyTimeFormatter = new Intl.DateTimeFormat(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit',
    });
    historyEdgeFormatter = new Intl.DateTimeFormat(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch (error) { /* ISO fallbacks below preserve older platforms */ }

  function formatHistoryTime(ts) {
    if (!Number.isFinite(ts)) return '—';
    try {
      return historyTimeFormatter
        ? historyTimeFormatter.format(new Date(ts)) : new Date(ts).toISOString();
    } catch (error) {
      return new Date(ts).toISOString();
    }
  }

  function formatHistoryEdge(ts) {
    if (!Number.isFinite(ts)) return '—';
    try {
      return historyEdgeFormatter
        ? historyEdgeFormatter.format(new Date(ts)) : new Date(ts).toISOString();
    } catch (error) {
      return new Date(ts).toISOString();
    }
  }

  function historyTimestampFromPosition(value) {
    if (!Number.isFinite(S.playback.minTs) || !Number.isFinite(S.playback.maxTs)) return null;
    const position = AUR.clamp(Number(value) || 0, 0, C.HISTORY_SLIDER_MAX);
    const ratio = position / C.HISTORY_SLIDER_MAX;
    return S.playback.minTs + (S.playback.maxTs - S.playback.minTs) * ratio;
  }

  function historyPositionFromTimestamp(ts) {
    if (!Number.isFinite(ts) || !Number.isFinite(S.playback.minTs) ||
        !Number.isFinite(S.playback.maxTs) || S.playback.maxTs <= S.playback.minTs) {
      return C.HISTORY_SLIDER_MAX;
    }
    return AUR.clamp(
      ((ts - S.playback.minTs) / (S.playback.maxTs - S.playback.minTs)) * C.HISTORY_SLIDER_MAX,
      0,
      C.HISTORY_SLIDER_MAX
    );
  }

  function setHistoryTimestamp(ts, label = null) {
    if (!S.historyEls || !S.historyEls.time) return;
    const text = label || formatHistoryTime(ts);
    S.historyEls.time.textContent = text;
    if (Number.isFinite(ts)) {
      const iso = new Date(ts).toISOString();
      S.historyEls.time.dateTime = iso;
      S.historyEls.time.title = (S.playback.truncated ? 'Indexed range truncated · ' : '') + iso;
      S.historyEls.scrubber.setAttribute('aria-valuetext', text);
    } else {
      S.historyEls.time.removeAttribute('datetime');
      S.historyEls.time.title = '';
      S.historyEls.scrubber.removeAttribute('aria-valuetext');
    }
  }

  function flushHistoryPreview() {
    if (S.historyPreviewFrame !== null) cancelAnimationFrame(S.historyPreviewFrame);
    S.historyPreviewFrame = null;
    const ts = S.historyPendingPreviewTs;
    S.historyPendingPreviewTs = null;
    if (!Number.isFinite(ts)) return;
    S.historyPreviewTs = ts;
    S.historyPerf.previewFrames++;
    const position = historyPositionFromTimestamp(ts);
    S.historyEls.bar.style.setProperty('--history-progress', `${position / 100}%`);
    setHistoryTimestamp(ts);
  }

  function renderHistoryMarkers(hasRange) {
    if (!S.historyEls.markers || !S.historyEls.projectEvent) return;
    const projects = [...S.store.projects.values()]
      .filter((project) => Number.isFinite(project.firstSeen))
      .sort((a, b) => a.firstSeen - b.firstSeen || a.id.localeCompare(b.id));
    const visible = projects.slice(-C.HISTORY_MARKER_LIMIT);
    const key = `${S.playback.minTs}:${S.playback.maxTs}:${S.playback.mode}:` +
      visible.map((project) => (
        `${project.id}:${project.firstSeen}:${S.liveProjectEvents.has(project.id)}`
      )).join('|');
    if (key === S.historyMarkerKey) return;
    S.historyMarkerKey = key;
    AUR.clear(S.historyEls.markers);
    if (!hasRange) {
      S.historyEls.projectEvent.textContent = '';
      S.historyEls.projectEvent.classList.add('hidden');
      return;
    }
    for (const project of visible) {
      const marker = document.createElement('span');
      const live = S.playback.mode === 'live' && S.liveProjectEvents.has(project.id);
      const position = historyPositionFromTimestamp(project.firstSeen);
      marker.className = 'history-marker' + (live ? ' new' : '');
      marker.style.left = `${position / 100}%`;
      marker.title = `${project.name} · ${formatHistoryTime(project.firstSeen)}`;
      S.historyEls.markers.appendChild(marker);
    }
    const newestLive = S.playback.mode === 'live'
      ? [...visible].sort((a, b) => (
        (S.liveProjectEvents.get(b.id) || 0) - (S.liveProjectEvents.get(a.id) || 0)
      )).find((project) => S.liveProjectEvents.has(project.id))
      : null;
    S.historyEls.projectEvent.textContent = newestLive ? `NEW SYSTEM · ${newestLive.name}` : '';
    S.historyEls.projectEvent.classList.toggle('hidden', !newestLive);
  }

  A.renderHistory = function renderHistory() {
    if (!S.historyEls || !S.historyEls.bar) return;
    const replayMode = S.playback.mode === 'replay';
    const hasRange = S.playback.available && Number.isFinite(S.playback.minTs) &&
      Number.isFinite(S.playback.maxTs);
    const busy = S.replayBusy || S.playback.indexing;
    const shownTs = Number.isFinite(S.historyPreviewTs)
      ? S.historyPreviewTs
      : (replayMode ? S.playback.cursorTs : S.playback.maxTs);

    S.historyEls.bar.dataset.mode = replayMode ? 'replay' : 'live';
    S.historyEls.bar.dataset.playing = String(Boolean(S.playback.playing));
    S.historyEls.bar.dataset.indexing = String(Boolean(S.playback.indexing));
    S.historyEls.bar.dataset.truncated = String(Boolean(S.playback.truncated));
    S.historyEls.bar.classList.toggle('busy', S.replayBusy);
    document.body.dataset.playbackMode = replayMode ? 'replay' : 'live';

    S.historyEls.play.textContent = S.playback.playing ? 'Pause' : 'Play';
    S.historyEls.play.setAttribute('aria-label', S.playback.playing ? 'Pause history' : 'Play history');
    S.historyEls.play.disabled = !replayMode || !hasRange || busy;
    S.historyEls.speed.textContent = S.playback.speed + 'x';
    S.historyEls.speed.disabled = !replayMode || !hasRange || busy;
    S.historyEls.live.classList.toggle('active', !replayMode);
    S.historyEls.live.setAttribute('aria-pressed', String(!replayMode));
    S.historyEls.live.disabled = !replayMode || S.replayBusy;

    if (hasRange) {
      const fallback = replayMode ? S.playback.cursorTs : S.playback.maxTs;
      const value = Number.isFinite(shownTs) ? shownTs : fallback;
      const position = historyPositionFromTimestamp(value);
      S.historyEls.scrubber.value = String(position);
      S.historyEls.scrubber.dataset.minTs = String(S.playback.minTs);
      S.historyEls.scrubber.dataset.maxTs = String(S.playback.maxTs);
      S.historyEls.bar.style.setProperty('--history-progress', `${position / 100}%`);
      if (S.historyEls.start) {
        S.historyEls.start.textContent = formatHistoryEdge(S.playback.minTs);
        S.historyEls.start.dateTime = new Date(S.playback.minTs).toISOString();
      }
      if (S.historyEls.end) {
        S.historyEls.end.textContent = replayMode ? formatHistoryEdge(S.playback.maxTs) : 'LATEST';
        S.historyEls.end.dateTime = new Date(S.playback.maxTs).toISOString();
      }
    }
    S.historyEls.scrubber.disabled = !hasRange || busy;

    let label;
    if (Number.isFinite(S.historyPreviewTs)) label = formatHistoryTime(S.historyPreviewTs);
    else if (S.playback.indexing && !hasRange) label = 'INDEXING…';
    else if (!hasRange) label = 'NO HISTORY';
    else if (!replayMode) label = 'LIVE';
    else label = formatHistoryTime(S.playback.cursorTs);
    setHistoryTimestamp(shownTs, label);
    if (S.historyEls.context) {
      S.historyEls.context.textContent = replayMode ? 'HISTORY TIMELINE' : 'LIVE TIMELINE';
    }
    renderHistoryMarkers(hasRange);

    if (S.historyEls.feedMode && S.historyEls.feedLabel) {
      const feedState = replayMode ? (S.playback.playing ? 'replay' : 'paused') : 'live';
      S.historyEls.feedMode.className = 'panel-note feed-mode ' + feedState;
      S.historyEls.feedLabel.textContent = replayMode ? 'REPLAY' : 'LIVE';
    }
  };

  // ---------- history test metrics ----------
  // Compact, actual-DOM/scene evidence for the isolated Electron history
  // harness. This exposes measurements, never a second fake renderer state.
  function historyTestMetrics() {
    const bar = document.getElementById('history-bar');
    const rect = bar ? bar.getBoundingClientRect() : null;
    const visibleRect = (id) => {
      const element = document.getElementById(id);
      if (!element || element.classList.contains('hidden') ||
          getComputedStyle(element).display === 'none') return null;
      const value = element.getBoundingClientRect();
      return { left: value.left, top: value.top, right: value.right, bottom: value.bottom };
    };
    const overlaps = (a, b) => Boolean(a && b && a.left < b.right && a.right > b.left &&
      a.top < b.bottom && a.bottom > b.top);
    const barRect = rect
      ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
      : null;
    const overlapIds = ['sidebar', 'summary-card', 'tabbar', 'project-card', 'planet-card']
      .filter((id) => overlaps(barRect, visibleRect(id)));
    const scene = S.activeScene && !S.activeScene.isDisposed ? S.activeScene : null;
    let providerStats = null;
    let galaxyStats = null;
    try {
      if (scene && scene.metadata && typeof scene.metadata.providerStats === 'function') {
        providerStats = scene.metadata.providerStats();
      }
      if (scene && scene.metadata && typeof scene.metadata.galaxyStats === 'function') {
        galaxyStats = scene.metadata.galaxyStats();
      }
    } catch (error) { /* a render frame may be between layout passes */ }
    let liveSceneCount = 0;
    if (S.engine) {
      for (const item of S.engine.scenes || []) if (!item.isDisposed) liveSceneCount++;
    }
    return {
      streamEpoch: S.streamEpoch,
      playback: { ...S.playback },
      store: {
        projectCount: S.store.projects.size,
        shipCount: S.store.ships.size,
        feedCount: S.store.feed.length,
        totalBuilds: [...S.store.projects.values()]
          .reduce((sum, project) => sum + (Number(project.totalBuilds) || 0), 0),
        latestActivity: [...S.store.projects.values()]
          .reduce((latest, project) => Math.max(latest, Number(project.lastActivity) || 0), 0),
      },
      controls: {
        playText: S.historyEls && S.historyEls.play ? S.historyEls.play.textContent : '',
        speedText: S.historyEls && S.historyEls.speed ? S.historyEls.speed.textContent : '',
        timeText: S.historyEls && S.historyEls.time ? S.historyEls.time.textContent : '',
        livePressed: Boolean(S.historyEls && S.historyEls.live &&
          S.historyEls.live.getAttribute('aria-pressed') === 'true'),
        scrubberDisabled: Boolean(S.historyEls && S.historyEls.scrubber && S.historyEls.scrubber.disabled),
        scrubberValue: S.historyEls && S.historyEls.scrubber ? Number(S.historyEls.scrubber.value) : null,
        feedMode: S.historyEls && S.historyEls.feedLabel ? S.historyEls.feedLabel.textContent : '',
        contextText: S.historyEls && S.historyEls.context ? S.historyEls.context.textContent : '',
        startText: S.historyEls && S.historyEls.start ? S.historyEls.start.textContent : '',
        endText: S.historyEls && S.historyEls.end ? S.historyEls.end.textContent : '',
        markerCount: S.historyEls && S.historyEls.markers
          ? S.historyEls.markers.querySelectorAll('.history-marker').length : 0,
        newMarkerCount: S.historyEls && S.historyEls.markers
          ? S.historyEls.markers.querySelectorAll('.history-marker.new').length : 0,
        projectEventText: S.historyEls && S.historyEls.projectEvent
          ? S.historyEls.projectEvent.textContent : '',
      },
      performance: { ...S.historyPerf },
      dom: {
        agentRowCount: document.querySelectorAll('.agent-row').length,
        attentionRowCount: document.querySelectorAll('.agent-row.has-attention').length,
        providerTags: Array.from(document.querySelectorAll('.agent-provider-tag'))
          .map((item) => item.textContent.trim()),
      },
      scene: {
        view: scene && scene.metadata ? scene.metadata.view || null : null,
        liveSceneCount,
        providerStats,
        galaxyStats,
      },
      layout: {
        inViewport: Boolean(barRect && barRect.left >= 0 && barRect.top >= 0 &&
          barRect.right <= window.innerWidth && barRect.bottom <= window.innerHeight),
        overlapIds,
      },
    };
  }
  AUR.historyTestMetrics = historyTestMetrics;
})();

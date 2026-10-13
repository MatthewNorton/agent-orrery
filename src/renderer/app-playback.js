// @ts-check
// app-playback.js — the live/history bar: transport buttons, scrubber preview, project markers.
'use strict';

(function () {
  const AUR = window.AUR;
  const A = AUR.app;               // created by app-state.js; throw if missing
  if (!A) throw new Error('app-state.js must load before app-playback.js');
  const S = A.state, C = A.const;

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
      A.issueReplay({ action: S.playback.playing ? 'pause' : 'play' });
    });
    S.historyEls.speed.addEventListener('click', () => {
      if (S.playback.mode !== 'replay' || !S.playback.available) return;
      const index = Math.max(0, C.REPLAY_SPEEDS.indexOf(S.playback.speed));
      const speed = C.REPLAY_SPEEDS[(index + 1) % C.REPLAY_SPEEDS.length];
      A.issueReplay({ action: 'speed', speed });
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
        A.issueReplay({ action: 'seek', ts: S.historyPreviewTs });
      }
    });
    S.historyEls.live.addEventListener('click', () => {
      if (S.playback.mode !== 'live') A.issueReplay({ action: 'live' });
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
})();

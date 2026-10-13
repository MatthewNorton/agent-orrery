// @ts-check
// app-history-metrics.js — measurements the isolated Electron history harness reads.
'use strict';

(function () {
  const AUR = window.AUR;
  const A = AUR.app;               // created by app-state.js; throw if missing
  if (!A) throw new Error('app-state.js must load before app-history-metrics.js');
  const S = A.state;

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

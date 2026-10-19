// @ts-check
// Measurements the isolated Electron history harness reads.
'use strict';

(function () {
  const AUR = window.AUR;
  const A = AUR.app;
  if (!A) throw new Error('app/state.js must load before app/history-metrics.js');
  const S = A.state;

  // Compact, actual-DOM/scene evidence for the isolated Electron history
  // harness. This exposes measurements, never a second fake renderer state.
  function historyTestMetrics() {
    const bar = document.getElementById('history-bar');
    const edges = (element) => {
      const value = element.getBoundingClientRect();
      return { left: value.left, top: value.top, right: value.right, bottom: value.bottom };
    };
    const visibleRect = (id) => {
      const element = document.getElementById(id);
      if (!element || element.classList.contains('hidden') ||
          getComputedStyle(element).display === 'none') return null;
      return edges(element);
    };
    const overlaps = (a, b) => Boolean(a && b && a.left < b.right && a.right > b.left &&
      a.top < b.bottom && a.bottom > b.top);
    const barRect = bar ? edges(bar) : null;
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
    const els = S.historyEls || {};
    const textOf = (key) => (els[key] ? els[key].textContent : '');
    const markerCount = (selector) => (els.markers ? els.markers.querySelectorAll(selector).length : 0);
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
        playText: textOf('play'),
        speedText: textOf('speed'),
        timeText: textOf('time'),
        livePressed: Boolean(els.live && els.live.getAttribute('aria-pressed') === 'true'),
        scrubberDisabled: Boolean(els.scrubber && els.scrubber.disabled),
        scrubberValue: els.scrubber ? Number(els.scrubber.value) : null,
        feedMode: textOf('feedLabel'),
        contextText: textOf('context'),
        startText: textOf('start'),
        endText: textOf('end'),
        markerCount: markerCount('.history-marker'),
        newMarkerCount: markerCount('.history-marker.new'),
        projectEventText: textOf('projectEvent'),
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

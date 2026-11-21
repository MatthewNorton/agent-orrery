// @ts-check
// Boot, event routing, view switching. The routes that switch views are app/route.js.
'use strict';

/** @import { AUEvent, BatchMeta, ProjectVcsStatus, ProjectVcsStatusEvent } from '../../types/contract' */

(function () {
  const AUR = window.AUR;
  const AU = window.AU;
  const A = AUR.app;
  if (!A) throw new Error('app/state.js must load before app/boot.js');
  const S = A.state, C = A.const;

  // ---------- boot ----------
  async function boot() {
    S.canvas = document.getElementById('renderCanvas');
    S.engine = new BABYLON.Engine(S.canvas, true, {
      preserveDrawingBuffer: true, stencil: true, antialias: true,
    }, true);
    A.wireRenderQuality();
    A.wireScenery();
    A.wirePanels();
    S.engine.runRenderLoop(() => {
      if (S.activeScene && !S.activeScene.isDisposed) {
        try { S.activeScene.render(); } catch (e) { /* swallow transient swap frames */ }
      }
      if (S.agentFocus.shipId) {
        const now = performance.now();
        if (now - S.agentFocus.lastFlightUpdate >= 250) {
          S.agentFocus.lastFlightUpdate = now;
          A.renderAgentFocusFlightTarget();
        }
      }
    });
    const onChromeResize = () => {
      A.refitRails();
      A.applyRenderScale();
      S.engine.resize();
      if (S.activeView) S.activeView.resize();
    };
    window.addEventListener('resize', onChromeResize);
    const chromeObserver = new ResizeObserver(onChromeResize);
    for (const id of ['topbar', 'rail-left', 'sidebar', 'history-bar']) {
      const el = document.getElementById(id);
      if (el) chromeObserver.observe(el);
    }
    A.wireHistoryBar();
    A.wireModules();
    A.wireTasksPanel();
    A.wireIdeasPanel();
    A.wireCommandRail();
    A.wireAgentFocus();
    A.wireNeedsYou();
    A.startClock();
    A.wireProjectSearch();
    A.wireProjectDirectory();
    A.wireProjectSettings();
    A.wireKeys();

    // Subscribe before taking the snapshot. Every tracker event has a
    // monotonic sequence within its stream epoch, so batches racing the
    // snapshot can be reconciled without duplication or loss.
    AU.onEvents(routeEvents);
    AU.onReplayState(A.handleReplayState);
    AU.onTasksChanged(A.handleTasksChanged);
    AU.onRootTasksChanged(A.handleRootTasksChanged);
    AU.onProjectVcsStatusChanged(routeProjectVcsStatus);
    const snap = await AU.snapshot();
    A.seedStore(snap);
    S.streamEpoch = A.epochOf(snap);
    A.applyPlayback(snap && snap.playback, false);
    const cutoff = Number.isFinite(snap && snap.eventSequence) ? snap.eventSequence : -Infinity;
    S.lastEventSequence = cutoff;
    const queued = S.bootEventQueue;
    S.bootEventQueue = [];
    S.booting = false;
    for (const packet of queued) A.handleSequencedEvents(packet.batch, packet.meta);
    const queuedVcs = S.bootVcsQueue;
    S.bootVcsQueue = [];
    for (const packet of queuedVcs) routeProjectVcsStatus(packet.status, packet.meta);

    await AUR.loadLabelFonts();
    A.wireBackButton();
    A.showUniverse();
    A.refreshIdeas();
    S.ideaPanel.interval = setInterval(A.refreshIdeas, 5_000);
    A.renderChrome();

    AU.onDebugView(A.handleDebugView);
  }

  /**
   * @param {AUEvent[]} batch
   * @param {BatchMeta} meta
   */
  function routeEvents(batch, meta) {
    if (S.booting) S.bootEventQueue.push({ batch, meta });
    else if (S.replayTransitionPending) S.transitionEventQueue.push({ batch, meta });
    else A.handleSequencedEvents(batch, meta);
  }

  function vcsFreshness(status) {
    if (!status || typeof status !== 'object') return -Infinity;
    return Math.max(
      Number.isFinite(status.checkedAt) ? status.checkedAt : -Infinity,
      status.github && Number.isFinite(status.github.checkedAt)
        ? status.github.checkedAt : -Infinity
    );
  }

  /**
   * @param {ProjectVcsStatus} status
   * @param {BatchMeta} meta
   */
  function routeProjectVcsStatus(status, meta) {
    if (!status || typeof status.projectId !== 'string' ||
        (meta && meta.mode && meta.mode !== 'live')) return;
    if (S.booting) {
      S.bootVcsQueue.push({ status, meta });
      return;
    }
    const incomingEpoch = A.epochOf(meta);
    if (S.playback.mode !== 'live' ||
        (incomingEpoch != null && S.streamEpoch != null && !A.sameEpoch(incomingEpoch, S.streamEpoch))) return;
    const project = S.store.projects.get(status.projectId);
    if (!project || vcsFreshness(project.vcs) > vcsFreshness(status)) return;
    S.store.projects.set(status.projectId, { ...project, vcs: status });
    /** @type {ProjectVcsStatusEvent} */
    const event = { type: 'project-vcs-status', projectId: status.projectId, status };
    if (S.activeView) {
      try { S.activeView.update([event]); } catch (error) { AUR.log('VCS view update failed'); }
    }
    A.scheduleChrome(C.CHROME.PROJECT | C.CHROME.SEARCH | C.CHROME.DIRECTORY);
  }

  /**
   * @param {AUEvent[]} batch
   * @param {BatchMeta} meta
   */
  A.handleSequencedEvents = function handleSequencedEvents(batch, meta) {
    if (!Array.isArray(batch)) return;
    const incomingEpoch = A.epochOf(meta);
    if (incomingEpoch != null && S.streamEpoch != null && !A.sameEpoch(incomingEpoch, S.streamEpoch)) {
      if (!A.isRetiredEpoch(incomingEpoch)) {
        S.deferredEpochBatches.push({ batch, meta });
      }
      return;
    }
    if (S.streamEpoch == null && incomingEpoch != null) S.streamEpoch = incomingEpoch;
    const unseen = [];
    for (const ev of batch) {
      if (Number.isFinite(ev.seq)) {
        if (ev.seq <= S.lastEventSequence) continue;
        S.lastEventSequence = ev.seq;
      }
      unseen.push(ev);
    }
    if (unseen.length) handleEvents(unseen);
  };

  // ---------- event routing ----------
  /** @param {AUEvent[]} batch */
  function handleEvents(batch) {
    let chromeMask = 0;
    let recoveredRoute = null;
    for (const ev of batch) {
      // The seeded snapshot already contains every boot-time project before
      // queued events are reconciled. Checking store membership therefore
      // distinguishes a genuinely new live project even if its event arrives
      // around the end of renderer boot.
      if (ev.type === 'project-added' && ev.project && S.playback.mode === 'live' &&
          !S.store.projects.has(ev.project.id)) {
        S.liveProjectEvents.set(ev.project.id, Number.isFinite(ev.project.firstSeen)
          ? ev.project.firstSeen : Date.now());
        while (S.liveProjectEvents.size > C.HISTORY_MARKER_LIMIT) {
          S.liveProjectEvents.delete(S.liveProjectEvents.keys().next().value);
        }
      }
      const previous = ev.type === 'project-updated' && ev.project
        ? S.store.projects.get(ev.project.id) : null;
      A.applyEvent(ev);
      chromeMask |= A.chromeMaskFor(ev);
      if (previous && ev.type === 'project-updated' && previous.exists === false &&
          ev.project.exists === true &&
          S.current.view !== 'universe' && S.current.projectId === ev.project.id) {
        recoveredRoute = { ...S.current };
      }
    }
    if (S.activeView) {
      try { S.activeView.update(batch); } catch (e) { AUR.log('view update err', e && e.message); }
    }
    A.refreshShipHulls(A.workedShipIds(batch));
    if (S.agentFocus.shipId && !S.store.ships.has(S.agentFocus.shipId)) {
      A.exitAgentFocus(false);
    }
    // Project creation is rare and its live-region announcement should not
    // wait behind a busy scene/chrome animation frame.
    if (chromeMask & C.CHROME.HISTORY) A.renderHistory();
    A.scheduleChrome(chromeMask);
    if (recoveredRoute) queueMicrotask(() => A.rebuildRoute(recoveredRoute));
  }

  // ---------- view switching ----------
  // The extras a view may leave out (kit/SPEC.md view contract), as no-ops.
  const VIEW_DEFAULTS = {
    resize() {}, setQuality() {}, setSkyLook() {}, setOrbitRings() {}, setSearchMatches() {}, setShipFocus() {},
    focusShip: () => false, shipFocusState: () => null,
  };

  function makeCtx() {
    return {
      store: S.store, galaxyFields: S.galaxyFields, worldMaps: S.worldMaps, quality: S.renderQuality,
      skyLook: S.skyLook, orbitRings: S.orbitRings,
      openSystem: A.openSystem, openPlanet: A.openPlanet, defaultPanelRoom: A.defaultPanelRoom,
      // The stream a view's scene is shown in, null once another view has its place (kit/SPEC.md view contract).
      shown: (scene) => (S.activeScene === scene ? String(S.streamEpoch) : null),
    };
  }

  /** View `name` built from `data` takes the place of the one shown, with its route, or falls back (kit/SPEC.md view contract). */
  A.setView = function setView(name, data) {
    const factory = AUR.views[name];
    if (typeof factory !== 'function') {
      AUR.log('view factory missing:', name);
      if (name !== 'universe') return A.showUniverse();
      return;
    }
    let next;
    try {
      next = AUR.buildView(factory, S.engine, data, makeCtx());
    } catch (e) {
      AUR.log('view build failed:', name, e && e.message);
      if (name !== 'universe') return A.showUniverse();
      return;
    }
    for (const [key, fallback] of Object.entries(VIEW_DEFAULTS)) {
      if (typeof next[key] !== 'function') next[key] = fallback;
    }
    const old = S.activeView;
    A.clearProjectSearch();
    if (S.agentFocus.shipId) A.exitAgentFocus(false);
    S.activeView = next;
    S.activeScene = next.scene;
    Object.assign(S.current, A.viewRoute(name, data));
    document.body.dataset.view = name;
    A.stopTasksView();
    if (old) disposeSettled(old);
    A.renderChrome();
    if (name === 'system' && S.current.projectId) A.startTasksView(S.current.projectId);
    A.refreshProjectSearchFromStore();
  };

  function disposeSettled(view) {
    const scene = view.scene;
    const finish = () => { try { view.dispose(); } catch (e) { /* ignore */ } };
    const pending = scene && scene.environmentBRDFTexture;
    const settled = () => !pending || typeof pending.isReady !== 'function' || pending.isReady();
    if (settled()) return finish();
    try { if (typeof scene.detachControl === 'function') scene.detachControl(); } catch (e) { /* ignore */ }
    // Kit 13 (2026-09-28): keep this bounded poll. Babylon 9.28's onLoadObservable fires
    // when the RGBD image loads, BEFORE the async BRDF decode; the internal texture's
    // isReady() is the only completion signal, and an addOnce registered after the load
    // event never fires. Disposing during the decode throws inside Babylon (fast --shots
    // view switches reproduce it). Poll: 50 ms steps, 4 s bound, then dispose regardless.
    let waited = 0;
    const tick = () => {
      if (settled() || waited >= 4000) return finish();
      waited += 50;
      setTimeout(tick, 50);
    };
    setTimeout(tick, 50);
  }

  // ---------- go ----------
  boot().catch((e) => {
    console.error('[boot-failure]', e && e.message ? e.message : e);
  });
})();

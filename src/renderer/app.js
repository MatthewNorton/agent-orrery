// @ts-check
// app.js — boot, event routing, view switching, debug hooks.
'use strict';

/**
 * @import { AUEvent, BatchMeta, DebugView, PlanetData, ProjectVcsStatus, ProjectVcsStatusEvent,
 *   SystemData } from '../types/contract'
 */

(function () {
  const AUR = window.AUR;
  const AU = window.AU;
  const A = AUR.app;               // created by app-state.js; throw if missing
  if (!A) throw new Error('app-state.js must load before app.js');
  const S = A.state, C = A.const;

  // ---------- boot ----------
  async function boot() {
    S.canvas = document.getElementById('renderCanvas');
    S.engine = new BABYLON.Engine(S.canvas, true, {
      preserveDrawingBuffer: true, stencil: true, antialias: true,
    }, true);
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
      S.engine.resize();
      if (S.activeView && S.activeView.resize) S.activeView.resize();
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

    // Dev self-check: our copied hash must be bit-exact with the tracker's.
    for (const p of S.store.projects.values()) {
      if (AUR.fnv1a(p.id) !== p.seed) {
        AUR.log('WARN fnv1a mismatch for', p.id, AUR.fnv1a(p.id), 'vs', p.seed);
      }
      break;
    }

    await AUR.loadLabelFonts();
    wireBackButton();
    A.showUniverse();
    A.refreshIdeas();
    S.ideaPanel.interval = setInterval(A.refreshIdeas, 5_000);
    A.renderChrome();

    AU.onDebugView(handleDebugView);
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
    if (S.activeView && typeof S.activeView.update === 'function') {
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
    if (!Array.isArray(batch) || batch.length === 0) return;
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
    if (S.activeView && S.activeView.update) {
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
  function makeCtx() {
    return { store: S.store, openSystem: A.openSystem, openPlanet: A.openPlanet };
  }

  function setView(name, data) {
    const factory = AUR.views[name];
    if (typeof factory !== 'function') {
      AUR.log('view factory missing:', name);
      if (name !== 'universe') return A.showUniverse();
      return;
    }
    let next;
    try {
      next = factory(S.engine, data, makeCtx());
    } catch (e) {
      AUR.log('view build failed:', name, e && e.message);
      if (name !== 'universe') return A.showUniverse();
      return;
    }
    const old = S.activeView;
    A.clearProjectSearch();
    if (S.agentFocus.shipId) A.exitAgentFocus(false);
    S.activeView = next;
    S.activeScene = next.scene;
    S.current.view = name;
    document.body.dataset.view = name;
    A.stopTasksView();
    if (old && old.dispose) disposeSettled(old);
    A.renderChrome();
    if (name === 'system' && S.current.projectId) A.startTasksView(S.current.projectId);
    A.refreshProjectSearchFromStore();
  }

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

  A.showUniverse = function showUniverse() {
    S.routeRequestGeneration++;
    S.current.view = 'universe';
    S.current.projectId = null;
    S.current.planetName = null;
    setView('universe', { store: S.store });
  };

  A.openSystem = async function openSystem(projectId) {
    const request = ++S.routeRequestGeneration;
    const requestedEpoch = S.streamEpoch;
    /** @type {SystemData} */
    let data = null;
    try { data = await AU.getSystem(projectId); } catch (e) { AUR.log('getSystem err', e && e.message); }
    if (request !== S.routeRequestGeneration || !A.sameEpoch(requestedEpoch, S.streamEpoch)) return;
    S.current.projectId = projectId;
    S.current.planetName = null;
    if (!data) { AUR.log('no system data for', projectId); return A.showUniverse(); }
    setView('system', { system: data, projectId, store: S.store });
  };

  A.openPlanet = async function openPlanet(projectId, name) {
    const request = ++S.routeRequestGeneration;
    const requestedEpoch = S.streamEpoch;
    /** @type {PlanetData} */
    let data = null;
    try { data = await AU.getPlanet(projectId, name); } catch (e) { AUR.log('getPlanet err', e && e.message); }
    if (request !== S.routeRequestGeneration || !A.sameEpoch(requestedEpoch, S.streamEpoch)) return;
    S.current.projectId = projectId;
    S.current.planetName = name;
    if (!data) { AUR.log('no planet data for', projectId, name); return A.openSystem(projectId); }
    setView('planet', { planet: data, projectId, name, store: S.store });
  };

  function back() {
    if (S.current.view === 'planet' && S.current.projectId) A.openSystem(S.current.projectId);
    else A.showUniverse();
  }

  // Direct project links (feed, recent, task views) jump to the system. Agent
  // rows use the first-person focus flow below.
  A.jumpToProject = function jumpToProject(projectId) {
    if (!projectId || !S.store.projects.has(projectId)) return;
    if (S.current.view === 'system' && S.current.projectId === projectId) return;
    A.openSystem(projectId);
  };

  function wireBackButton() {
    const btn = document.getElementById('back-btn');
    btn.addEventListener('click', back);
  }

  // ---------- debug / shots ----------
  function pickDemoProject() {
    let best = null;
    for (const p of S.store.projects.values()) {
      if (!p.exists) continue;
      if (!best || p.lastActivity > best.lastActivity) best = p;
    }
    if (best) return best;
    // fallback: any project at all
    for (const p of S.store.projects.values()) return p;
    return null;
  }

  function largestPlanet(planets) {
    if (!planets || !planets.length) return null;
    let best = planets[0];
    let bestScore = (best.files || 0) + (best.builds || 0) * 5;
    for (const p of planets) {
      const s = (p.files || 0) + (p.builds || 0) * 5;
      if (s > bestScore) { best = p; bestScore = s; }
    }
    return best;
  }

  /** @param {DebugView} view */
  async function handleDebugView(view) {
    try {
      if (view === 'system') {
        const p = pickDemoProject();
        if (p) await A.openSystem(p.id);
      } else if (view === 'planet') {
        const p = pickDemoProject();
        if (p) {
          /** @type {SystemData} */
          let sys = null;
          try { sys = await AU.getSystem(p.id); } catch (e) { /* fall through */ }
          const planet = sys ? largestPlanet(sys.planets) : null;
          if (planet) await A.openPlanet(p.id, planet.name);
        }
      } else {
        if (S.current.view !== 'universe') A.showUniverse();
      }
    } catch (e) {
      AUR.log('debug-view handling issue:', view, e && e.message);
    }
    signalReadyOnce();
  }

  // Fire AU.debugReady() exactly once, after the active scene is ready and has
  // rendered one frame. Never from a recurring observable.
  function signalReadyOnce() {
    const scene = S.activeScene;
    if (!scene || scene.isDisposed) { AU.debugReady(); return; }
    scene.executeWhenReady(() => {
      if (scene.isDisposed) { AU.debugReady(); return; }
      scene.onAfterRenderObservable.addOnce(() => AU.debugReady());
    });
  }

  // ---------- go ----------
  boot().catch((e) => {
    console.error('[boot-failure]', e && e.message ? e.message : e);
  });
})();

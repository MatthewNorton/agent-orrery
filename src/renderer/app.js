// app.js — boot, view stack, event routing, overlay DOM chrome, debug hooks.
'use strict';

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
    window.addEventListener('resize', () => {
      S.engine.resize();
      A.positionTasksPanel();
    });
    A.wireHistoryBar();
    wireTasksPanel();
    wireIdeasPanel();
    A.wireCommandRail();
    A.wireAgentFocus();
    A.wireProjectSearch();
    A.wireProjectDirectory();
    A.wireProjectSettings();

    // Subscribe before taking the snapshot. Every tracker event has a
    // monotonic sequence within its stream epoch, so batches racing the
    // snapshot can be reconciled without duplication or loss.
    AU.onEvents(routeEvents);
    AU.onReplayState(A.handleReplayState);
    AU.onTasksChanged(handleTasksChanged);
    AU.onRootTasksChanged(handleRootTasksChanged);
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

    wireBackButton();
    A.showUniverse();
    refreshIdeas();
    S.ideaPanel.interval = setInterval(refreshIdeas, 5_000);
    A.renderChrome();

    AU.onDebugView(handleDebugView);
  }

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
    const event = { type: 'project-vcs-status', projectId: status.projectId, status };
    if (S.activeView && typeof S.activeView.update === 'function') {
      try { S.activeView.update([event]); } catch (error) { AUR.log('VCS view update failed'); }
    }
    scheduleChrome(CHROME_PROJECT | CHROME_SEARCH | CHROME_DIRECTORY);
  }

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
      applyEvent(ev);
      chromeMask |= chromeMaskFor(ev);
      if (previous && previous.exists === false && ev.project.exists === true &&
          S.current.view !== 'universe' && S.current.projectId === ev.project.id) {
        recoveredRoute = { ...S.current };
      }
    }
    if (S.activeView && S.activeView.update) {
      try { S.activeView.update(batch); } catch (e) { AUR.log('view update err', e && e.message); }
    }
    if (S.agentFocus.shipId && !S.store.ships.has(S.agentFocus.shipId)) {
      A.exitAgentFocus(false);
    }
    // Project creation is rare and its live-region announcement should not
    // wait behind a busy scene/chrome animation frame.
    if (chromeMask & CHROME_HISTORY) A.renderHistory();
    scheduleChrome(chromeMask);
    if (recoveredRoute) queueMicrotask(() => A.rebuildRoute(recoveredRoute));
  }

  const CHROME_AGENTS = 1 << 0;
  const CHROME_FEED = 1 << 1;
  const CHROME_SUMMARY = 1 << 2;
  const CHROME_PROJECT = 1 << 3;
  const CHROME_PLANET = 1 << 4;
  const CHROME_RECENT = 1 << 5;
  const CHROME_SEARCH = 1 << 6;
  const CHROME_SETTINGS = 1 << 7;
  const CHROME_DIRECTORY = 1 << 8;
  const CHROME_IDEAS = 1 << 9;
  const CHROME_FOCUS = 1 << 10;
  const CHROME_HISTORY = 1 << 11;

  function chromeMaskFor(ev) {
    if (ev.type === 'ship-spawned' || ev.type === 'ship-updated' || ev.type === 'ship-departed') {
      return CHROME_AGENTS | CHROME_SUMMARY | CHROME_PROJECT | CHROME_PLANET |
        CHROME_RECENT | CHROME_SEARCH | CHROME_DIRECTORY | CHROME_FOCUS;
    }
    if (ev.type === 'project-added' || ev.type === 'project-updated') {
      const projectChrome = CHROME_AGENTS | CHROME_FEED | CHROME_SUMMARY | CHROME_PROJECT |
        CHROME_RECENT | CHROME_SEARCH | CHROME_SETTINGS | CHROME_DIRECTORY | CHROME_IDEAS;
      return ev.type === 'project-added' ? projectChrome | CHROME_HISTORY : projectChrome;
    }
    if (ev.type === 'feed') return CHROME_FEED;
    if (ev.type === 'build') return CHROME_SUMMARY | CHROME_PROJECT | CHROME_PLANET;
    return 0;
  }

  function applyEvent(ev) {
    switch (ev.type) {
      case 'project-added':
      case 'project-updated':
        S.store.projects.set(ev.project.id, ev.project);
        break;
      case 'ship-spawned':
        S.store.ships.set(ev.ship.id, ev.ship);
        break;
      case 'ship-updated': {
        const previous = S.store.ships.get(ev.ship.id);
        maybeNotifyAttention(previous ? previous.attention : null, ev.ship);
        S.store.ships.set(ev.ship.id, ev.ship);
        break;
      }
      case 'ship-departed':
        S.store.ships.delete(ev.shipId);
        S.notificationByShip.delete(ev.shipId);
        break;
      case 'feed':
        S.store.feed.push(ev.entry);
        if (S.store.feed.length > C.FEED_CAP) S.store.feed = S.store.feed.slice(-C.FEED_CAP);
        break;
      case 'build': {
        const p = S.store.projects.get(ev.project);
        if (p) p.totalBuilds = (p.totalBuilds || 0) + 1;
        break;
      }
      default: break;
    }
  }

  function maybeNotifyAttention(previousAttention, ship) {
    const entered = ship && (ship.attention === 'question' || ship.attention === 'permission');
    if (S.playback.mode !== 'live' || previousAttention != null || !entered ||
        typeof window.Notification !== 'function') return;

    const now = Date.now();
    const lastForShip = S.notificationByShip.get(ship.id) ?? -Infinity;
    if (now - lastForShip < C.NOTIFICATION_SHIP_THROTTLE_MS ||
        now - S.lastNotificationAt < C.NOTIFICATION_GLOBAL_THROTTLE_MS) return;

    const meta = AUR.attentionMeta(ship.attention);
    if (!meta) return;
    try {
      new window.Notification(ship.name + ' needs you', {
        body: meta.label + ' · ' + A.projectName(ship.project),
      });
      S.notificationByShip.set(ship.id, now);
      S.lastNotificationAt = now;
    } catch (e) { /* notifications are best-effort */ }
  }

  // ---------- view switching ----------
  function makeCtx() {
    return { store: S.store, openSystem: A.openSystem, openPlanet: A.openPlanet, back };
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
    if (name !== 'universe') A.clearProjectSearch();
    if (S.agentFocus.shipId) A.exitAgentFocus(false);
    S.activeView = next;
    S.activeScene = next.scene;
    S.current.view = name;
    stopTasksView();
    if (old && old.dispose) disposeSettled(old);
    A.renderChrome();
    if (name === 'system' && S.current.projectId) startTasksView(S.current.projectId);
    if (name === 'universe') A.refreshProjectSearchFromStore();
  }

  // Babylon decodes the lazily created PBR BRDF lookup (any GLB hull triggers it)
  // through a post-process whose compile callback dereferences the owning scene.
  // Disposing the scene while that decode is still pending throws inside Babylon,
  // which fast --shots view switches reproduce. Detach input at once, then dispose
  // as soon as the lookup is ready or after a bounded wait.
  function disposeSettled(view) {
    const scene = view.scene;
    const finish = () => { try { view.dispose(); } catch (e) { /* ignore */ } };
    const pending = scene && scene.environmentBRDFTexture;
    const settled = () => !pending || typeof pending.isReady !== 'function' || pending.isReady();
    if (settled()) return finish();
    try { if (typeof scene.detachControl === 'function') scene.detachControl(); } catch (e) { /* ignore */ }
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
    A.clearProjectSearch();
    const request = ++S.routeRequestGeneration;
    const requestedEpoch = S.streamEpoch;
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

  async function handleDebugView(view) {
    try {
      if (view === 'system') {
        const p = pickDemoProject();
        if (p) await A.openSystem(p.id);
      } else if (view === 'planet') {
        const p = pickDemoProject();
        if (p) {
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

  // ---------- overlay chrome ----------
  let chromePending = false;
  let pendingChromeMask = 0;
  function scheduleChrome(mask) {
    pendingChromeMask |= mask;
    if (chromePending || pendingChromeMask === 0) return;
    chromePending = true;
    requestAnimationFrame(() => {
      chromePending = false;
      const next = pendingChromeMask;
      pendingChromeMask = 0;
      if (next & CHROME_AGENTS) A.renderAgents();
      if (next & CHROME_FEED) A.renderFeed();
      if (next & CHROME_SUMMARY) A.renderSummary();
      if (next & CHROME_PROJECT) A.renderProjectCard();
      if (next & CHROME_PLANET) A.renderPlanetCard();
      if (next & CHROME_RECENT) A.renderRecent();
      if (next & CHROME_SEARCH) A.refreshProjectSearchFromStore();
      if (next & CHROME_SETTINGS) A.renderProjectSettings();
      if (next & CHROME_DIRECTORY) A.refreshProjectDirectoryFromStore();
      if (next & CHROME_IDEAS) A.renderIdeas();
      if (next & CHROME_FOCUS) A.renderAgentFocus();
      if (next & CHROME_HISTORY) A.renderHistory();
    });
  }

  A.renderChrome = function renderChrome() {
    A.renderAgents();
    A.renderFeed();
    A.renderSummary();
    A.renderProjectCard();
    A.renderPlanetCard();
    A.renderTabbar();
    A.renderBackButton();
    A.renderRecent();
    A.renderProjectSearchVisibility();
    A.renderProjectDirectory();
    A.renderProjectSettings();
    A.renderIdeas();
    A.renderHistory();
    A.renderAgentFocus();
  };

  // ---------- root task ideas ----------
  function wireIdeasPanel() {
    S.ideaPanel.els = {
      panel: document.getElementById('ideas-panel'),
      count: document.getElementById('ideas-count'),
      list: document.getElementById('ideas-list'),
      form: document.getElementById('ideas-form'),
      input: document.getElementById('ideas-input'),
      create: document.getElementById('ideas-create'),
      status: document.getElementById('ideas-status'),
    };
    const els = S.ideaPanel.els;
    if (!els.panel || !els.count || !els.list || !els.form || !els.input ||
        !els.create || !els.status) return;
    els.form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = els.input.value.trim();
      if (!text || S.ideaPanel.busy || S.playback.mode !== 'live') return;
      mutateIdea(() => AU.rootTaskCreate(text), 'Idea created', true);
    });
  }

  function handleRootTasksChanged() {
    if (S.ideaPanel.busy) {
      S.ideaPanel.refreshAfterBusy = true;
      return;
    }
    refreshIdeas();
  }

  function rootTaskItemsFrom(result) {
    if (!result || !Array.isArray(result.items)) return [];
    return result.items.filter((item) => item && typeof item.id === 'string' &&
      typeof item.text === 'string' && typeof item.phase === 'string' &&
      Number.isFinite(item.createdAt)).map((item) => ({
      id: item.id,
      text: item.text,
      projectId: typeof item.projectId === 'string' ? item.projectId : null,
      phase: item.phase,
      createdAt: item.createdAt,
      updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : item.createdAt,
    })).sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
  }

  async function refreshIdeas() {
    if (!S.ideaPanel.els || S.ideaPanel.busy) {
      if (S.ideaPanel.busy) S.ideaPanel.refreshAfterBusy = true;
      return;
    }
    const request = ++S.ideaPanel.request;
    let result = null;
    try { result = await AU.rootTasksGet(); } catch (error) { /* retain the last good list */ }
    if (request !== S.ideaPanel.request || !result) return;
    S.ideaPanel.items = rootTaskItemsFrom(result);
    A.renderIdeas();
  }

  function liveIdeaProjects() {
    return [...S.store.projects.values()]
      .filter((project) => project && project.exists === true)
      .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)) ||
        String(a.id).localeCompare(String(b.id)));
  }

  function ideaPhaseMeta(phase) {
    if (phase === 'ready-for-review') return { label: 'Ready for review', css: 'ready-for-review' };
    if (phase === 'agent-working' || phase === 'waiting-for-agent' || phase === 'running') {
      return { label: 'Agent working', css: 'working' };
    }
    if (phase === 'launch-requested') return { label: 'Start requested', css: 'working' };
    if (phase === 'launch-failed') return { label: 'Start failed', css: 'failed' };
    if (phase === 'agent-aborted') return { label: 'Agent stopped', css: 'failed' };
    if (phase === 'agent-departed') return { label: 'Agent lost', css: 'failed' };
    if (phase === 'agent-not-found') return { label: 'Agent not found', css: 'failed' };
    if (phase === 'completion-failed') return { label: 'Completion failed', css: 'failed' };
    if (phase === 'prepared' || phase === 'goal-written') return { label: 'Assigned', css: '' };
    if (phase === 'reopened') return { label: 'Reopened', css: '' };
    return { label: 'Idea', css: '' };
  }

  function retryableIdeaPhase(phase) {
    return phase === 'launch-failed' || phase === 'agent-aborted' ||
      phase === 'agent-departed' || phase === 'agent-not-found' ||
      phase === 'prepared' || phase === 'goal-written' || phase === 'reopened';
  }

  function ideaRenderKey(items, projects) {
    const itemState = items.map((item) => [
      item.id, item.projectId, item.phase, item.createdAt, item.updatedAt,
    ]);
    const projectState = projects.map((project) => [
      project.id, project.name, project.path, A.projectGalaxyLabel(project), project.exists,
    ]);
    return JSON.stringify([S.ideaPanel.visibleLimit, itemState, projectState]);
  }

  function retryIdeaCopy(phase) {
    if (phase === 'prepared') return 'Assignment needs to resume before the goal is confirmed';
    if (phase === 'goal-written') return 'Goal is ready in GOALS.md';
    if (phase === 'reopened') return 'Goal was reopened after review';
    return 'Goal remains in GOALS.md';
  }

  function ideaMutationsDisabled() {
    return S.ideaPanel.busy || S.playback.mode !== 'live' || S.replayTransitionPending;
  }

  function ideaFocusedControl(list) {
    const active = document.activeElement;
    if (!active || !list.contains(active)) {
      return { id: null, action: null, scrollTop: list.scrollTop };
    }
    const row = active.closest('.idea-row');
    return {
      id: row ? row.dataset.ideaId : null,
      action: active.dataset.ideaAction || null,
      scrollTop: list.scrollTop,
    };
  }

  function ideaRowById(list, id) {
    if (!id) return null;
    return [...list.querySelectorAll('.idea-row')]
      .find((row) => row.dataset.ideaId === id) || null;
  }

  function restoreIdeaFocus(list, previous) {
    const requested = S.ideaPanel.focusAfterRender;
    S.ideaPanel.focusAfterRender = null;
    const targetState = requested || previous;
    if (previous && Number.isFinite(previous.scrollTop)) list.scrollTop = previous.scrollTop;
    if (!targetState) return;
    if (!targetState.id && targetState.action === 'idea-input') {
      if (S.ideaPanel.els && S.ideaPanel.els.input) {
        S.ideaPanel.els.input.focus({ preventScroll: true });
      }
      return;
    }
    if (!targetState.id && targetState.action === 'show-more') {
      const showMore = list.querySelector('[data-idea-action="show-more"]');
      if (showMore) showMore.focus({ preventScroll: true });
      return;
    }
    if (!targetState.id) return;
    const row = ideaRowById(list, targetState.id);
    if (!row) return;
    const controls = [...row.querySelectorAll('[data-idea-action]')];
    const target = controls.find((control) => control.dataset.ideaAction === targetState.action) ||
      row.querySelector('.idea-text');
    if (!target || typeof target.focus !== 'function') return;
    target.focus({ preventScroll: true });
    if (requested && requested.reveal && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'nearest' });
    }
  }

  function updateIdeaMutationControls(list, disabled, projectCount) {
    for (const row of list.querySelectorAll('.idea-row')) {
      const select = row.querySelector('.idea-select');
      const assign = row.querySelector('[data-idea-action="assign"]');
      const retry = row.querySelector('[data-idea-action="retry"]');
      const remove = row.querySelector('[data-idea-action="remove"]');
      if (select) select.disabled = disabled || projectCount === 0;
      if (assign) {
        assign.disabled = !select || !select.value;
        assign.setAttribute('aria-disabled', String(disabled));
      }
      if (retry) {
        retry.disabled = retry.dataset.unavailable === 'true';
        retry.setAttribute('aria-disabled', String(disabled));
      }
      if (remove) remove.disabled = disabled;
    }
  }

  A.renderIdeas = function renderIdeas() {
    const els = S.ideaPanel.els;
    if (!els || !els.panel) return;
    const projects = liveIdeaProjects();
    const replay = S.playback.mode !== 'live' || S.replayTransitionPending;
    const disabled = ideaMutationsDisabled();
    els.panel.classList.toggle('is-empty', S.ideaPanel.items.length === 0);
    els.panel.setAttribute('aria-busy', String(S.ideaPanel.busy));
    els.count.textContent = `${S.ideaPanel.items.length} idea${S.ideaPanel.items.length === 1 ? '' : 's'}`;
    if (S.commandRail.els && S.commandRail.els.ideasCompactCount) {
      S.commandRail.els.ideasCompactCount.textContent = String(S.ideaPanel.items.length);
    }
    const nextRenderKey = ideaRenderKey(S.ideaPanel.items, projects);
    if (nextRenderKey !== S.ideaPanel.renderKey) {
      const previousFocus = ideaFocusedControl(els.list);
      S.ideaPanel.renderKey = nextRenderKey;
      AUR.clear(els.list);
      if (S.ideaPanel.items.length === 0) {
        els.list.appendChild(AUR.el(
          'div', 'empty-note', 'Capture an idea, then assign it to a project'
        ));
      } else {
        const visibleItems = S.ideaPanel.items.slice(0, S.ideaPanel.visibleLimit);
        for (const item of visibleItems) {
          const row = AUR.el('article', 'idea-row');
          row.dataset.ideaId = item.id;
          const heading = AUR.el('div', 'idea-heading');
          const taskText = AUR.el('div', 'idea-text', item.text);
          taskText.id = `idea-text-${item.id}`;
          taskText.tabIndex = -1;
          heading.appendChild(taskText);
          const meta = ideaPhaseMeta(item.phase);
          heading.appendChild(AUR.el('span', `idea-phase ${meta.css}`.trim(), meta.label));
          if (item.phase === 'idea') {
            const remove = AUR.el('button', 'idea-remove', '×');
            remove.type = 'button';
            remove.dataset.ideaAction = 'remove';
            remove.setAttribute('aria-label', 'Remove idea');
            remove.setAttribute('aria-describedby', taskText.id);
            remove.title = 'Remove idea';
            remove.addEventListener('click', () => {
              if (ideaMutationsDisabled() ||
                  !confirmRemoval('Remove this unassigned idea?', item.text)) return;
              if (!ideaMutationsDisabled()) removeIdea(item);
            });
            heading.appendChild(remove);
          }
          row.appendChild(heading);

          const assigned = item.projectId ? S.store.projects.get(item.projectId) : null;
          const assignedAvailable = Boolean(assigned && assigned.exists === true);
          if (item.projectId) {
            row.appendChild(AUR.el(
              'div', 'idea-project', assignedAvailable
                ? assigned.name : 'Assigned project unavailable'
            ));
          }

          if (item.phase === 'idea') {
            const controls = AUR.el('div', 'idea-controls');
            const select = document.createElement('select');
            select.className = 'idea-select';
            select.dataset.ideaAction = 'select';
            select.setAttribute('aria-label', 'Project or star system');
            select.setAttribute('aria-describedby', taskText.id);
            select.appendChild(new Option('Choose project…', ''));
            for (const project of projects) {
              const name = project.name || project.id;
              const detail = A.projectSearchSubtitle(project);
              select.appendChild(new Option(detail ? `${name} — ${detail}` : name, project.id));
            }
            const selected = S.ideaPanel.selections.get(item.id) || '';
            if (projects.some((project) => project.id === selected)) select.value = selected;
            select.addEventListener('change', () => {
              S.ideaPanel.selections.set(item.id, select.value);
              action.disabled = !select.value;
            });
            const action = AUR.el('button', 'idea-action', 'Assign & start');
            action.type = 'button';
            action.dataset.ideaAction = 'assign';
            action.setAttribute('aria-describedby', taskText.id);
            action.addEventListener('click', () => {
              if (!ideaMutationsDisabled()) assignIdea(item.id, select.value);
            });
            controls.appendChild(select);
            controls.appendChild(action);
            row.appendChild(controls);
          } else if (retryableIdeaPhase(item.phase)) {
            const controls = AUR.el('div', 'idea-controls');
            controls.appendChild(AUR.el('span', 'idea-project', retryIdeaCopy(item.phase)));
            const retry = AUR.el('button', 'idea-action', 'Retry start');
            retry.type = 'button';
            retry.dataset.ideaAction = 'retry';
            retry.dataset.unavailable = String(!assignedAvailable);
            retry.setAttribute('aria-describedby', taskText.id);
            retry.addEventListener('click', () => {
              if (!ideaMutationsDisabled()) retryIdea(item.id);
            });
            controls.appendChild(retry);
            row.appendChild(controls);
          } else if (item.projectId &&
              (item.phase === 'ready-for-review' || item.phase === 'completion-failed')) {
            const controls = AUR.el('div', 'idea-controls');
            controls.appendChild(AUR.el('span', 'idea-project', 'Project task'));
            const view = AUR.el('button', 'idea-action', 'View project');
            view.type = 'button';
            view.dataset.ideaAction = 'view';
            view.setAttribute('aria-describedby', taskText.id);
            view.disabled = !assignedAvailable;
            view.addEventListener('click', () => A.jumpToProject(item.projectId));
            controls.appendChild(view);
            row.appendChild(controls);
          }
          els.list.appendChild(row);
        }
        if (visibleItems.length < S.ideaPanel.items.length) {
          const remaining = S.ideaPanel.items.length - visibleItems.length;
          const showMore = AUR.el(
            'button', 'idea-action idea-show-more',
            `Show ${Math.min(100, remaining)} more`
          );
          showMore.type = 'button';
          showMore.dataset.ideaAction = 'show-more';
          showMore.addEventListener('click', () => {
            const firstNewItem = S.ideaPanel.items[S.ideaPanel.visibleLimit];
            S.ideaPanel.visibleLimit += 100;
            S.ideaPanel.focusAfterRender = firstNewItem
              ? { id: firstNewItem.id, action: null, reveal: true } : null;
            S.ideaPanel.renderKey = '';
            A.renderIdeas();
          });
          els.list.appendChild(showMore);
        }
      }
      restoreIdeaFocus(els.list, previousFocus);
    }
    updateIdeaMutationControls(els.list, disabled, projects.length);
    els.input.disabled = false;
    els.input.readOnly = disabled;
    els.input.setAttribute('aria-disabled', String(disabled));
    els.create.disabled = false;
    els.create.setAttribute('aria-disabled', String(disabled));
    els.status.textContent = replay ? 'Return to LIVE to create or start tasks.' : S.ideaPanel.status;
    els.status.classList.toggle('error', !replay && S.ideaPanel.error);
  };

  function assignIdea(id, projectId) {
    if (!projectId) return;
    const project = S.store.projects.get(projectId);
    const label = project ? project.name : 'project';
    mutateIdea(() => AU.rootTaskAssign(id, projectId), `Assigned to ${label}; agent start requested`);
  }

  function retryIdea(id) {
    mutateIdea(() => AU.rootTaskRetry(id), 'Agent start requested again');
  }

  function removeIdea(item) {
    const index = S.ideaPanel.items.findIndex((entry) => entry.id === item.id);
    mutateIdea(() => AU.rootTaskRemove(item.id), 'Idea removed', false, () => {
      S.ideaPanel.selections.delete(item.id);
      S.ideaPanel.items = S.ideaPanel.items.filter((entry) => entry.id !== item.id);
      const next = S.ideaPanel.items[Math.min(index, S.ideaPanel.items.length - 1)] || null;
      S.ideaPanel.focusAfterRender = next
        ? { id: next.id, action: 'remove', reveal: true }
        : { id: null, action: 'idea-input' };
      S.ideaPanel.renderKey = '';
    });
  }

  async function mutateIdea(operation, successText, clearInput = false, onSuccess = null) {
    if (S.ideaPanel.busy || S.playback.mode !== 'live' || S.replayTransitionPending) return;
    S.ideaPanel.busy = true;
    S.ideaPanel.refreshAfterBusy = false;
    S.ideaPanel.status = '';
    S.ideaPanel.error = false;
    A.renderIdeas();
    let result = null;
    try { result = await operation(); } catch (error) { /* bounded failure below */ }
    S.ideaPanel.busy = false;
    if (result && result.ok === true) {
      S.ideaPanel.status = successText;
      S.ideaPanel.error = false;
      if (clearInput && S.ideaPanel.els) S.ideaPanel.els.input.value = '';
      if (typeof onSuccess === 'function') onSuccess(result);
    } else {
      S.ideaPanel.status = ideaFailureText(result && result.code);
      S.ideaPanel.error = true;
    }
    const refreshAgain = S.ideaPanel.refreshAfterBusy;
    S.ideaPanel.refreshAfterBusy = false;
    A.renderIdeas();
    await refreshIdeas();
    if (refreshAgain) refreshIdeas();
  }

  function ideaFailureText(code) {
    if (code === 'REPLAY') return 'Return to LIVE before changing task ideas.';
    if (code === 'PROJECT_BUSY') return 'That project already has an agent working on a task.';
    if (code === 'UNAVAILABLE') return 'Codex was not found on this computer.';
    if (code === 'LAUNCH_FAILED') return 'Goal assigned, but the agent did not start. Retry when ready.';
    if (code === 'WRITE_FAILED') return 'The project goal could not be written.';
    if (code === 'PROJECT_NOT_FOUND') return 'That project is unavailable. Choose an existing project.';
    if (code === 'LIMIT_REACHED') return 'The task idea list is full.';
    if (code === 'NOT_FOUND') return 'That idea or project is no longer available.';
    if (code === 'BUSY') return 'That idea is already being updated.';
    if (code === 'INVALID_TRANSITION') return 'That idea can no longer be updated.';
    return 'The task idea could not be updated.';
  }

  function confirmRemoval(prompt, text) {
    const value = String(text || '');
    const summary = value.length > 160 ? value.slice(0, 157) + '…' : value;
    return window.confirm(`${prompt}\n\n${summary}\n\nThis cannot be undone.`);
  }

  // ---------- project tasks ----------
  function handleTasksChanged(update) {
    if (!update || update.projectId !== S.taskPanel.projectId ||
        S.current.view !== 'system' || S.playback.mode !== 'live') return;
    if (S.taskPanel.saving) {
      S.taskPanel.refreshAfterSave = true;
      return;
    }
    refreshTasks(S.taskPanel.owner);
  }

  function wireTasksPanel() {
    S.taskPanel.els = {
      panel: document.getElementById('tasks-panel'),
      count: document.getElementById('tasks-count'),
      list: document.getElementById('tasks-list'),
      form: document.getElementById('tasks-form'),
      input: document.getElementById('tasks-input'),
      add: document.getElementById('tasks-add'),
      status: document.getElementById('tasks-status'),
    };
    const els = S.taskPanel.els;
    if (!els.panel || !els.count || !els.list || !els.form || !els.input || !els.add ||
        !els.status) return;
    els.form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!S.taskPanel.trusted || S.taskPanel.saving) return;
      const text = els.input.value.trim();
      if (!text) return;
      addTask(text);
    });
  }

  function stopTasksView() {
    S.taskPanel.owner++;
    S.taskPanel.request++;
    if (S.taskPanel.interval != null) clearInterval(S.taskPanel.interval);
    S.taskPanel.interval = null;
    S.taskPanel.projectId = null;
    S.taskPanel.items = [];
    S.taskPanel.trusted = false;
    S.taskPanel.saving = false;
    S.taskPanel.refreshAfterSave = false;
    S.taskPanel.status = '';
    S.taskPanel.error = false;
    S.taskPanel.focusAfterRender = null;
    if (S.taskPanel.els && S.taskPanel.els.panel) {
      S.taskPanel.els.panel.classList.add('hidden');
      S.taskPanel.els.panel.removeAttribute('aria-busy');
    }
  }

  function startTasksView(projectId) {
    S.taskPanel.projectId = projectId;
    const owner = S.taskPanel.owner;
    refreshTasks(owner);
    S.taskPanel.interval = setInterval(() => refreshTasks(owner), 10_000);
  }

  function taskOwnerIsActive(owner, projectId) {
    return owner === S.taskPanel.owner && S.current.view === 'system' &&
      S.current.projectId === projectId && S.taskPanel.projectId === projectId;
  }

  function taskItemsFrom(result) {
    if (!result || !Array.isArray(result.items)) return [];
    return result.items.filter((item) => item && typeof item.text === 'string' &&
      typeof item.done === 'boolean').map((item) => {
      const next = { text: item.text, done: item.done };
      if (Number.isSafeInteger(item.line) && item.line >= 0) next.line = item.line;
      if (typeof item.id === 'string') next.id = item.id;
      if (item.agentStatus === 'agent-working' || item.agentStatus === 'ready-for-review') {
        next.agentStatus = item.agentStatus;
      }
      return next;
    });
  }

  async function refreshTasks(owner) {
    const projectId = S.taskPanel.projectId;
    if (!taskOwnerIsActive(owner, projectId) || S.taskPanel.saving) return;
    const request = ++S.taskPanel.request;
    let result = null;
    try { result = await AU.tasksGet(projectId); } catch (error) { /* hidden on trust/read failure */ }
    if (!taskOwnerIsActive(owner, projectId) || request !== S.taskPanel.request) return;
    if (!result) {
      S.taskPanel.trusted = false;
      renderTasksPanel();
      return;
    }
    S.taskPanel.trusted = true;
    S.taskPanel.items = taskItemsFrom(result);
    renderTasksPanel();
  }

  async function addTask(text) {
    return mutateTasks(() => AU.taskAdd(S.taskPanel.projectId, text), true, {
      successText: 'Task added',
    });
  }

  async function setTaskDone(item, done) {
    const request = {
      ...(typeof item.id === 'string' ? { id: item.id } : { line: item.line }),
      text: item.text,
      done,
    };
    return mutateTasks(() => AU.taskSetDone(S.taskPanel.projectId, request), false);
  }

  async function removeTask(item, index) {
    if (item.id || !confirmRemoval('Remove this project task?', item.text)) return;
    const request = { line: item.line, text: item.text };
    return mutateTasks(() => AU.taskRemove(S.taskPanel.projectId, request), false, {
      successText: 'Task removed',
      failureText: 'The task could not be removed. Refresh and try again.',
      focusIndex: index,
    });
  }

  async function mutateTasks(operation, clearInput, options = {}) {
    const owner = S.taskPanel.owner;
    const projectId = S.taskPanel.projectId;
    if (!taskOwnerIsActive(owner, projectId) || !S.taskPanel.trusted || S.taskPanel.saving) return;
    S.taskPanel.saving = true;
    S.taskPanel.refreshAfterSave = false;
    S.taskPanel.status = '';
    S.taskPanel.error = false;
    const request = ++S.taskPanel.request;
    renderTasksPanel();
    let result = null;
    try { result = await operation(); } catch (error) { /* refresh below */ }
    if (!taskOwnerIsActive(owner, projectId) || request !== S.taskPanel.request) return;
    S.taskPanel.saving = false;
    const refreshAfterSave = S.taskPanel.refreshAfterSave;
    S.taskPanel.refreshAfterSave = false;
    if (result && result.ok === true && Array.isArray(result.items)) {
      S.taskPanel.items = taskItemsFrom(result);
      if (clearInput && S.taskPanel.els) S.taskPanel.els.input.value = '';
      S.taskPanel.status = options.successText || '';
      if (Number.isSafeInteger(options.focusIndex)) {
        S.taskPanel.focusAfterRender = S.taskPanel.items.length > 0
          ? { index: Math.min(options.focusIndex, S.taskPanel.items.length - 1), action: 'remove' }
          : { action: 'input' };
      }
      renderTasksPanel();
      if (refreshAfterSave) refreshTasks(owner);
      return;
    }
    S.taskPanel.status = options.failureText || 'The task could not be updated.';
    S.taskPanel.error = true;
    if (Number.isSafeInteger(options.focusIndex)) {
      S.taskPanel.focusAfterRender = {
        index: Math.min(options.focusIndex, Math.max(0, S.taskPanel.items.length - 1)),
        action: 'remove',
      };
    }
    renderTasksPanel();
    refreshTasks(owner);
  }

  function taskFocusState(list) {
    const active = document.activeElement;
    if (!active || !list.contains(active)) return null;
    const row = active.closest('.task-row');
    const index = row ? Number.parseInt(row.dataset.taskIndex, 10) : Number.NaN;
    if (!Number.isSafeInteger(index)) return null;
    return {
      index,
      action: active.classList.contains('task-remove') ? 'remove' : 'toggle',
    };
  }

  function renderTasksPanel() {
    const els = S.taskPanel.els;
    if (!els || !els.panel) return;
    if (!S.taskPanel.trusted || S.current.view !== 'system' ||
        S.current.projectId !== S.taskPanel.projectId) {
      els.panel.classList.add('hidden');
      return;
    }

    els.panel.classList.remove('hidden');
    els.panel.setAttribute('aria-busy', String(S.taskPanel.saving));
    const done = S.taskPanel.items.filter((item) => item.done).length;
    els.count.textContent = `${done} / ${S.taskPanel.items.length} done`;
    const previousFocus = taskFocusState(els.list);
    const scrollTop = els.list.scrollTop;
    AUR.clear(els.list);
    if (S.taskPanel.items.length === 0) {
      els.list.appendChild(AUR.el('div', 'tasks-empty', 'No goals yet — add one'));
    } else {
      S.taskPanel.items.forEach((item, index) => {
        const row = AUR.el('div', 'task-row' + (item.done ? ' done' : ''));
        row.dataset.taskIndex = String(index);
        const toggle = AUR.el('button', 'task-toggle');
        toggle.type = 'button';
        toggle.disabled = S.taskPanel.saving;
        toggle.setAttribute('role', 'checkbox');
        toggle.setAttribute('aria-checked', String(item.done));
        toggle.appendChild(AUR.el('span', 'task-check', item.done ? '☑' : '☐'));
        const body = AUR.el('span', 'task-body');
        const taskText = AUR.el('span', 'task-text', item.text);
        taskText.id = `task-text-${index}`;
        body.appendChild(taskText);
        if (item.agentStatus) {
          const label = item.agentStatus === 'ready-for-review'
            ? 'Ready for review' : 'Agent working';
          body.appendChild(AUR.el('span', `task-status ${item.agentStatus}`, label));
        }
        toggle.appendChild(body);
        toggle.addEventListener('click', () => {
          setTaskDone(item, !item.done);
        });
        row.appendChild(toggle);
        if (!item.id) {
          const remove = AUR.el('button', 'task-remove', '×');
          remove.type = 'button';
          remove.disabled = S.taskPanel.saving;
          remove.setAttribute('aria-label', 'Remove task');
          remove.setAttribute('aria-describedby', taskText.id);
          remove.title = 'Remove task';
          remove.addEventListener('click', () => removeTask(item, index));
          row.appendChild(remove);
        }
        els.list.appendChild(row);
      });
    }
    els.status.textContent = S.taskPanel.status;
    els.status.classList.toggle('error', S.taskPanel.error);
    els.input.disabled = S.taskPanel.saving;
    els.add.disabled = S.taskPanel.saving;
    els.list.scrollTop = scrollTop;
    const requestedFocus = S.taskPanel.focusAfterRender;
    S.taskPanel.focusAfterRender = null;
    const focus = requestedFocus || previousFocus;
    if (focus) {
      const row = Number.isSafeInteger(focus.index)
        ? els.list.querySelector(`[data-task-index="${focus.index}"]`)
        : null;
      const target = focus.action === 'input'
        ? els.input
        : focus.action === 'remove'
          ? row && (row.querySelector('.task-remove') || row.querySelector('.task-toggle'))
          : row && (row.querySelector('.task-toggle') || row.querySelector('.task-remove'));
      if (target && typeof target.focus === 'function') {
        target.focus({ preventScroll: true });
        if (requestedFocus && typeof target.scrollIntoView === 'function') {
          target.scrollIntoView({ block: 'nearest' });
        }
      }
    }
    A.positionTasksPanel();
  }

  A.positionTasksPanel = function positionTasksPanel() {
    const els = S.taskPanel.els;
    if (!els || !els.panel || els.panel.classList.contains('hidden')) return;
    const project = document.getElementById('project-card');
    const summary = document.getElementById('summary-card');
    if (!project || project.classList.contains('hidden')) return;
    const top = Math.ceil(project.getBoundingClientRect().bottom + 12);
    const summaryTop = summary ? summary.getBoundingClientRect().top : window.innerHeight;
    const available = Math.max(154, Math.floor(summaryTop - top - 12));
    els.panel.style.top = top + 'px';
    els.panel.style.maxHeight = available + 'px';
  };

  // ---------- go ----------
  boot().catch((e) => {
    console.error('[boot-failure]', e && e.message ? e.message : e);
  });
})();

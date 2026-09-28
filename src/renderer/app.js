// app.js — boot, view stack, event routing, overlay DOM chrome, debug hooks.
'use strict';

(function () {
  const AUR = window.AUR;
  const AU = window.AU;
  const VCS = AUR.ProjectVcsStatus;

  // ---------- store ----------
  const store = {
    projects: new Map(), // id -> Project
    ships: new Map(),    // id -> Ship
    feed: [],            // chronological FeedEntry[], capped
  };
  const FEED_CAP = 60;
  const FEED_SHOW = 30;
  const NOTIFICATION_SHIP_THROTTLE_MS = 30_000;
  const NOTIFICATION_GLOBAL_THROTTLE_MS = 10_000;
  const REPLAY_SPEEDS = [1, 10, 100, 1000];
  const HISTORY_SLIDER_MAX = 10_000;
  const HISTORY_MARKER_LIMIT = 24;
  const SEARCH_DEBOUNCE_MS = 120;
  const COMMAND_RAIL_STORAGE_KEY = 'agent-universe.command-rail.v1';
  const AGENT_FOCUS_ENVIRONMENT_STORAGE_KEY = 'agent-universe.focus-environment.v1';
  const AGENT_FOCUS_VANTAGE_STORAGE_KEY = 'agent-universe.focus-vantage.v1';
  const AGENT_FOCUS_ENVIRONMENTS = Object.freeze({
    cockpit: { label: 'COCKPIT LINK', asset: 'assets/cockpit-frame.png' },
    quarters: { label: 'LIVING QUARTERS', asset: 'assets/environment-quarters.png' },
    office: { label: 'ORBITAL OFFICE', asset: 'assets/environment-office.png' },
    station: { label: 'STATION OBSERVATORY', asset: 'assets/environment-station.png' },
  });
  const AGENT_FOCUS_VANTAGES = Object.freeze({
    forward: 'FORWARD',
    starboard: 'STARBOARD',
    aft: 'AFT',
    port: 'PORT',
  });

  const notificationByShip = new Map();
  const liveProjectEvents = new Map();
  let lastNotificationAt = -Infinity;

  // ---------- runtime ----------
  let engine = null;
  let canvas = null;
  let activeView = null;   // { scene, update, dispose }
  let activeScene = null;
  const current = { view: 'universe', projectId: null, planetName: null };
  let routeRequestGeneration = 0;
  let booting = true;
  let bootEventQueue = [];
  let bootVcsQueue = [];
  let lastEventSequence = -Infinity;
  let streamEpoch = null;
  const retiredEpochs = new Set();
  let deferredEpochBatches = [];
  let transitionEventQueue = [];
  let replayTransitionPending = false;
  let replayRequest = 0;
  let replayBusy = false;
  let historyPreviewTs = null;
  let historyPreviewFrame = null;
  let historyPendingPreviewTs = null;
  let historyMarkerKey = '';
  const historyPerf = {
    inputEvents: 0,
    previewFrames: 0,
    seekRequests: 0,
    maxInputHandlerMs: 0,
  };
  let historyEls = null;
  let terminalRequestSerial = 0;
  let projectControl = {
    projectId: null,
    requestId: 0,
    phase: 'idle',
    code: null,
  };
  const taskPanel = {
    owner: 0,
    request: 0,
    projectId: null,
    items: [],
    trusted: false,
    saving: false,
    refreshAfterSave: false,
    status: '',
    error: false,
    focusAfterRender: null,
    interval: null,
    els: null,
  };
  const ideaPanel = {
    request: 0,
    items: [],
    busy: false,
    refreshAfterBusy: false,
    selections: new Map(),
    status: '',
    error: false,
    interval: null,
    visibleLimit: 100,
    renderKey: '',
    focusAfterRender: null,
    els: null,
  };
  const projectSearch = {
    timer: null,
    query: '',
    filter: VCS.FILTERS.ALL,
    results: [],
    selected: 0,
    els: null,
  };
  const projectDirectory = {
    open: false,
    timer: null,
    query: '',
    results: [],
    selected: 0,
    els: null,
  };
  const commandRail = {
    compact: false,
    ideasCollapsed: false,
    agentsCollapsed: false,
    feedCollapsed: false,
    els: null,
  };
  const agentFocus = {
    shipId: null,
    pendingShipId: null,
    previousFocus: null,
    lastFlightUpdate: 0,
    environment: 'cockpit',
    vantage: 'forward',
    els: null,
  };
  const projectSettings = {
    open: false,
    owner: 0,
    request: 0,
    busy: false,
    scanPerformed: false,
    scanRoot: '',
    matches: new Map(),
    status: '',
    error: false,
    els: null,
  };
  let playback = {
    mode: 'live', available: false, indexing: true,
    minTs: null, maxTs: null, cursorTs: null,
    playing: false, speed: 1, truncated: false,
  };

  // ---------- boot ----------
  async function boot() {
    canvas = document.getElementById('renderCanvas');
    engine = new BABYLON.Engine(canvas, true, {
      preserveDrawingBuffer: true, stencil: true, antialias: true,
    }, true);
    engine.runRenderLoop(() => {
      if (activeScene && !activeScene.isDisposed) {
        try { activeScene.render(); } catch (e) { /* swallow transient swap frames */ }
      }
      if (agentFocus.shipId) {
        const now = performance.now();
        if (now - agentFocus.lastFlightUpdate >= 250) {
          agentFocus.lastFlightUpdate = now;
          renderAgentFocusFlightTarget();
        }
      }
    });
    window.addEventListener('resize', () => {
      engine.resize();
      positionTasksPanel();
    });
    wireHistoryBar();
    wireTasksPanel();
    wireIdeasPanel();
    wireCommandRail();
    wireAgentFocus();
    wireProjectSearch();
    wireProjectDirectory();
    wireProjectSettings();

    // Subscribe before taking the snapshot. Every tracker event has a
    // monotonic sequence within its stream epoch, so batches racing the
    // snapshot can be reconciled without duplication or loss.
    AU.onEvents(routeEvents);
    AU.onReplayState(handleReplayState);
    AU.onTasksChanged(handleTasksChanged);
    AU.onRootTasksChanged(handleRootTasksChanged);
    AU.onProjectVcsStatusChanged(routeProjectVcsStatus);
    const snap = await AU.snapshot();
    seedStore(snap);
    streamEpoch = epochOf(snap);
    applyPlayback(snap && snap.playback, false);
    const cutoff = Number.isFinite(snap && snap.eventSequence) ? snap.eventSequence : -Infinity;
    lastEventSequence = cutoff;
    const queued = bootEventQueue;
    bootEventQueue = [];
    booting = false;
    for (const packet of queued) handleSequencedEvents(packet.batch, packet.meta);
    const queuedVcs = bootVcsQueue;
    bootVcsQueue = [];
    for (const packet of queuedVcs) routeProjectVcsStatus(packet.status, packet.meta);

    // Dev self-check: our copied hash must be bit-exact with the tracker's.
    for (const p of store.projects.values()) {
      if (AUR.fnv1a(p.id) !== p.seed) {
        AUR.log('WARN fnv1a mismatch for', p.id, AUR.fnv1a(p.id), 'vs', p.seed);
      }
      break;
    }

    wireBackButton();
    showUniverse();
    refreshIdeas();
    ideaPanel.interval = setInterval(refreshIdeas, 5_000);
    renderChrome();

    AU.onDebugView(handleDebugView);
  }

  function routeEvents(batch, meta) {
    if (booting) bootEventQueue.push({ batch, meta });
    else if (replayTransitionPending) transitionEventQueue.push({ batch, meta });
    else handleSequencedEvents(batch, meta);
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
    if (booting) {
      bootVcsQueue.push({ status, meta });
      return;
    }
    const incomingEpoch = epochOf(meta);
    if (playback.mode !== 'live' ||
        (incomingEpoch != null && streamEpoch != null && !sameEpoch(incomingEpoch, streamEpoch))) return;
    const project = store.projects.get(status.projectId);
    if (!project || vcsFreshness(project.vcs) > vcsFreshness(status)) return;
    store.projects.set(status.projectId, { ...project, vcs: status });
    const event = { type: 'project-vcs-status', projectId: status.projectId, status };
    if (activeView && typeof activeView.update === 'function') {
      try { activeView.update([event]); } catch (error) { AUR.log('VCS view update failed'); }
    }
    scheduleChrome(CHROME_PROJECT | CHROME_SEARCH | CHROME_DIRECTORY);
  }

  function handleSequencedEvents(batch, meta) {
    if (!Array.isArray(batch)) return;
    const incomingEpoch = epochOf(meta);
    if (incomingEpoch != null && streamEpoch != null && !sameEpoch(incomingEpoch, streamEpoch)) {
      if (!isRetiredEpoch(incomingEpoch)) {
        deferredEpochBatches.push({ batch, meta });
      }
      return;
    }
    if (streamEpoch == null && incomingEpoch != null) streamEpoch = incomingEpoch;
    const unseen = [];
    for (const ev of batch) {
      if (Number.isFinite(ev.seq)) {
        if (ev.seq <= lastEventSequence) continue;
        lastEventSequence = ev.seq;
      }
      unseen.push(ev);
    }
    if (unseen.length) handleEvents(unseen);
  }

  function epochOf(value) {
    return value && value.streamEpoch != null ? value.streamEpoch : null;
  }

  function sameEpoch(a, b) {
    return a != null && b != null && String(a) === String(b);
  }

  function isRetiredEpoch(value) {
    if (retiredEpochs.has(String(value))) return true;
    return Number.isInteger(value) && Number.isInteger(streamEpoch) && value < streamEpoch;
  }

  function retireEpoch(value) {
    if (value == null) return;
    retiredEpochs.add(String(value));
    while (retiredEpochs.size > 64) retiredEpochs.delete(retiredEpochs.values().next().value);
  }

  function seedStore(snap) {
    store.projects.clear();
    store.ships.clear();
    store.feed = [];
    if (snap && Array.isArray(snap.projects)) {
      for (const p of snap.projects) store.projects.set(p.id, p);
    }
    if (snap && Array.isArray(snap.ships)) {
      for (const s of snap.ships) store.ships.set(s.id, s);
    }
    if (snap && Array.isArray(snap.feed)) {
      store.feed = snap.feed.slice(-FEED_CAP);
    }
  }

  function finiteField(value, names, fallback) {
    for (const name of names) {
      if (value && Number.isFinite(value[name])) return value[name];
    }
    return fallback;
  }

  function normalizePlayback(value) {
    if (!value || typeof value !== 'object') return playback;
    const minTs = finiteField(value, ['minTs', 'startTs', 'start'], playback.minTs);
    const maxTs = finiteField(value, ['maxTs', 'endTs', 'end'], playback.maxTs);
    let cursorTs = finiteField(value, ['cursorTs', 'cursor', 'ts'], playback.cursorTs);
    const stateWord = typeof value.state === 'string' ? value.state.toLowerCase() : '';
    let mode = value.mode === 'replay' || value.mode === 'live' ? value.mode : playback.mode;
    if (stateWord === 'live') mode = 'live';
    else if (!value.mode && (stateWord === 'playing' || stateWord === 'paused')) mode = 'replay';
    if (mode === 'live' && Number.isFinite(maxTs)) cursorTs = maxTs;
    const requestedSpeed = Number(value.speed);
    const speed = REPLAY_SPEEDS.includes(requestedSpeed) ? requestedSpeed : playback.speed;
    const available = typeof value.available === 'boolean'
      ? value.available
      : (Number.isFinite(minTs) && Number.isFinite(maxTs) && maxTs >= minTs);
    const playingValue = typeof value.playing === 'boolean'
      ? value.playing : stateWord === 'playing';
    return {
      mode,
      available,
      indexing: typeof value.indexing === 'boolean' ? value.indexing : playback.indexing,
      minTs,
      maxTs,
      cursorTs,
      playing: mode === 'replay' && playingValue,
      speed,
      truncated: typeof value.truncated === 'boolean' ? value.truncated : playback.truncated,
    };
  }

  function applyPlayback(value, updateChrome = true) {
    if (value && typeof value === 'object') playback = normalizePlayback(value);
    if (updateChrome) {
      renderHistory();
      renderFeed();
      renderProjectCard();
      renderProjectSettings();
      renderIdeas();
    }
  }

  function handleReplayState(next) {
    if (replayTransitionPending) return;
    const nextEpoch = epochOf(next);
    if (nextEpoch != null && streamEpoch != null && !sameEpoch(nextEpoch, streamEpoch)) return;
    applyPlayback(next);
  }

  function playbackReferenceTs() {
    return playback.mode === 'replay' && Number.isFinite(playback.cursorTs)
      ? playback.cursorTs : Date.now();
  }

  function adoptReplayResult(result, forceReset) {
    if (!result || typeof result !== 'object') return;
    const snap = result.snapshot && typeof result.snapshot === 'object' ? result.snapshot : null;
    const nextPlayback = result.playback || (snap && snap.playback);
    // Set replay mode before any historical ship update can consider desktop
    // notifications. Historical attention stays visible but never pages.
    applyPlayback(nextPlayback, false);

    const nextEpoch = result.streamEpoch != null
      ? result.streamEpoch : epochOf(snap);
    const changedEpoch = nextEpoch != null && !sameEpoch(nextEpoch, streamEpoch);
    if (snap && (forceReset || changedEpoch || streamEpoch == null)) {
      const previousRoute = { ...current };
      routeRequestGeneration++;
      if (streamEpoch != null && changedEpoch) retireEpoch(streamEpoch);
      if (nextEpoch != null) streamEpoch = nextEpoch;
      seedStore(snap);
      lastEventSequence = Number.isFinite(snap.eventSequence) ? snap.eventSequence : -Infinity;
      notificationByShip.clear();
      lastNotificationAt = -Infinity;
      historyPreviewTs = null;
      // A complete route rebuild is the safe reconciliation point: it removes
      // projects, galaxies, and ships that do not exist at the new cursor
      // without adding reset branches to each scene.
      if (!booting && activeView) rebuildRoute(previousRoute);
      else if (!booting) renderChrome();
      drainDeferredEpochEvents();
      return;
    }
    renderHistory();
    renderFeed();
    renderProjectCard();
  }

  function rebuildRoute(route) {
    if (!route || route.view === 'universe' || !route.projectId ||
        !store.projects.has(route.projectId)) {
      showUniverse();
      return;
    }
    if (route.view === 'planet' && route.planetName) {
      openPlanet(route.projectId, route.planetName);
      return;
    }
    openSystem(route.projectId);
  }

  function drainDeferredEpochEvents() {
    if (deferredEpochBatches.length === 0) return;
    const queued = deferredEpochBatches;
    deferredEpochBatches = [];
    for (const packet of queued) {
      const incomingEpoch = epochOf(packet.meta);
      if (incomingEpoch == null || sameEpoch(incomingEpoch, streamEpoch)) {
        handleSequencedEvents(packet.batch, packet.meta);
      } else if (!isRetiredEpoch(incomingEpoch)) {
        deferredEpochBatches.push(packet);
      }
    }
  }

  async function issueReplay(command) {
    const request = ++replayRequest;
    const modeBoundary = command.action === 'seek' || command.action === 'live';
    if (modeBoundary) replayTransitionPending = true;
    replayBusy = true;
    renderHistory();
    renderProjectCard();
    renderAgentFocus();
    renderProjectSettings();
    renderIdeas();
    try {
      const result = await AU.replay(command);
      if (request !== replayRequest) return;
      const forceReset = command.action === 'seek' || command.action === 'live';
      adoptReplayResult(result, forceReset);
    } catch (error) {
      if (request === replayRequest) AUR.log('replay command failed', error && error.message);
    } finally {
      if (request === replayRequest) {
        replayTransitionPending = false;
        replayBusy = false;
        historyPreviewTs = null;
        const queued = transitionEventQueue;
        transitionEventQueue = [];
        for (const packet of queued) handleSequencedEvents(packet.batch, packet.meta);
        renderHistory();
        renderProjectCard();
        renderAgentFocus();
        renderProjectSettings();
        renderIdeas();
      }
    }
  }

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
      if (ev.type === 'project-added' && ev.project && playback.mode === 'live' &&
          !store.projects.has(ev.project.id)) {
        liveProjectEvents.set(ev.project.id, Number.isFinite(ev.project.firstSeen)
          ? ev.project.firstSeen : Date.now());
        while (liveProjectEvents.size > HISTORY_MARKER_LIMIT) {
          liveProjectEvents.delete(liveProjectEvents.keys().next().value);
        }
      }
      const previous = ev.type === 'project-updated' && ev.project
        ? store.projects.get(ev.project.id) : null;
      applyEvent(ev);
      chromeMask |= chromeMaskFor(ev);
      if (previous && previous.exists === false && ev.project.exists === true &&
          current.view !== 'universe' && current.projectId === ev.project.id) {
        recoveredRoute = { ...current };
      }
    }
    if (activeView && activeView.update) {
      try { activeView.update(batch); } catch (e) { AUR.log('view update err', e && e.message); }
    }
    if (agentFocus.shipId && !store.ships.has(agentFocus.shipId)) {
      exitAgentFocus(false);
    }
    // Project creation is rare and its live-region announcement should not
    // wait behind a busy scene/chrome animation frame.
    if (chromeMask & CHROME_HISTORY) renderHistory();
    scheduleChrome(chromeMask);
    if (recoveredRoute) queueMicrotask(() => rebuildRoute(recoveredRoute));
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
        store.projects.set(ev.project.id, ev.project);
        break;
      case 'ship-spawned':
        store.ships.set(ev.ship.id, ev.ship);
        break;
      case 'ship-updated': {
        const previous = store.ships.get(ev.ship.id);
        maybeNotifyAttention(previous ? previous.attention : null, ev.ship);
        store.ships.set(ev.ship.id, ev.ship);
        break;
      }
      case 'ship-departed':
        store.ships.delete(ev.shipId);
        notificationByShip.delete(ev.shipId);
        break;
      case 'feed':
        store.feed.push(ev.entry);
        if (store.feed.length > FEED_CAP) store.feed = store.feed.slice(-FEED_CAP);
        break;
      case 'build': {
        const p = store.projects.get(ev.project);
        if (p) p.totalBuilds = (p.totalBuilds || 0) + 1;
        break;
      }
      default: break;
    }
  }

  function maybeNotifyAttention(previousAttention, ship) {
    const entered = ship && (ship.attention === 'question' || ship.attention === 'permission');
    if (playback.mode !== 'live' || previousAttention != null || !entered ||
        typeof window.Notification !== 'function') return;

    const now = Date.now();
    const lastForShip = notificationByShip.get(ship.id) ?? -Infinity;
    if (now - lastForShip < NOTIFICATION_SHIP_THROTTLE_MS ||
        now - lastNotificationAt < NOTIFICATION_GLOBAL_THROTTLE_MS) return;

    const meta = AUR.attentionMeta(ship.attention);
    if (!meta) return;
    try {
      new window.Notification(ship.name + ' needs you', {
        body: meta.label + ' · ' + projectName(ship.project),
      });
      notificationByShip.set(ship.id, now);
      lastNotificationAt = now;
    } catch (e) { /* notifications are best-effort */ }
  }

  // ---------- view switching ----------
  function makeCtx() {
    return { store, openSystem, openPlanet, back };
  }

  function setView(name, data) {
    const factory = AUR.views[name];
    if (typeof factory !== 'function') {
      AUR.log('view factory missing:', name);
      if (name !== 'universe') return showUniverse();
      return;
    }
    let next;
    try {
      next = factory(engine, data, makeCtx());
    } catch (e) {
      AUR.log('view build failed:', name, e && e.message);
      if (name !== 'universe') return showUniverse();
      return;
    }
    const old = activeView;
    if (name !== 'universe') clearProjectSearch();
    if (agentFocus.shipId) exitAgentFocus(false);
    activeView = next;
    activeScene = next.scene;
    current.view = name;
    stopTasksView();
    if (old && old.dispose) disposeSettled(old);
    renderChrome();
    if (name === 'system' && current.projectId) startTasksView(current.projectId);
    if (name === 'universe') refreshProjectSearchFromStore();
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

  function showUniverse() {
    routeRequestGeneration++;
    current.view = 'universe';
    current.projectId = null;
    current.planetName = null;
    setView('universe', { store });
  }

  async function openSystem(projectId) {
    clearProjectSearch();
    const request = ++routeRequestGeneration;
    const requestedEpoch = streamEpoch;
    let data = null;
    try { data = await AU.getSystem(projectId); } catch (e) { AUR.log('getSystem err', e && e.message); }
    if (request !== routeRequestGeneration || !sameEpoch(requestedEpoch, streamEpoch)) return;
    current.projectId = projectId;
    current.planetName = null;
    if (!data) { AUR.log('no system data for', projectId); return showUniverse(); }
    setView('system', { system: data, projectId, store });
  }

  async function openPlanet(projectId, name) {
    const request = ++routeRequestGeneration;
    const requestedEpoch = streamEpoch;
    let data = null;
    try { data = await AU.getPlanet(projectId, name); } catch (e) { AUR.log('getPlanet err', e && e.message); }
    if (request !== routeRequestGeneration || !sameEpoch(requestedEpoch, streamEpoch)) return;
    current.projectId = projectId;
    current.planetName = name;
    if (!data) { AUR.log('no planet data for', projectId, name); return openSystem(projectId); }
    setView('planet', { planet: data, projectId, name, store });
  }

  function back() {
    if (current.view === 'planet' && current.projectId) openSystem(current.projectId);
    else showUniverse();
  }

  // Direct project links (feed, recent, task views) jump to the system. Agent
  // rows use the first-person focus flow below.
  function jumpToProject(projectId) {
    if (!projectId || !store.projects.has(projectId)) return;
    if (current.view === 'system' && current.projectId === projectId) return;
    openSystem(projectId);
  }

  function wireBackButton() {
    const btn = document.getElementById('back-btn');
    btn.addEventListener('click', back);
  }

  // ---------- first-person agent focus ----------
  const AGENT_FOCUS_INERT_IDS = [
    'topbar', 'sidebar', 'back-btn', 'project-card', 'tasks-panel',
    'planet-card', 'summary-card', 'tabbar', 'history-bar',
  ];

  function wireAgentFocus() {
    agentFocus.els = {
      root: document.getElementById('agent-focus'),
      frame: document.getElementById('agent-focus-frame'),
      environmentLabel: document.getElementById('agent-focus-environment-label'),
      environments: document.getElementById('agent-focus-environments'),
      vantages: document.getElementById('agent-focus-vantages'),
      hologram: document.getElementById('agent-focus-hologram'),
      hologramName: document.getElementById('agent-focus-hologram-name'),
      hologramSystem: document.getElementById('agent-focus-hologram-system'),
      hologramCount: document.getElementById('agent-focus-hologram-count'),
      hologramShip: document.getElementById('agent-focus-hologram-ship'),
      hologramShipLabel: document.getElementById('agent-focus-hologram-ship-label'),
      name: document.getElementById('agent-focus-name'),
      context: document.getElementById('agent-focus-context'),
      target: document.getElementById('agent-focus-target'),
      provider: document.getElementById('agent-focus-provider'),
      status: document.getElementById('agent-focus-status'),
      project: document.getElementById('agent-focus-project'),
      folder: document.getElementById('agent-focus-folder'),
      terminal: document.getElementById('agent-focus-terminal'),
      exit: document.getElementById('agent-focus-exit'),
      actionStatus: document.getElementById('agent-focus-action-status'),
    };
    const els = agentFocus.els;
    if (!els.root || !els.frame || !els.exit || !els.folder || !els.terminal) return;
    let environment = 'cockpit';
    try {
      const stored = localStorage.getItem(AGENT_FOCUS_ENVIRONMENT_STORAGE_KEY);
      if (stored && Object.hasOwn(AGENT_FOCUS_ENVIRONMENTS, stored)) environment = stored;
    } catch (e) { /* storage can be unavailable in hardened renderers */ }
    setAgentFocusEnvironment(environment, false);
    let vantage = 'forward';
    try {
      const stored = localStorage.getItem(AGENT_FOCUS_VANTAGE_STORAGE_KEY);
      if (stored && Object.hasOwn(AGENT_FOCUS_VANTAGES, stored)) vantage = stored;
    } catch (e) { /* storage can be unavailable in hardened renderers */ }
    setAgentFocusVantage(vantage, false);
    if (els.environments) {
      for (const button of els.environments.querySelectorAll('[data-environment]')) {
        button.addEventListener('click', () => {
          setAgentFocusEnvironment(button.dataset.environment, true);
        });
      }
    }
    if (els.vantages) {
      for (const button of els.vantages.querySelectorAll('[data-vantage]')) {
        button.addEventListener('click', () => {
          setAgentFocusVantage(button.dataset.vantage, true);
        });
      }
    }
    for (const item of Object.values(AGENT_FOCUS_ENVIRONMENTS)) {
      if (item.asset === els.frame.getAttribute('src')) continue;
      const preload = new Image();
      preload.src = item.asset;
    }
    els.exit.addEventListener('click', () => exitAgentFocus(true));
    els.folder.addEventListener('click', () => {
      const ship = store.ships.get(agentFocus.shipId);
      if (ship) AU.openProject(ship.project);
    });
    els.terminal.addEventListener('click', () => {
      const ship = store.ships.get(agentFocus.shipId);
      if (ship) requestProjectTerminal(ship.project);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !agentFocus.shipId) return;
      event.preventDefault();
      event.stopPropagation();
      exitAgentFocus(true);
    });
  }

  function setAgentFocusEnvironment(value, persist) {
    const key = typeof value === 'string' && Object.hasOwn(AGENT_FOCUS_ENVIRONMENTS, value)
      ? value : 'cockpit';
    const config = AGENT_FOCUS_ENVIRONMENTS[key];
    agentFocus.environment = key;
    const els = agentFocus.els;
    if (els && els.root) els.root.dataset.environment = key;
    if (els && els.frame && els.frame.getAttribute('src') !== config.asset) {
      els.frame.setAttribute('src', config.asset);
    }
    if (els && els.environmentLabel) els.environmentLabel.textContent = config.label;
    if (els && els.environments) {
      for (const button of els.environments.querySelectorAll('[data-environment]')) {
        button.setAttribute('aria-pressed', String(button.dataset.environment === key));
      }
    }
    if (!persist) return;
    try { localStorage.setItem(AGENT_FOCUS_ENVIRONMENT_STORAGE_KEY, key); } catch (e) { /* ignore */ }
  }

  function setAgentFocusVantage(value, persist) {
    const key = typeof value === 'string' && Object.hasOwn(AGENT_FOCUS_VANTAGES, value)
      ? value : 'forward';
    agentFocus.vantage = key;
    const els = agentFocus.els;
    if (els && els.root) els.root.dataset.vantage = key;
    if (els && els.vantages) {
      for (const button of els.vantages.querySelectorAll('[data-vantage]')) {
        button.setAttribute('aria-pressed', String(button.dataset.vantage === key));
      }
    }
    if (activeView && typeof activeView.setShipFocusVantage === 'function') {
      activeView.setShipFocusVantage(key);
    }
    if (!persist) return;
    try { localStorage.setItem(AGENT_FOCUS_VANTAGE_STORAGE_KEY, key); } catch (e) { /* ignore */ }
  }

  function setAgentFocusInert(value) {
    for (const id of AGENT_FOCUS_INERT_IDS) {
      const element = document.getElementById(id);
      if (element) element.inert = value;
    }
  }

  async function enterAgentFocus(shipId) {
    const id = String(shipId || '');
    if (!id || agentFocus.pendingShipId) return;
    if (agentFocus.shipId === id) {
      exitAgentFocus(true);
      return;
    }
    const selected = store.ships.get(id);
    if (!selected || !selected.project || !store.projects.has(selected.project)) return;
    if (agentFocus.shipId) exitAgentFocus(false);

    agentFocus.previousFocus = document.activeElement;
    agentFocus.pendingShipId = id;
    renderAgents();
    if (current.view !== 'system' || current.projectId !== selected.project) {
      await openSystem(selected.project);
    }

    const ship = store.ships.get(id);
    const canFocus = ship && current.view === 'system' && current.projectId === ship.project &&
      activeView && typeof activeView.focusShip === 'function' && activeView.focusShip(id);
    agentFocus.pendingShipId = null;
    if (!canFocus) {
      renderAgents();
      return;
    }

    setAgentFocusVantage(agentFocus.vantage, false);
    agentFocus.shipId = id;
    document.body.classList.add('agent-focus-active');
    setAgentFocusInert(true);
    renderAgentFocus();
    renderAgents();
    requestAnimationFrame(() => {
      if (agentFocus.shipId === id && agentFocus.els && agentFocus.els.exit) {
        agentFocus.els.exit.focus({ preventScroll: true });
      }
    });
  }

  function exitAgentFocus(restoreFocus) {
    const id = agentFocus.shipId || agentFocus.pendingShipId;
    agentFocus.pendingShipId = null;
    if (activeView && typeof activeView.clearShipFocus === 'function') {
      activeView.clearShipFocus();
    }
    agentFocus.shipId = null;
    document.body.classList.remove('agent-focus-active');
    setAgentFocusInert(false);
    renderAgentFocus();
    renderAgents();
    if (!restoreFocus) return;
    requestAnimationFrame(() => {
      const previous = agentFocus.previousFocus;
      const fallback = id
        ? document.querySelector(`.agent-row[data-ship-id="${CSS.escape(String(id))}"]`)
        : null;
      const target = previous && previous.isConnected ? previous : fallback;
      if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
    });
  }

  function renderAgentFocus() {
    const els = agentFocus.els;
    if (!els || !els.root) return;
    const ship = agentFocus.shipId ? store.ships.get(agentFocus.shipId) : null;
    const visible = Boolean(ship && current.view === 'system' &&
      current.projectId === ship.project && activeView);
    els.root.classList.toggle('hidden', !visible);
    if (!visible) return;

    const project = store.projects.get(ship.project);
    const provider = AUR.providerMeta(ship.provider);
    const attention = AUR.attentionMeta(ship.attention);
    const tint = AUR.shipTint(ship.id, ship.provider);
    els.root.dataset.provider = provider.key;
    els.root.style.setProperty('--focus-accent', tint);
    els.root.style.setProperty('--focus-alert', attention ? attention.color : tint);
    els.name.textContent = ship.name;
    els.context.textContent = (attention ? attention.label : ship.status) +
      ' · ' + (project ? project.name : ship.project);
    renderAgentFocusHologram(project);
    renderAgentFocusFlightTarget();
    els.provider.textContent = provider.label;
    els.status.textContent = attention ? attention.label : ship.status;
    els.project.textContent = project ? project.name : ship.project;
    els.folder.disabled = !project || project.exists === false;

    const presentation = projectControlPresentation(ship.project);
    els.terminal.textContent = presentation.buttonText;
    els.terminal.disabled = presentation.disabled;
    els.terminal.setAttribute('aria-busy', String(presentation.busy));
    els.terminal.dataset.state = presentation.phase;
    els.actionStatus.textContent = presentation.note;
    els.actionStatus.dataset.state = presentation.phase;
  }

  function renderAgentFocusHologram(project) {
    const els = agentFocus.els;
    if (!els || !els.hologramSystem) return;
    const systemPlanets = activeView && activeView.systemData &&
      Array.isArray(activeView.systemData.planets)
      ? activeView.systemData.planets : [];
    const planets = systemPlanets.slice(0, 7);
    const names = planets.map((planet) => String(planet.name || 'body'));
    const projectId = project ? project.id : current.projectId;
    const projectName = String(project && project.name || 'LOCAL SYSTEM');
    const signature = String(projectId || '') + ':' + projectName + ':' + names.join('|');
    if (els.hologramSystem.dataset.signature !== signature) {
      els.hologramSystem.dataset.signature = signature;
      for (const orbit of els.hologramSystem.querySelectorAll('.agent-focus-hologram-orbit')) {
        orbit.remove();
      }

      const colors = ['#60a5fa', '#a78bfa', '#fb7185', '#f59e0b', '#22d3ee', '#94a3b8'];
      const count = Math.max(1, planets.length);
      planets.forEach((planet, index) => {
        const seed = AUR.fnv1a(String(projectId || '') + ':' + names[index]);
        const extent = (index + 1) / count;
        const orbit = document.createElement('i');
        orbit.className = 'agent-focus-hologram-orbit';
        orbit.dataset.phase = String((seed % 6283) / 1000);
        orbit.dataset.rate = String(
          (AUR.MOTION.systemPlanetOrbitMin +
            ((seed >>> 8) % 1000) / 1000 * AUR.MOTION.systemPlanetOrbitRange) /
          (1 + index * 0.16)
        );
        orbit.style.setProperty('--orbit-width', (22 + extent * 72) + '%');
        orbit.style.setProperty('--orbit-height', (18 + extent * 60) + '%');
        orbit.style.setProperty('--planet-color', colors[seed % colors.length]);
        const score = Number(planet.files || 0) + Number(planet.builds || 0) * 5;
        orbit.style.setProperty('--planet-size', AUR.clamp(4 + Math.log10(score + 1), 4, 8) + 'px');
        const body = document.createElement('b');
        const label = document.createElement('span');
        label.textContent = names[index].toUpperCase();
        body.appendChild(label);
        orbit.appendChild(body);
        els.hologramSystem.appendChild(orbit);
      });

      if (els.hologramName) els.hologramName.textContent = projectName.toUpperCase();
      if (els.hologramCount) {
        els.hologramCount.textContent = systemPlanets.length +
          (systemPlanets.length === 1 ? ' BODY' : ' BODIES');
      }
    }
    renderAgentFocusNavigationMap();
  }

  function renderAgentFocusNavigationMap() {
    const els = agentFocus.els;
    if (!els || !els.hologramSystem) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const time = reducedMotion ? 0 : performance.now() / 1000;
    for (const orbit of els.hologramSystem.querySelectorAll('.agent-focus-hologram-orbit')) {
      const body = orbit.querySelector('b');
      if (!body) continue;
      const angle = Number(orbit.dataset.phase || 0) + Number(orbit.dataset.rate || 0) * time;
      body.style.left = (50 + Math.cos(angle) * 50) + '%';
      body.style.top = (50 + Math.sin(angle) * 50) + '%';
    }

    const state = activeView && typeof activeView.shipFocusState === 'function'
      ? activeView.shipFocusState() : null;
    if (!els.hologramShip || !state || !state.map) {
      if (els.hologramShip) els.hologramShip.classList.add('hidden');
      return;
    }
    els.hologramShip.classList.remove('hidden');
    els.hologramShip.style.left =
      (50 + Math.cos(state.map.angle) * state.map.radiusRatio * 47) + '%';
    els.hologramShip.style.top =
      (50 + Math.sin(state.map.angle) * state.map.radiusRatio * 39) + '%';
    if (els.hologramShipLabel) {
      const ship = store.ships.get(state.shipId);
      els.hologramShipLabel.textContent = String(ship && ship.name || 'SHIP').toUpperCase();
    }
  }

  function renderAgentFocusFlightTarget() {
    const els = agentFocus.els;
    if (!agentFocus.shipId || !els || !els.target || !activeView) return;
    renderAgentFocusNavigationMap();
    const flight = typeof activeView.shipFocusState === 'function'
      ? activeView.shipFocusState() : null;
    const target = flight && flight.target
      ? String(flight.target).toUpperCase() : 'SYSTEM PATROL';
    if (els.target.textContent !== target) els.target.textContent = target;
  }

  function agentFocusStats() {
    const sceneStats = activeScene && activeScene.metadata &&
      typeof activeScene.metadata.focusStats === 'function'
      ? activeScene.metadata.focusStats() : null;
    return {
      active: Boolean(agentFocus.shipId),
      shipId: agentFocus.shipId,
      pendingShipId: agentFocus.pendingShipId,
      environment: agentFocus.environment,
      vantage: agentFocus.vantage,
      view: current.view,
      bodyClass: document.body.classList.contains('agent-focus-active'),
      overlayVisible: Boolean(agentFocus.els && agentFocus.els.root &&
        !agentFocus.els.root.classList.contains('hidden')),
      hologramBodies: agentFocus.els && agentFocus.els.hologramSystem
        ? agentFocus.els.hologramSystem.querySelectorAll('.agent-focus-hologram-orbit').length : 0,
      scene: sceneStats,
    };
  }
  AUR.agentFocusStats = agentFocusStats;

  // ---------- live/history controls ----------
  function wireHistoryBar() {
    historyEls = {
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
    if (!historyEls.bar || !historyEls.play || !historyEls.speed ||
        !historyEls.scrubber || !historyEls.time || !historyEls.live) return;

    historyEls.play.addEventListener('click', () => {
      if (playback.mode !== 'replay' || !playback.available) return;
      issueReplay({ action: playback.playing ? 'pause' : 'play' });
    });
    historyEls.speed.addEventListener('click', () => {
      if (playback.mode !== 'replay' || !playback.available) return;
      const index = Math.max(0, REPLAY_SPEEDS.indexOf(playback.speed));
      const speed = REPLAY_SPEEDS[(index + 1) % REPLAY_SPEEDS.length];
      issueReplay({ action: 'speed', speed });
    });
    historyEls.scrubber.addEventListener('input', () => {
      const started = performance.now();
      historyPerf.inputEvents++;
      historyPendingPreviewTs = historyTimestampFromPosition(historyEls.scrubber.value);
      if (historyPreviewFrame === null) {
        historyPreviewFrame = requestAnimationFrame(flushHistoryPreview);
      }
      historyPerf.maxInputHandlerMs = Math.max(
        historyPerf.maxInputHandlerMs, performance.now() - started
      );
    });
    historyEls.scrubber.addEventListener('change', () => {
      historyPendingPreviewTs = historyTimestampFromPosition(historyEls.scrubber.value);
      flushHistoryPreview();
      if (Number.isFinite(historyPreviewTs) && !replayBusy) {
        historyPerf.seekRequests++;
        issueReplay({ action: 'seek', ts: historyPreviewTs });
      }
    });
    historyEls.live.addEventListener('click', () => {
      if (playback.mode !== 'live') issueReplay({ action: 'live' });
    });
    renderHistory();
  }

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
    if (!Number.isFinite(playback.minTs) || !Number.isFinite(playback.maxTs)) return null;
    const position = AUR.clamp(Number(value) || 0, 0, HISTORY_SLIDER_MAX);
    const ratio = position / HISTORY_SLIDER_MAX;
    return playback.minTs + (playback.maxTs - playback.minTs) * ratio;
  }

  function historyPositionFromTimestamp(ts) {
    if (!Number.isFinite(ts) || !Number.isFinite(playback.minTs) ||
        !Number.isFinite(playback.maxTs) || playback.maxTs <= playback.minTs) {
      return HISTORY_SLIDER_MAX;
    }
    return AUR.clamp(
      ((ts - playback.minTs) / (playback.maxTs - playback.minTs)) * HISTORY_SLIDER_MAX,
      0,
      HISTORY_SLIDER_MAX
    );
  }

  function setHistoryTimestamp(ts, label = null) {
    if (!historyEls || !historyEls.time) return;
    const text = label || formatHistoryTime(ts);
    historyEls.time.textContent = text;
    if (Number.isFinite(ts)) {
      const iso = new Date(ts).toISOString();
      historyEls.time.dateTime = iso;
      historyEls.time.title = (playback.truncated ? 'Indexed range truncated · ' : '') + iso;
      historyEls.scrubber.setAttribute('aria-valuetext', text);
    } else {
      historyEls.time.removeAttribute('datetime');
      historyEls.time.title = '';
      historyEls.scrubber.removeAttribute('aria-valuetext');
    }
  }

  function flushHistoryPreview() {
    if (historyPreviewFrame !== null) cancelAnimationFrame(historyPreviewFrame);
    historyPreviewFrame = null;
    const ts = historyPendingPreviewTs;
    historyPendingPreviewTs = null;
    if (!Number.isFinite(ts)) return;
    historyPreviewTs = ts;
    historyPerf.previewFrames++;
    const position = historyPositionFromTimestamp(ts);
    historyEls.bar.style.setProperty('--history-progress', `${position / 100}%`);
    setHistoryTimestamp(ts);
  }

  function renderHistoryMarkers(hasRange) {
    if (!historyEls.markers || !historyEls.projectEvent) return;
    const projects = [...store.projects.values()]
      .filter((project) => Number.isFinite(project.firstSeen))
      .sort((a, b) => a.firstSeen - b.firstSeen || a.id.localeCompare(b.id));
    const visible = projects.slice(-HISTORY_MARKER_LIMIT);
    const key = `${playback.minTs}:${playback.maxTs}:${playback.mode}:` +
      visible.map((project) => (
        `${project.id}:${project.firstSeen}:${liveProjectEvents.has(project.id)}`
      )).join('|');
    if (key === historyMarkerKey) return;
    historyMarkerKey = key;
    AUR.clear(historyEls.markers);
    if (!hasRange) {
      historyEls.projectEvent.textContent = '';
      historyEls.projectEvent.classList.add('hidden');
      return;
    }
    for (const project of visible) {
      const marker = document.createElement('span');
      const live = playback.mode === 'live' && liveProjectEvents.has(project.id);
      const position = historyPositionFromTimestamp(project.firstSeen);
      marker.className = 'history-marker' + (live ? ' new' : '');
      marker.style.left = `${position / 100}%`;
      marker.title = `${project.name} · ${formatHistoryTime(project.firstSeen)}`;
      historyEls.markers.appendChild(marker);
    }
    const newestLive = playback.mode === 'live'
      ? [...visible].sort((a, b) => (
        (liveProjectEvents.get(b.id) || 0) - (liveProjectEvents.get(a.id) || 0)
      )).find((project) => liveProjectEvents.has(project.id))
      : null;
    historyEls.projectEvent.textContent = newestLive ? `NEW SYSTEM · ${newestLive.name}` : '';
    historyEls.projectEvent.classList.toggle('hidden', !newestLive);
  }

  function renderHistory() {
    if (!historyEls || !historyEls.bar) return;
    const replayMode = playback.mode === 'replay';
    const hasRange = playback.available && Number.isFinite(playback.minTs) &&
      Number.isFinite(playback.maxTs);
    const busy = replayBusy || playback.indexing;
    const shownTs = Number.isFinite(historyPreviewTs)
      ? historyPreviewTs
      : (replayMode ? playback.cursorTs : playback.maxTs);

    historyEls.bar.dataset.mode = replayMode ? 'replay' : 'live';
    historyEls.bar.dataset.playing = String(Boolean(playback.playing));
    historyEls.bar.dataset.indexing = String(Boolean(playback.indexing));
    historyEls.bar.dataset.truncated = String(Boolean(playback.truncated));
    historyEls.bar.classList.toggle('busy', replayBusy);
    document.body.dataset.playbackMode = replayMode ? 'replay' : 'live';

    historyEls.play.textContent = playback.playing ? 'Pause' : 'Play';
    historyEls.play.setAttribute('aria-label', playback.playing ? 'Pause history' : 'Play history');
    historyEls.play.disabled = !replayMode || !hasRange || busy;
    historyEls.speed.textContent = playback.speed + 'x';
    historyEls.speed.disabled = !replayMode || !hasRange || busy;
    historyEls.live.classList.toggle('active', !replayMode);
    historyEls.live.setAttribute('aria-pressed', String(!replayMode));
    historyEls.live.disabled = !replayMode || replayBusy;

    if (hasRange) {
      const fallback = replayMode ? playback.cursorTs : playback.maxTs;
      const value = Number.isFinite(shownTs) ? shownTs : fallback;
      const position = historyPositionFromTimestamp(value);
      historyEls.scrubber.value = String(position);
      historyEls.scrubber.dataset.minTs = String(playback.minTs);
      historyEls.scrubber.dataset.maxTs = String(playback.maxTs);
      historyEls.bar.style.setProperty('--history-progress', `${position / 100}%`);
      if (historyEls.start) {
        historyEls.start.textContent = formatHistoryEdge(playback.minTs);
        historyEls.start.dateTime = new Date(playback.minTs).toISOString();
      }
      if (historyEls.end) {
        historyEls.end.textContent = replayMode ? formatHistoryEdge(playback.maxTs) : 'LATEST';
        historyEls.end.dateTime = new Date(playback.maxTs).toISOString();
      }
    }
    historyEls.scrubber.disabled = !hasRange || busy;

    let label;
    if (Number.isFinite(historyPreviewTs)) label = formatHistoryTime(historyPreviewTs);
    else if (playback.indexing && !hasRange) label = 'INDEXING…';
    else if (!hasRange) label = 'NO HISTORY';
    else if (!replayMode) label = 'LIVE';
    else label = formatHistoryTime(playback.cursorTs);
    setHistoryTimestamp(shownTs, label);
    if (historyEls.context) {
      historyEls.context.textContent = replayMode ? 'HISTORY TIMELINE' : 'LIVE TIMELINE';
    }
    renderHistoryMarkers(hasRange);

    if (historyEls.feedMode && historyEls.feedLabel) {
      const feedState = replayMode ? (playback.playing ? 'replay' : 'paused') : 'live';
      historyEls.feedMode.className = 'panel-note feed-mode ' + feedState;
      historyEls.feedLabel.textContent = replayMode ? 'REPLAY' : 'LIVE';
    }
  }

  // ---------- debug / shots ----------
  function pickDemoProject() {
    let best = null;
    for (const p of store.projects.values()) {
      if (!p.exists) continue;
      if (!best || p.lastActivity > best.lastActivity) best = p;
    }
    if (best) return best;
    // fallback: any project at all
    for (const p of store.projects.values()) return p;
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
        if (p) await openSystem(p.id);
      } else if (view === 'planet') {
        const p = pickDemoProject();
        if (p) {
          let sys = null;
          try { sys = await AU.getSystem(p.id); } catch (e) { /* fall through */ }
          const planet = sys ? largestPlanet(sys.planets) : null;
          if (planet) await openPlanet(p.id, planet.name);
        }
      } else {
        if (current.view !== 'universe') showUniverse();
      }
    } catch (e) {
      AUR.log('debug-view handling issue:', view, e && e.message);
    }
    signalReadyOnce();
  }

  // Fire AU.debugReady() exactly once, after the active scene is ready and has
  // rendered one frame. Never from a recurring observable.
  function signalReadyOnce() {
    const scene = activeScene;
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
      if (next & CHROME_AGENTS) renderAgents();
      if (next & CHROME_FEED) renderFeed();
      if (next & CHROME_SUMMARY) renderSummary();
      if (next & CHROME_PROJECT) renderProjectCard();
      if (next & CHROME_PLANET) renderPlanetCard();
      if (next & CHROME_RECENT) renderRecent();
      if (next & CHROME_SEARCH) refreshProjectSearchFromStore();
      if (next & CHROME_SETTINGS) renderProjectSettings();
      if (next & CHROME_DIRECTORY) refreshProjectDirectoryFromStore();
      if (next & CHROME_IDEAS) renderIdeas();
      if (next & CHROME_FOCUS) renderAgentFocus();
      if (next & CHROME_HISTORY) renderHistory();
    });
  }

  function renderChrome() {
    renderAgents();
    renderFeed();
    renderSummary();
    renderProjectCard();
    renderPlanetCard();
    renderTabbar();
    renderBackButton();
    renderRecent();
    renderProjectSearchVisibility();
    renderProjectDirectory();
    renderProjectSettings();
    renderIdeas();
    renderHistory();
    renderAgentFocus();
  }

  // ---------- collapsible command rail ----------
  function readCommandRailState() {
    try {
      const value = JSON.parse(localStorage.getItem(COMMAND_RAIL_STORAGE_KEY) || 'null');
      if (!value || typeof value !== 'object') return;
      commandRail.compact = value.compact === true;
      commandRail.ideasCollapsed = value.ideasCollapsed === true;
      commandRail.agentsCollapsed = value.agentsCollapsed === true;
      commandRail.feedCollapsed = value.feedCollapsed === true;
    } catch (error) { /* use the roomy default */ }
  }

  function saveCommandRailState() {
    try {
      localStorage.setItem(COMMAND_RAIL_STORAGE_KEY, JSON.stringify({
        compact: commandRail.compact,
        ideasCollapsed: commandRail.ideasCollapsed,
        agentsCollapsed: commandRail.agentsCollapsed,
        feedCollapsed: commandRail.feedCollapsed,
      }));
    } catch (error) { /* persistence is a convenience, never a requirement */ }
  }

  function wireCommandRail() {
    commandRail.els = {
      root: document.getElementById('sidebar'),
      toggle: document.getElementById('command-rail-toggle'),
      ideasPanel: document.getElementById('ideas-panel'),
      ideasToggle: document.getElementById('ideas-panel-toggle'),
      ideasCompact: document.getElementById('compact-ideas-button'),
      ideasCompactCount: document.getElementById('compact-ideas-count'),
      agentsPanel: document.getElementById('agents-panel'),
      agentsToggle: document.getElementById('agents-panel-toggle'),
      agentsCompact: document.getElementById('compact-agents-button'),
      agentsCompactCount: document.getElementById('compact-agents-count'),
      feedPanel: document.getElementById('feed-panel'),
      feedToggle: document.getElementById('feed-panel-toggle'),
      feedCompact: document.getElementById('compact-feed-button'),
      feedCompactCount: document.getElementById('compact-feed-count'),
    };
    const els = commandRail.els;
    if (!els.root || !els.toggle || !els.ideasPanel || !els.ideasToggle ||
        !els.ideasCompact || !els.agentsPanel || !els.agentsToggle ||
        !els.agentsCompact || !els.feedPanel || !els.feedToggle || !els.feedCompact) return;
    readCommandRailState();
    els.toggle.addEventListener('click', () => {
      commandRail.compact = !commandRail.compact;
      applyCommandRailState();
      saveCommandRailState();
    });
    els.agentsToggle.addEventListener('click', () => {
      commandRail.agentsCollapsed = !commandRail.agentsCollapsed;
      applyCommandRailState();
      saveCommandRailState();
    });
    els.ideasToggle.addEventListener('click', () => {
      commandRail.ideasCollapsed = !commandRail.ideasCollapsed;
      applyCommandRailState();
      saveCommandRailState();
    });
    els.feedToggle.addEventListener('click', () => {
      commandRail.feedCollapsed = !commandRail.feedCollapsed;
      applyCommandRailState();
      saveCommandRailState();
    });
    els.ideasCompact.addEventListener('click', () => expandCommandRailSection('ideas'));
    els.agentsCompact.addEventListener('click', () => expandCommandRailSection('agents'));
    els.feedCompact.addEventListener('click', () => expandCommandRailSection('feed'));
    applyCommandRailState();
  }

  function expandCommandRailSection(section) {
    commandRail.compact = false;
    if (section === 'ideas') commandRail.ideasCollapsed = false;
    if (section === 'agents') commandRail.agentsCollapsed = false;
    if (section === 'feed') commandRail.feedCollapsed = false;
    applyCommandRailState();
    saveCommandRailState();
  }

  function applyCommandRailState() {
    const els = commandRail.els;
    if (!els) return;
    els.root.classList.toggle('compact', commandRail.compact);
    document.body.classList.toggle('command-rail-is-compact', commandRail.compact);
    els.toggle.setAttribute('aria-expanded', String(!commandRail.compact));
    els.toggle.setAttribute('aria-label', commandRail.compact
      ? 'Expand command rail' : 'Collapse command rail');
    els.toggle.title = commandRail.compact ? 'Expand command rail' : 'Collapse command rail';
    applyCommandSectionState(
      els.ideasPanel, els.ideasToggle, commandRail.ideasCollapsed,
      'task ideas'
    );
    applyCommandSectionState(
      els.agentsPanel, els.agentsToggle, commandRail.agentsCollapsed,
      'active agents'
    );
    applyCommandSectionState(
      els.feedPanel, els.feedToggle, commandRail.feedCollapsed,
      'event feed'
    );
  }

  function applyCommandSectionState(panel, toggle, collapsed, label) {
    panel.classList.toggle('collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', (collapsed ? 'Expand ' : 'Collapse ') + label);
  }

  const RECENT_MAX = 5;
  function renderRecent() {
    const nav = document.getElementById('recent');
    if (current.view !== 'universe') { nav.classList.add('hidden'); return; }
    const pills = document.getElementById('recent-pills');
    const recent = [...store.projects.values()]
      .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))
      .slice(0, RECENT_MAX);
    if (recent.length === 0) { nav.classList.add('hidden'); return; }
    nav.classList.remove('hidden');
    AUR.clear(pills);
    for (const p of recent) {
      const pill = AUR.el('div', 'recent-pill');
      pill.title = p.path || p.name;
      if (shipsInProject(p.id).length > 0) pill.appendChild(AUR.el('span', 'pill-dot'));
      pill.appendChild(AUR.el('span', 'pill-name', p.name));
      pill.addEventListener('click', () => jumpToProject(p.id));
      pills.appendChild(pill);
    }
  }

  // ---------- universe project search ----------
  function wireProjectSearch() {
    projectSearch.els = {
      root: document.getElementById('project-search'),
      input: document.getElementById('search-input'),
      results: document.getElementById('search-results'),
      filter: document.getElementById('project-vcs-filter'),
      filterCount: document.getElementById('project-vcs-filter-count'),
    };
    const els = projectSearch.els;
    if (!els.root || !els.input || !els.results) return;

    els.input.addEventListener('input', () => {
      cancelProjectSearchTimer();
      if (!els.input.value.trim()) {
        updateProjectSearch();
        return;
      }
      projectSearch.timer = setTimeout(() => {
        projectSearch.timer = null;
        updateProjectSearch();
      }, SEARCH_DEBOUNCE_MS);
    });

    els.input.addEventListener('focus', () => closeProjectDirectory(false));

    if (els.filter) {
      els.filter.addEventListener('click', () => {
        projectSearch.filter = projectSearch.filter === VCS.FILTERS.GITHUB
          ? VCS.FILTERS.ALL : VCS.FILTERS.GITHUB;
        updateProjectSearch();
        refreshProjectDirectoryFromStore();
      });
    }

    els.input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        clearProjectSearch();
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter') return;
      event.preventDefault();
      event.stopPropagation();
      flushProjectSearch();
      if (event.key === 'Enter') {
        activateProjectSearchResult(projectSearch.selected);
        return;
      }
      if (projectSearch.results.length === 0) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      projectSearch.selected = (projectSearch.selected + delta + projectSearch.results.length) %
        projectSearch.results.length;
      renderProjectSearchResults();
    });
  }

  function cancelProjectSearchTimer() {
    if (projectSearch.timer != null) clearTimeout(projectSearch.timer);
    projectSearch.timer = null;
  }

  function flushProjectSearch() {
    if (projectSearch.timer == null) return;
    cancelProjectSearchTimer();
    updateProjectSearch();
  }

  function clearProjectSearch() {
    cancelProjectSearchTimer();
    projectSearch.query = '';
    projectSearch.results = [];
    projectSearch.selected = 0;
    const els = projectSearch.els;
    if (els) {
      els.input.value = '';
      els.input.setAttribute('aria-expanded', 'false');
      els.input.removeAttribute('aria-activedescendant');
      els.results.classList.add('hidden');
      AUR.clear(els.results);
    }
    if (activeView && typeof activeView.setSearchMatches === 'function') {
      syncUniverseProjectMatches();
    }
  }

  function renderProjectSearchVisibility() {
    const els = projectSearch.els;
    if (!els) return;
    els.root.classList.toggle('hidden', current.view !== 'universe');
    renderProjectVcsFilter();
  }

  function renderProjectVcsFilter() {
    const els = projectSearch.els;
    if (!els || !els.filter) return;
    const githubCount = VCS.filterProjects([...store.projects.values()], {
      filter: VCS.FILTERS.GITHUB,
    }).length;
    const active = projectSearch.filter === VCS.FILTERS.GITHUB;
    els.filter.setAttribute('aria-pressed', String(active));
    els.filter.setAttribute('aria-label', active
      ? `Show all projects; ${githubCount} have GitHub repositories`
      : `Focus on the ${githubCount} projects with GitHub repositories`);
    els.filter.title = active ? 'Show all projects' : 'Focus on GitHub projects';
    if (els.filterCount) els.filterCount.textContent = String(githubCount);
  }

  function refreshProjectSearchFromStore() {
    const els = projectSearch.els;
    renderProjectSearchVisibility();
    if (!els || current.view !== 'universe') return;
    if (els.input.value.trim() || projectSearch.filter !== VCS.FILTERS.ALL) updateProjectSearch();
    else syncUniverseProjectMatches();
  }

  function matchingUniverseProjects(projects, query) {
    return VCS.filterProjects(projects, { filter: projectSearch.filter, query });
  }

  function syncUniverseProjectMatches(projects, query) {
    if (!activeView || typeof activeView.setSearchMatches !== 'function' ||
        current.view !== 'universe') return;
    const source = projects || [...store.projects.values()];
    const needle = query == null && projectSearch.els
      ? projectSearch.els.input.value.trim() : String(query || '').trim();
    const active = Boolean(needle) || projectSearch.filter !== VCS.FILTERS.ALL;
    activeView.setSearchMatches(active
      ? new Set(matchingUniverseProjects(source, needle).map((project) => project.id))
      : null);
  }

  function updateProjectSearch() {
    const els = projectSearch.els;
    if (!els || current.view !== 'universe') return;
    const query = els.input.value.trim();
    const queryChanged = query !== projectSearch.query;
    const previous = queryChanged ? null : projectSearch.results[projectSearch.selected];
    projectSearch.query = query;
    if (!query) {
      projectSearch.results = [];
      projectSearch.selected = 0;
      renderProjectSearchResults();
      syncUniverseProjectMatches();
      renderProjectVcsFilter();
      return;
    }

    const projects = [...store.projects.values()];
    const matches = matchingUniverseProjects(projects, query);
    const ranked = AUR.searchProjects(matches, query);
    const rankedIds = new Set(ranked.map((project) => project.id));
    const extras = matches.filter((project) => !rankedIds.has(project.id)).sort((a, b) =>
      String(a.name || a.id).localeCompare(String(b.name || b.id))
    );
    projectSearch.results = [...ranked, ...extras].slice(0, 8);
    const previousIndex = previous
      ? projectSearch.results.findIndex((project) => project.id === previous.id)
      : -1;
    projectSearch.selected = queryChanged ? 0 : previousIndex >= 0
      ? previousIndex : Math.min(projectSearch.selected, Math.max(0, projectSearch.results.length - 1));
    renderProjectSearchResults();
    syncUniverseProjectMatches(projects, query);
    renderProjectVcsFilter();
  }

  function projectSearchSubtitle(project) {
    const galaxy = typeof project.galaxy === 'string'
      ? project.galaxy
      : project.galaxy && (project.galaxy.label || project.galaxy.key);
    const detail = [];
    if (galaxy) detail.push(String(galaxy));
    const vcs = VCS.normalize(project);
    if (vcs.nameWithOwner) detail.push(vcs.nameWithOwner);
    if (vcs.branch) detail.push(vcs.branch);
    if (project.path) detail.push(String(project.path));
    return detail.join(' · ');
  }

  function renderProjectSearchResults() {
    const els = projectSearch.els;
    if (!els) return;
    const open = current.view === 'universe' && Boolean(els.input.value.trim());
    els.results.classList.toggle('hidden', !open);
    els.input.setAttribute('aria-expanded', String(open));
    AUR.clear(els.results);
    if (!open) {
      els.input.removeAttribute('aria-activedescendant');
      return;
    }
    if (projectSearch.results.length === 0) {
      els.results.appendChild(AUR.el('div', 'search-empty', 'No systems found'));
      els.input.removeAttribute('aria-activedescendant');
      return;
    }

    projectSearch.results.forEach((project, index) => {
      const selected = index === projectSearch.selected;
      const row = AUR.el('button', 'search-result' + (selected ? ' selected' : ''));
      row.type = 'button';
      row.id = 'search-result-' + index;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(selected));
      const dot = AUR.el('span', 'search-result-dot' +
        (shipsInProject(project.id).length > 0 ? ' live' : ''));
      const copy = AUR.el('span', 'search-result-copy');
      copy.appendChild(AUR.el('span', 'search-result-name', project.name || project.id));
      copy.appendChild(AUR.el('span', 'search-result-meta', projectSearchSubtitle(project)));
      row.appendChild(dot);
      row.appendChild(copy);
      row.addEventListener('click', () => activateProjectSearchResult(index));
      els.results.appendChild(row);
    });
    els.input.setAttribute('aria-activedescendant', 'search-result-' + projectSearch.selected);
    const selectedRow = els.results.querySelector('.search-result.selected');
    if (selectedRow) selectedRow.scrollIntoView({ block: 'nearest' });
  }

  function activateProjectSearchResult(index) {
    const project = projectSearch.results[index] || projectSearch.results[0];
    if (!project) return;
    clearProjectSearch();
    openSystem(project.id);
  }

  // ---------- searchable all-projects directory ----------
  function wireProjectDirectory() {
    projectDirectory.els = {
      button: document.getElementById('project-directory-button'),
      buttonCount: document.getElementById('project-directory-button-count'),
      panel: document.getElementById('project-directory'),
      scrim: document.getElementById('project-directory-scrim'),
      close: document.getElementById('project-directory-close'),
      subtitle: document.getElementById('project-directory-subtitle'),
      input: document.getElementById('project-directory-input'),
      list: document.getElementById('project-directory-list'),
    };
    const els = projectDirectory.els;
    if (!els.button || !els.buttonCount || !els.panel || !els.scrim || !els.close ||
        !els.subtitle || !els.input || !els.list) return;

    els.button.addEventListener('click', () => {
      if (projectDirectory.open) closeProjectDirectory();
      else openProjectDirectory();
    });
    els.close.addEventListener('click', () => closeProjectDirectory());
    els.scrim.addEventListener('click', () => closeProjectDirectory());
    els.input.addEventListener('input', () => {
      cancelProjectDirectoryTimer();
      projectDirectory.timer = setTimeout(() => {
        projectDirectory.timer = null;
        updateProjectDirectory();
      }, SEARCH_DEBOUNCE_MS);
    });
    els.input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeProjectDirectory();
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter') return;
      event.preventDefault();
      event.stopPropagation();
      flushProjectDirectory();
      if (event.key === 'Enter') {
        activateProjectDirectoryResult(projectDirectory.selected);
        return;
      }
      if (projectDirectory.results.length === 0) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      projectDirectory.selected = (
        projectDirectory.selected + delta + projectDirectory.results.length
      ) % projectDirectory.results.length;
      renderProjectDirectoryResults();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !projectDirectory.open) return;
      event.preventDefault();
      closeProjectDirectory();
    });
    renderProjectDirectory();
  }

  function openProjectDirectory() {
    const els = projectDirectory.els;
    if (!els || projectDirectory.open) return;
    clearProjectSearch();
    projectDirectory.open = true;
    projectDirectory.query = '';
    projectDirectory.selected = 0;
    els.input.value = '';
    updateProjectDirectory();
    requestAnimationFrame(() => els.input.focus());
  }

  function closeProjectDirectory(restoreFocus = true) {
    const els = projectDirectory.els;
    if (!els || !projectDirectory.open) return;
    cancelProjectDirectoryTimer();
    projectDirectory.open = false;
    projectDirectory.query = '';
    projectDirectory.results = [];
    projectDirectory.selected = 0;
    els.input.value = '';
    renderProjectDirectory();
    if (activeView && typeof activeView.setSearchMatches === 'function') {
      syncUniverseProjectMatches();
    }
    if (restoreFocus) els.button.focus();
  }

  function cancelProjectDirectoryTimer() {
    if (projectDirectory.timer != null) clearTimeout(projectDirectory.timer);
    projectDirectory.timer = null;
  }

  function flushProjectDirectory() {
    if (projectDirectory.timer == null) return;
    cancelProjectDirectoryTimer();
    updateProjectDirectory();
  }

  function projectsByActivity() {
    const activeCounts = new Map();
    for (const ship of store.ships.values()) {
      activeCounts.set(ship.project, (activeCounts.get(ship.project) || 0) + 1);
    }
    return [...store.projects.values()].sort((a, b) => {
      const activeDelta = (activeCounts.get(b.id) || 0) - (activeCounts.get(a.id) || 0);
      if (activeDelta !== 0) return activeDelta;
      const existsDelta = Number(b.exists !== false) - Number(a.exists !== false);
      if (existsDelta !== 0) return existsDelta;
      const activityDelta = (Number(b.lastActivity) || 0) - (Number(a.lastActivity) || 0);
      if (activityDelta !== 0) return activityDelta;
      return String(a.name || a.id).localeCompare(String(b.name || b.id));
    });
  }

  function updateProjectDirectory() {
    const els = projectDirectory.els;
    if (!els || !projectDirectory.open) return;
    const query = els.input.value.trim();
    const queryChanged = query !== projectDirectory.query;
    const previous = queryChanged ? null : projectDirectory.results[projectDirectory.selected];
    const allProjects = projectsByActivity();
    const projects = current.view === 'universe'
      ? VCS.filterProjects(allProjects, { filter: projectSearch.filter })
      : allProjects;
    projectDirectory.query = query;
    if (query) {
      const matches = VCS.filterProjects(projects, { query });
      const ranked = AUR.searchProjects(matches, query, Math.max(matches.length, 8));
      const rankedIds = new Set(ranked.map((project) => project.id));
      projectDirectory.results = [
        ...ranked,
        ...matches.filter((project) => !rankedIds.has(project.id)),
      ];
    } else {
      projectDirectory.results = projects;
    }
    const previousIndex = previous
      ? projectDirectory.results.findIndex((project) => project.id === previous.id)
      : -1;
    projectDirectory.selected = queryChanged ? 0 : previousIndex >= 0
      ? previousIndex
      : Math.min(projectDirectory.selected, Math.max(0, projectDirectory.results.length - 1));
    renderProjectDirectory();
    if (activeView && typeof activeView.setSearchMatches === 'function') {
      const active = Boolean(query) || projectSearch.filter !== VCS.FILTERS.ALL;
      activeView.setSearchMatches(active
        ? new Set(projectDirectory.results.map((project) => project.id))
        : null);
    }
  }

  function refreshProjectDirectoryFromStore() {
    renderProjectDirectory();
    if (projectDirectory.open) updateProjectDirectory();
  }

  function renderProjectDirectory() {
    const els = projectDirectory.els;
    if (!els) return;
    const total = store.projects.size;
    els.buttonCount.textContent = String(total);
    els.button.setAttribute('aria-label', `Open all projects, ${total} projects`);
    els.button.setAttribute('aria-expanded', String(projectDirectory.open));
    els.panel.classList.toggle('hidden', !projectDirectory.open);
    els.scrim.classList.toggle('hidden', !projectDirectory.open);
    els.input.setAttribute('aria-expanded', String(projectDirectory.open));
    if (!projectDirectory.open) {
      els.input.removeAttribute('aria-activedescendant');
      return;
    }
    const shown = projectDirectory.results.length;
    const githubOnly = current.view === 'universe' && projectSearch.filter === VCS.FILTERS.GITHUB;
    els.subtitle.textContent = projectDirectory.query || githubOnly
      ? `${shown} of ${total} projects${githubOnly ? ' · GitHub only' : ''}`
      : `${total} projects · active first`;
    renderProjectDirectoryResults();
  }

  function projectGalaxyLabel(project) {
    if (typeof project.galaxy === 'string') return project.galaxy;
    if (project.galaxy) return project.galaxy.label || project.galaxy.key || '';
    return '';
  }

  function renderProjectDirectoryResults() {
    const els = projectDirectory.els;
    if (!els || !projectDirectory.open) return;
    AUR.clear(els.list);
    if (projectDirectory.results.length === 0) {
      els.list.appendChild(AUR.el('div', 'project-directory-empty', 'No projects found'));
      els.input.removeAttribute('aria-activedescendant');
      return;
    }

    projectDirectory.results.forEach((project, index) => {
      const ships = shipsInProject(project.id);
      const active = ships.length > 0;
      const missing = project.exists === false;
      const selected = index === projectDirectory.selected;
      const row = AUR.el(
        'button', 'project-directory-row' + (active ? ' active' : '') +
          (missing ? ' missing' : '') + (selected ? ' selected' : '')
      );
      row.type = 'button';
      row.id = 'project-directory-result-' + index;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(selected));
      row.title = missing ? 'Recover this project path' : 'Open ' + (project.name || project.id);

      row.appendChild(AUR.el('span', 'project-directory-dot'));
      const copy = AUR.el('span', 'project-directory-copy');
      copy.appendChild(AUR.el('span', 'project-directory-name', project.name || project.id));
      copy.appendChild(AUR.el('span', 'project-directory-path', project.path || 'No path available'));
      row.appendChild(copy);

      const meta = AUR.el('span', 'project-directory-meta');
      const state = missing ? 'MISSING' : active
        ? `${ships.length} AGENT${ships.length === 1 ? '' : 'S'}`
        : AUR.relTime(project.lastActivity, playbackReferenceTs());
      meta.appendChild(AUR.el('span', 'project-directory-state', state));
      meta.appendChild(AUR.el('span', 'project-directory-galaxy', projectGalaxyLabel(project)));
      const vcsMarkers = AUR.el('span', 'project-directory-vcs');
      VCS.renderMarkers(vcsMarkers, project);
      meta.appendChild(vcsMarkers);
      row.appendChild(meta);
      row.addEventListener('click', () => activateProjectDirectoryResult(index));
      els.list.appendChild(row);
    });
    els.input.setAttribute(
      'aria-activedescendant', 'project-directory-result-' + projectDirectory.selected
    );
    const selectedRow = els.list.querySelector('.project-directory-row.selected');
    if (selectedRow) selectedRow.scrollIntoView({ block: 'nearest' });
  }

  function activateProjectDirectoryResult(index) {
    const project = projectDirectory.results[index] || projectDirectory.results[0];
    if (!project) return;
    closeProjectDirectory(false);
    if (project.exists === false) {
      openProjectSettings();
      return;
    }
    openSystem(project.id);
  }

  // ---------- project path settings ----------
  function wireProjectSettings() {
    projectSettings.els = {
      button: document.getElementById('settings-button'),
      count: document.getElementById('settings-count'),
      dialog: document.getElementById('settings-dialog'),
      shell: document.querySelector('#settings-dialog .settings-shell'),
      close: document.getElementById('settings-close'),
      summary: document.getElementById('settings-summary'),
      scan: document.getElementById('settings-scan'),
      status: document.getElementById('settings-status'),
      projects: document.getElementById('settings-projects'),
    };
    const els = projectSettings.els;
    if (!els.button || !els.dialog || !els.close || !els.scan || !els.projects) return;

    els.button.addEventListener('click', openProjectSettings);
    els.close.addEventListener('click', closeProjectSettings);
    els.scan.addEventListener('click', scanForProjectPaths);
    els.dialog.addEventListener('close', finishProjectSettingsClose);
    els.dialog.addEventListener('click', (event) => {
      if (event.target !== els.dialog || !els.shell) return;
      const rect = els.shell.getBoundingClientRect();
      const inside = event.clientX >= rect.left && event.clientX <= rect.right &&
        event.clientY >= rect.top && event.clientY <= rect.bottom;
      if (!inside) closeProjectSettings();
    });
    renderProjectSettings();
  }

  function missingPathProjects() {
    return [...store.projects.values()]
      .filter((project) => project && project.exists === false)
      .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
  }

  function openProjectSettings() {
    const els = projectSettings.els;
    if (!els || !els.dialog || projectSettings.open) return;
    clearProjectSearch();
    closeProjectDirectory(false);
    projectSettings.owner++;
    projectSettings.request++;
    projectSettings.open = true;
    projectSettings.busy = false;
    projectSettings.scanPerformed = false;
    projectSettings.scanRoot = '';
    projectSettings.matches.clear();
    projectSettings.status = '';
    projectSettings.error = false;
    els.button.setAttribute('aria-expanded', 'true');
    els.dialog.showModal();
    renderProjectSettings();
    requestAnimationFrame(() => {
      const target = !els.scan.disabled ? els.scan : els.close;
      target.focus();
    });
  }

  function closeProjectSettings() {
    const els = projectSettings.els;
    if (!els || !els.dialog || !els.dialog.open) return;
    els.dialog.close();
  }

  function finishProjectSettingsClose() {
    const els = projectSettings.els;
    projectSettings.owner++;
    projectSettings.request++;
    projectSettings.open = false;
    projectSettings.busy = false;
    projectSettings.scanPerformed = false;
    projectSettings.scanRoot = '';
    projectSettings.matches.clear();
    projectSettings.status = '';
    projectSettings.error = false;
    if (els && els.button) {
      els.button.setAttribute('aria-expanded', 'false');
      els.button.focus();
    }
    renderProjectSettings();
  }

  function projectPathErrorText(code) {
    if (code === 'REPLAY') return 'Return to LIVE before changing project paths.';
    if (code === 'BUSY') return 'Another folder picker or scan is already open.';
    if (code === 'IN_USE') return 'That folder is already assigned to another project.';
    if (code === 'EXPIRED') return 'That scan result expired. Scan the folder again.';
    if (code === 'NOT_FOUND') return 'The selected folder is no longer available.';
    if (code === 'NOT_MISSING') return 'This project path has already been recovered.';
    if (code === 'INVALID') return 'That folder cannot be used for this project.';
    return 'The project path could not be updated.';
  }

  function setProjectSettingsStatus(message, error = false) {
    projectSettings.status = message || '';
    projectSettings.error = Boolean(error);
  }

  function settingsRequestIsCurrent(owner, request) {
    return projectSettings.open && owner === projectSettings.owner && request === projectSettings.request;
  }

  function focusProjectSettingsControl(kind, projectId, token) {
    requestAnimationFrame(() => {
      if (!projectSettings.open || !projectSettings.els) return;
      const els = projectSettings.els;
      let target = null;
      if (kind === 'locate') {
        target = [...els.projects.querySelectorAll('.settings-locate')].find(
          (button) => button.dataset.projectId === projectId && !button.disabled
        );
      } else if (kind === 'candidate') {
        target = [...els.projects.querySelectorAll('.settings-candidate-use')].find(
          (button) => button.dataset.projectId === projectId &&
            button.dataset.token === token && !button.disabled
        );
      } else if (kind === 'first-candidate') {
        target = els.projects.querySelector('.settings-candidate-use:not(:disabled)');
      }
      if (!target && !els.scan.disabled) target = els.scan;
      if (!target) target = els.projects.querySelector('.settings-locate:not(:disabled)');
      if (!target) target = els.close;
      target.focus();
    });
  }

  async function scanForProjectPaths() {
    if (projectSettings.busy || playback.mode !== 'live') return;
    const owner = projectSettings.owner;
    const request = ++projectSettings.request;
    projectSettings.busy = true;
    setProjectSettingsStatus('Choose a parent folder to scan.');
    renderProjectSettings();
    projectSettings.els.close.focus();
    let result;
    try {
      result = await AU.projectPathsScan();
    } catch {
      result = { ok: false, code: 'FAILED' };
    }
    if (!settingsRequestIsCurrent(owner, request)) return;
    projectSettings.busy = false;
    if (!result || result.ok !== true) {
      setProjectSettingsStatus(projectPathErrorText(result && result.code), true);
      renderProjectSettings();
      focusProjectSettingsControl('scan');
      return;
    }
    if (result.canceled) {
      setProjectSettingsStatus('Scan canceled. No paths were changed.');
      renderProjectSettings();
      focusProjectSettingsControl('scan');
      return;
    }

    projectSettings.scanPerformed = true;
    projectSettings.scanRoot = typeof result.root === 'string' ? result.root : '';
    projectSettings.matches = new Map();
    for (const match of Array.isArray(result.matches) ? result.matches : []) {
      if (!match || typeof match.projectId !== 'string') continue;
      const candidates = (Array.isArray(match.candidates) ? match.candidates : []).filter(
        (candidate) => candidate && typeof candidate.token === 'string' &&
          typeof candidate.path === 'string'
      );
      projectSettings.matches.set(match.projectId, candidates);
    }
    const found = [...projectSettings.matches.values()].filter((items) => items.length > 0).length;
    const visited = Number.isFinite(result.directoriesVisited) ? result.directoriesVisited : 0;
    const suffix = result.truncated ? ' The bounded scan stopped early.' : '';
    const root = projectSettings.scanRoot ? ` under ${projectSettings.scanRoot}` : '';
    setProjectSettingsStatus(
      `Scanned ${visited.toLocaleString()} folders${root}; found matches for ${found} project${found === 1 ? '' : 's'}.${suffix}`
    );
    renderProjectSettings();
    focusProjectSettingsControl('first-candidate');
  }

  async function locateProjectPath(projectId) {
    if (projectSettings.busy || playback.mode !== 'live') return;
    const owner = projectSettings.owner;
    const request = ++projectSettings.request;
    projectSettings.busy = true;
    setProjectSettingsStatus('Choose the project folder.');
    renderProjectSettings();
    projectSettings.els.close.focus();
    let result;
    try {
      result = await AU.projectPathLocate(projectId);
    } catch {
      result = { ok: false, code: 'FAILED' };
    }
    if (!settingsRequestIsCurrent(owner, request)) return;
    projectSettings.busy = false;
    if (!result || result.ok !== true) {
      setProjectSettingsStatus(projectPathErrorText(result && result.code), true);
    } else if (result.canceled) {
      setProjectSettingsStatus('No folder selected. No paths were changed.');
    } else {
      projectSettings.matches.delete(projectId);
      setProjectSettingsStatus(`Recovered ${result.project && result.project.name || 'project'}.`);
    }
    renderProjectSettings();
    focusProjectSettingsControl(
      !result || result.ok !== true || result.canceled ? 'locate' : 'scan', projectId
    );
  }

  async function applyProjectPathCandidate(projectId, token) {
    if (projectSettings.busy || playback.mode !== 'live') return;
    const owner = projectSettings.owner;
    const request = ++projectSettings.request;
    projectSettings.busy = true;
    setProjectSettingsStatus('Applying the selected project folder…');
    renderProjectSettings();
    projectSettings.els.close.focus();
    let result;
    try {
      result = await AU.projectPathApply(projectId, token);
    } catch {
      result = { ok: false, code: 'FAILED' };
    }
    if (!settingsRequestIsCurrent(owner, request)) return;
    projectSettings.busy = false;
    if (!result || result.ok !== true) {
      setProjectSettingsStatus(projectPathErrorText(result && result.code), true);
      if (result && result.code === 'EXPIRED') projectSettings.matches.delete(projectId);
    } else {
      projectSettings.matches.delete(projectId);
      setProjectSettingsStatus(`Recovered ${result.project && result.project.name || 'project'}.`);
    }
    renderProjectSettings();
    focusProjectSettingsControl(
      !result || result.ok !== true ? 'candidate' : 'scan', projectId, token
    );
  }

  function renderProjectSettings() {
    const els = projectSettings.els;
    if (!els || !els.button || !els.count) return;
    const projects = missingPathProjects();
    const missingCount = projects.length;
    els.count.textContent = missingCount > 99 ? '99+' : String(missingCount);
    els.count.classList.toggle('hidden', missingCount === 0);
    els.button.setAttribute('aria-label', missingCount === 0
      ? 'Project path settings'
      : `Project path settings, ${missingCount} missing`);
    if (!projectSettings.open || !els.dialog || !els.dialog.open) return;

    const live = playback.mode === 'live' && !replayTransitionPending;
    els.summary.textContent = missingCount === 0
      ? 'All paths valid' : `${missingCount} missing`;
    els.summary.classList.toggle('clear', missingCount === 0);
    els.scan.disabled = projectSettings.busy || !live || missingCount === 0;
    els.scan.textContent = projectSettings.busy ? 'Working…' : 'Scan folder…';
    const visibleStatus = !live
      ? 'Return to LIVE before changing project paths.' : projectSettings.status;
    els.status.textContent = visibleStatus;
    els.status.classList.toggle('error', !live || projectSettings.error);

    AUR.clear(els.projects);
    if (missingCount === 0) {
      els.projects.appendChild(AUR.el('div', 'settings-empty', 'All known project folders are connected.'));
      return;
    }

    projects.forEach((project, projectIndex) => {
      const row = AUR.el('section', 'settings-project-row');
      const head = AUR.el('div', 'settings-project-head');
      const copy = AUR.el('div', 'settings-project-copy');
      const projectName = project.name || project.id;
      const name = AUR.el('div', 'settings-project-name', projectName);
      name.id = `settings-project-name-${projectIndex}`;
      row.setAttribute('aria-labelledby', name.id);
      copy.appendChild(name);
      copy.appendChild(AUR.el(
        'div', 'settings-project-path', project.path || 'No recorded folder path'
      ));
      const locate = AUR.el('button', 'settings-locate', 'Locate…');
      locate.type = 'button';
      locate.disabled = projectSettings.busy || !live;
      locate.dataset.projectId = project.id;
      locate.setAttribute('aria-label', `Locate folder for ${projectName}`);
      locate.addEventListener('click', () => locateProjectPath(project.id));
      head.appendChild(copy);
      head.appendChild(locate);
      row.appendChild(head);

      const candidates = projectSettings.matches.get(project.id) || [];
      if (candidates.length > 0) {
        const list = AUR.el('div', 'settings-candidates');
        const candidateLabel = AUR.el(
          'div', 'settings-candidates-label',
          candidates.length === 1 ? 'SCAN MATCH' : `${candidates.length} SCAN MATCHES`
        );
        candidateLabel.id = `settings-candidates-label-${projectIndex}`;
        list.setAttribute('role', 'group');
        list.setAttribute('aria-labelledby', candidateLabel.id);
        list.appendChild(candidateLabel);
        for (const candidate of candidates) {
          const candidateRow = AUR.el('div', 'settings-candidate');
          candidateRow.appendChild(AUR.el('div', 'settings-candidate-path', candidate.path));
          const use = AUR.el('button', 'settings-candidate-use', 'Use this folder');
          use.type = 'button';
          use.disabled = projectSettings.busy || !live;
          use.dataset.projectId = project.id;
          use.dataset.token = candidate.token;
          use.setAttribute('aria-label', `Use ${candidate.path} for ${projectName}`);
          use.addEventListener('click', () => applyProjectPathCandidate(project.id, candidate.token));
          candidateRow.appendChild(use);
          list.appendChild(candidateRow);
        }
        row.appendChild(list);
      } else if (projectSettings.scanPerformed) {
        row.appendChild(AUR.el(
          'div', 'settings-no-match', 'No exact folder-name match in the last scan.'
        ));
      }
      els.projects.appendChild(row);
    });
  }

  function shipsSorted() {
    const arr = [...store.ships.values()];
    arr.sort((a, b) => {
      const ma = AUR.attentionMeta(a.attention);
      const mb = AUR.attentionMeta(b.attention);
      const ra = ma ? ma.rank : 4;
      const rb = mb ? mb.rank : 4;
      return ra - rb;
    });
    return arr;
  }

  function projectName(id) {
    const p = store.projects.get(id);
    return p ? p.name : id;
  }

  function renderAgents() {
    const list = document.getElementById('agents-list');
    const count = document.getElementById('agents-count');
    const ships = shipsSorted();
    const railEls = commandRail.els;
    const agentsPanel = railEls && railEls.agentsPanel;
    if (agentsPanel) agentsPanel.classList.toggle('is-empty', ships.length === 0);
    if (railEls && railEls.agentsCompactCount) {
      railEls.agentsCompactCount.textContent = String(ships.length);
    }
    let needsYou = 0;
    for (const s of ships) {
      if (s.attention === 'question' || s.attention === 'permission') needsYou++;
    }
    count.textContent = needsYou > 0 ? needsYou + ' need you' : ships.length + ' Running';
    count.classList.toggle('needs-you', needsYou > 0);
    AUR.clear(list);
    if (ships.length === 0) {
      list.appendChild(AUR.el('div', 'empty-note', 'No agents in flight'));
      return;
    }
    for (const s of ships) {
      const provider = AUR.providerMeta(s.provider);
      const tint = AUR.shipTint(s.id, s.provider);
      const attention = AUR.attentionMeta(s.attention);
      const focused = agentFocus.shipId === String(s.id);
      const pending = agentFocus.pendingShipId === String(s.id);
      const row = AUR.el(
        'button',
        'agent-row clickable' + (s.kind === 'drone' ? ' drone' : '') +
          (focused ? ' focused' : '') + (pending ? ' pending' : '')
      );
      row.type = 'button';
      row.dataset.shipId = String(s.id);
      row.dataset.provider = provider.key;
      row.setAttribute('aria-pressed', String(focused));
      row.setAttribute('aria-busy', String(pending));
      row.setAttribute('aria-label', focused
        ? `Exit first-person view for ${s.name}`
        : `Enter first-person view for ${s.name} in ${projectName(s.project)}`);
      if (attention) {
        row.classList.add('has-attention');
        row.style.setProperty('--attention-color', attention.color);
      }
      row.title = focused ? 'Exit first-person view' : 'Enter first-person view';
      row.addEventListener('click', () => enterAgentFocus(s.id));
      const glyph = AUR.el('div', 'agent-glyph');
      glyph.innerHTML = AUR.shipSvg(tint, AUR.isSignalEntity(s));
      const body = AUR.el('div', 'agent-body');
      const nameLine = AUR.el('div', 'agent-name-line');
      const dot = AUR.el('span', 'agent-dot');
      const dotColor = attention ? attention.color : AUR.statusColor(s.status);
      dot.style.background = dotColor;
      dot.style.boxShadow = '0 0 7px ' + dotColor;
      if (s.attention === 'question' || s.attention === 'permission') {
        dot.classList.add('attention-pulse');
      }
      nameLine.appendChild(AUR.el('span', 'agent-name', s.name));
      nameLine.appendChild(dot);
      if (attention) {
        const badge = AUR.el('span', 'agent-attention-badge', attention.label);
        badge.style.color = attention.color;
        badge.style.borderColor = attention.color;
        badge.style.backgroundColor = attention.color + '1f';
        nameLine.appendChild(badge);
      }
      const sub = AUR.el('div', 'agent-sub');
      const providerTag = AUR.el('span', 'agent-provider-tag', provider.label.toUpperCase());
      providerTag.dataset.provider = provider.key;
      providerTag.style.color = provider.color;
      providerTag.style.borderColor = provider.color;
      providerTag.style.backgroundColor = provider.color + '17';
      const subText = AUR.el(
        'span', 'agent-sub-text', s.status + ' · ' + projectName(s.project)
      );
      sub.appendChild(providerTag);
      sub.appendChild(subText);
      body.appendChild(nameLine);
      body.appendChild(sub);
      row.appendChild(glyph);
      row.appendChild(body);
      list.appendChild(row);
    }
  }

  function renderFeed() {
    const list = document.getElementById('feed-list');
    AUR.clear(list);
    const rows = store.feed.slice(-FEED_SHOW).reverse();
    const railEls = commandRail.els;
    const feedPanel = railEls && railEls.feedPanel;
    if (feedPanel) feedPanel.classList.toggle('is-empty', rows.length === 0);
    if (railEls && railEls.feedCompactCount) {
      railEls.feedCompactCount.textContent = String(rows.length);
    }
    if (rows.length === 0) {
      list.appendChild(AUR.el('div', 'empty-note', 'No signals yet'));
      return;
    }
    for (const f of rows) {
      const row = AUR.el('div', 'feed-row' + (f.project ? ' clickable' : ''));
      if (f.project) {
        row.title = 'Go to ' + projectName(f.project);
        row.addEventListener('click', () => jumpToProject(f.project));
      }
      const dot = AUR.el('span', 'feed-dot');
      dot.style.background = AUR.feedColor(f.kind);
      const body = AUR.el('div', 'feed-body');
      body.appendChild(AUR.el('div', 'feed-text', f.text));
      body.appendChild(AUR.el('div', 'feed-time', AUR.relTime(f.ts, playbackReferenceTs())));
      row.appendChild(dot);
      row.appendChild(body);
      list.appendChild(row);
    }
  }

  function statBlock(num, label) {
    const b = AUR.el('div', 'stat');
    b.appendChild(AUR.el('div', 'stat-num', String(num)));
    b.appendChild(AUR.el('div', 'stat-label', label));
    return b;
  }

  function renderSummary() {
    const card = document.getElementById('summary-card');
    AUR.clear(card);
    let title, stats;
    if (current.view === 'system') {
      title = 'PROJECT SUMMARY';
      stats = projectSummaryStats(current.projectId);
    } else if (current.view === 'planet') {
      title = 'PLANET SUMMARY';
      stats = planetSummaryStats();
    } else {
      title = 'UNIVERSE SUMMARY';
      stats = universeSummaryStats();
    }
    card.appendChild(AUR.el('div', 'summary-title', title));
    const row = AUR.el('div', 'summary-stats');
    for (const [n, l] of stats) row.appendChild(statBlock(n, l));
    card.appendChild(row);
  }

  function universeSummaryStats() {
    const projects = store.projects.size;
    const active = store.ships.size;
    const online = new Set();
    for (const s of store.ships.values()) online.add(s.project);
    return [[projects, 'Projects'], [active, 'Active Agents'], [online.size, 'Systems Online']];
  }

  function shipsInProject(projectId) {
    const arr = [];
    for (const s of store.ships.values()) if (s.project === projectId) arr.push(s);
    return arr;
  }

  function projectSummaryStats(projectId) {
    const ships = shipsInProject(projectId);
    let building = 0, gathering = 0, exploring = 0;
    for (const s of ships) {
      if (s.status === 'Building') building++;
      else if (s.status === 'Gathering Resources') gathering++;
      else if (s.status === 'Exploring' || s.status === 'Scanning') exploring++;
    }
    return [[ships.length, 'Active Agents'], [building, 'Building'],
      [gathering, 'Gathering'], [exploring, 'Exploring']];
  }

  function planetSummaryStats() {
    const ships = shipsInProject(current.projectId);
    const pd = activeView && activeView.planetData ? activeView.planetData : null;
    const structures = pd ? pd.subdirs : 0;
    const resources = pd && pd.resources ? pd.resources.length : 0;
    const builds = pd ? pd.builds : 0;
    return [[ships.length, 'Active Agents'], [structures, 'Structures'],
      [resources, 'Resources'], [builds, 'Builds']];
  }

  // ---------- project card ----------
  function busiestStatus(ships) {
    if (ships.length === 0) return 'Dormant';
    for (const s of ships) if (s.status === 'Building') return 'Building';
    return ships[0].status;
  }

  function projectMarkSvg() {
    return '<svg class="pc-mark" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M12 3 L21 20 L3 20 Z" fill="#6c8cff" fill-opacity="0.85"/>' +
      '<path d="M12 3 L12 20 L3 20 Z" fill="#6c8cff" fill-opacity="0.45"/></svg>';
  }

  function ensureProjectControl(projectId) {
    if (projectControl.projectId !== projectId) {
      projectControl = {
        projectId,
        requestId: ++terminalRequestSerial,
        phase: 'idle',
        code: null,
      };
    }
    return projectControl;
  }

  function terminalFailureText(code) {
    if (code === 'UNAVAILABLE') return 'A terminal app is unavailable on this computer.';
    if (code === 'REPLAY') return 'Return to LIVE to open a terminal.';
    if (code === 'NOT_FOUND') return 'This project is unavailable.';
    if (code === 'BUSY') return 'A terminal launch was just requested.';
    if (code === 'INVALID') return 'The terminal request was rejected.';
    return 'Terminal launch failed. Try again.';
  }

  function projectControlPresentation(projectId) {
    const state = ensureProjectControl(projectId);
    if (playback.mode !== 'live') {
      return {
        phase: 'replay', disabled: true, busy: false,
        buttonText: 'Open Terminal', note: 'Return to LIVE to open a terminal.',
      };
    }
    if (replayTransitionPending || replayBusy) {
      return {
        phase: 'transition', disabled: true, busy: true,
        buttonText: 'Open Terminal', note: 'History view is changing.',
      };
    }
    if (state.phase === 'pending') {
      return {
        phase: 'pending', disabled: true, busy: true,
        buttonText: 'Opening\u2026', note: 'Requesting terminal launch\u2026',
      };
    }
    if (state.phase === 'success') {
      return {
        phase: 'success', disabled: false, busy: false,
        buttonText: 'Open Terminal', note: 'Terminal launch requested',
      };
    }
    if (state.phase === 'failure') {
      return {
        phase: 'failure', disabled: false, busy: false,
        buttonText: 'Open Terminal', note: terminalFailureText(state.code),
      };
    }
    return {
      phase: 'idle', disabled: false, busy: false,
      buttonText: 'Open Terminal', note: '',
    };
  }

  async function requestProjectTerminal(projectId) {
    const state = ensureProjectControl(projectId);
    if (state.phase === 'pending' || playback.mode !== 'live' ||
        replayTransitionPending || replayBusy) return;

    const requestId = ++terminalRequestSerial;
    projectControl = { projectId, requestId, phase: 'pending', code: null };
    renderProjectCard();
    renderAgentFocus();

    let result;
    try {
      result = await AU.openTerminal(projectId);
    } catch (error) {
      result = { ok: false, code: 'FAILED' };
    }
    if (projectControl.projectId !== projectId || projectControl.requestId !== requestId) return;

    const ok = Boolean(result && result.ok === true);
    const code = !ok && result && typeof result.code === 'string' ? result.code : 'FAILED';
    projectControl = {
      projectId,
      requestId,
      phase: ok ? 'success' : 'failure',
      code: ok ? null : code,
    };
    renderProjectCard();
    renderAgentFocus();
  }

  // ---------- root task ideas ----------
  function wireIdeasPanel() {
    ideaPanel.els = {
      panel: document.getElementById('ideas-panel'),
      count: document.getElementById('ideas-count'),
      list: document.getElementById('ideas-list'),
      form: document.getElementById('ideas-form'),
      input: document.getElementById('ideas-input'),
      create: document.getElementById('ideas-create'),
      status: document.getElementById('ideas-status'),
    };
    const els = ideaPanel.els;
    if (!els.panel || !els.count || !els.list || !els.form || !els.input ||
        !els.create || !els.status) return;
    els.form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = els.input.value.trim();
      if (!text || ideaPanel.busy || playback.mode !== 'live') return;
      mutateIdea(() => AU.rootTaskCreate(text), 'Idea created', true);
    });
  }

  function handleRootTasksChanged() {
    if (ideaPanel.busy) {
      ideaPanel.refreshAfterBusy = true;
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
    if (!ideaPanel.els || ideaPanel.busy) {
      if (ideaPanel.busy) ideaPanel.refreshAfterBusy = true;
      return;
    }
    const request = ++ideaPanel.request;
    let result = null;
    try { result = await AU.rootTasksGet(); } catch (error) { /* retain the last good list */ }
    if (request !== ideaPanel.request || !result) return;
    ideaPanel.items = rootTaskItemsFrom(result);
    renderIdeas();
  }

  function liveIdeaProjects() {
    return [...store.projects.values()]
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
      project.id, project.name, project.path, projectGalaxyLabel(project), project.exists,
    ]);
    return JSON.stringify([ideaPanel.visibleLimit, itemState, projectState]);
  }

  function retryIdeaCopy(phase) {
    if (phase === 'prepared') return 'Assignment needs to resume before the goal is confirmed';
    if (phase === 'goal-written') return 'Goal is ready in GOALS.md';
    if (phase === 'reopened') return 'Goal was reopened after review';
    return 'Goal remains in GOALS.md';
  }

  function ideaMutationsDisabled() {
    return ideaPanel.busy || playback.mode !== 'live' || replayTransitionPending;
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
    const requested = ideaPanel.focusAfterRender;
    ideaPanel.focusAfterRender = null;
    const targetState = requested || previous;
    if (previous && Number.isFinite(previous.scrollTop)) list.scrollTop = previous.scrollTop;
    if (!targetState) return;
    if (!targetState.id && targetState.action === 'idea-input') {
      if (ideaPanel.els && ideaPanel.els.input) {
        ideaPanel.els.input.focus({ preventScroll: true });
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

  function renderIdeas() {
    const els = ideaPanel.els;
    if (!els || !els.panel) return;
    const projects = liveIdeaProjects();
    const replay = playback.mode !== 'live' || replayTransitionPending;
    const disabled = ideaMutationsDisabled();
    els.panel.classList.toggle('is-empty', ideaPanel.items.length === 0);
    els.panel.setAttribute('aria-busy', String(ideaPanel.busy));
    els.count.textContent = `${ideaPanel.items.length} idea${ideaPanel.items.length === 1 ? '' : 's'}`;
    if (commandRail.els && commandRail.els.ideasCompactCount) {
      commandRail.els.ideasCompactCount.textContent = String(ideaPanel.items.length);
    }
    const nextRenderKey = ideaRenderKey(ideaPanel.items, projects);
    if (nextRenderKey !== ideaPanel.renderKey) {
      const previousFocus = ideaFocusedControl(els.list);
      ideaPanel.renderKey = nextRenderKey;
      AUR.clear(els.list);
      if (ideaPanel.items.length === 0) {
        els.list.appendChild(AUR.el(
          'div', 'empty-note', 'Capture an idea, then assign it to a project'
        ));
      } else {
        const visibleItems = ideaPanel.items.slice(0, ideaPanel.visibleLimit);
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

          const assigned = item.projectId ? store.projects.get(item.projectId) : null;
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
              const detail = projectSearchSubtitle(project);
              select.appendChild(new Option(detail ? `${name} — ${detail}` : name, project.id));
            }
            const selected = ideaPanel.selections.get(item.id) || '';
            if (projects.some((project) => project.id === selected)) select.value = selected;
            select.addEventListener('change', () => {
              ideaPanel.selections.set(item.id, select.value);
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
            view.addEventListener('click', () => jumpToProject(item.projectId));
            controls.appendChild(view);
            row.appendChild(controls);
          }
          els.list.appendChild(row);
        }
        if (visibleItems.length < ideaPanel.items.length) {
          const remaining = ideaPanel.items.length - visibleItems.length;
          const showMore = AUR.el(
            'button', 'idea-action idea-show-more',
            `Show ${Math.min(100, remaining)} more`
          );
          showMore.type = 'button';
          showMore.dataset.ideaAction = 'show-more';
          showMore.addEventListener('click', () => {
            const firstNewItem = ideaPanel.items[ideaPanel.visibleLimit];
            ideaPanel.visibleLimit += 100;
            ideaPanel.focusAfterRender = firstNewItem
              ? { id: firstNewItem.id, action: null, reveal: true } : null;
            ideaPanel.renderKey = '';
            renderIdeas();
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
    els.status.textContent = replay ? 'Return to LIVE to create or start tasks.' : ideaPanel.status;
    els.status.classList.toggle('error', !replay && ideaPanel.error);
  }

  function assignIdea(id, projectId) {
    if (!projectId) return;
    const project = store.projects.get(projectId);
    const label = project ? project.name : 'project';
    mutateIdea(() => AU.rootTaskAssign(id, projectId), `Assigned to ${label}; agent start requested`);
  }

  function retryIdea(id) {
    mutateIdea(() => AU.rootTaskRetry(id), 'Agent start requested again');
  }

  function removeIdea(item) {
    const index = ideaPanel.items.findIndex((entry) => entry.id === item.id);
    mutateIdea(() => AU.rootTaskRemove(item.id), 'Idea removed', false, () => {
      ideaPanel.selections.delete(item.id);
      ideaPanel.items = ideaPanel.items.filter((entry) => entry.id !== item.id);
      const next = ideaPanel.items[Math.min(index, ideaPanel.items.length - 1)] || null;
      ideaPanel.focusAfterRender = next
        ? { id: next.id, action: 'remove', reveal: true }
        : { id: null, action: 'idea-input' };
      ideaPanel.renderKey = '';
    });
  }

  async function mutateIdea(operation, successText, clearInput = false, onSuccess = null) {
    if (ideaPanel.busy || playback.mode !== 'live' || replayTransitionPending) return;
    ideaPanel.busy = true;
    ideaPanel.refreshAfterBusy = false;
    ideaPanel.status = '';
    ideaPanel.error = false;
    renderIdeas();
    let result = null;
    try { result = await operation(); } catch (error) { /* bounded failure below */ }
    ideaPanel.busy = false;
    if (result && result.ok === true) {
      ideaPanel.status = successText;
      ideaPanel.error = false;
      if (clearInput && ideaPanel.els) ideaPanel.els.input.value = '';
      if (typeof onSuccess === 'function') onSuccess(result);
    } else {
      ideaPanel.status = ideaFailureText(result && result.code);
      ideaPanel.error = true;
    }
    const refreshAgain = ideaPanel.refreshAfterBusy;
    ideaPanel.refreshAfterBusy = false;
    renderIdeas();
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
    if (!update || update.projectId !== taskPanel.projectId ||
        current.view !== 'system' || playback.mode !== 'live') return;
    if (taskPanel.saving) {
      taskPanel.refreshAfterSave = true;
      return;
    }
    refreshTasks(taskPanel.owner);
  }

  function wireTasksPanel() {
    taskPanel.els = {
      panel: document.getElementById('tasks-panel'),
      count: document.getElementById('tasks-count'),
      list: document.getElementById('tasks-list'),
      form: document.getElementById('tasks-form'),
      input: document.getElementById('tasks-input'),
      add: document.getElementById('tasks-add'),
      status: document.getElementById('tasks-status'),
    };
    const els = taskPanel.els;
    if (!els.panel || !els.count || !els.list || !els.form || !els.input || !els.add ||
        !els.status) return;
    els.form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!taskPanel.trusted || taskPanel.saving) return;
      const text = els.input.value.trim();
      if (!text) return;
      addTask(text);
    });
  }

  function stopTasksView() {
    taskPanel.owner++;
    taskPanel.request++;
    if (taskPanel.interval != null) clearInterval(taskPanel.interval);
    taskPanel.interval = null;
    taskPanel.projectId = null;
    taskPanel.items = [];
    taskPanel.trusted = false;
    taskPanel.saving = false;
    taskPanel.refreshAfterSave = false;
    taskPanel.status = '';
    taskPanel.error = false;
    taskPanel.focusAfterRender = null;
    if (taskPanel.els && taskPanel.els.panel) {
      taskPanel.els.panel.classList.add('hidden');
      taskPanel.els.panel.removeAttribute('aria-busy');
    }
  }

  function startTasksView(projectId) {
    taskPanel.projectId = projectId;
    const owner = taskPanel.owner;
    refreshTasks(owner);
    taskPanel.interval = setInterval(() => refreshTasks(owner), 10_000);
  }

  function taskOwnerIsActive(owner, projectId) {
    return owner === taskPanel.owner && current.view === 'system' &&
      current.projectId === projectId && taskPanel.projectId === projectId;
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
    const projectId = taskPanel.projectId;
    if (!taskOwnerIsActive(owner, projectId) || taskPanel.saving) return;
    const request = ++taskPanel.request;
    let result = null;
    try { result = await AU.tasksGet(projectId); } catch (error) { /* hidden on trust/read failure */ }
    if (!taskOwnerIsActive(owner, projectId) || request !== taskPanel.request) return;
    if (!result) {
      taskPanel.trusted = false;
      renderTasksPanel();
      return;
    }
    taskPanel.trusted = true;
    taskPanel.items = taskItemsFrom(result);
    renderTasksPanel();
  }

  async function addTask(text) {
    return mutateTasks(() => AU.taskAdd(taskPanel.projectId, text), true, {
      successText: 'Task added',
    });
  }

  async function setTaskDone(item, done) {
    const request = {
      ...(typeof item.id === 'string' ? { id: item.id } : { line: item.line }),
      text: item.text,
      done,
    };
    return mutateTasks(() => AU.taskSetDone(taskPanel.projectId, request), false);
  }

  async function removeTask(item, index) {
    if (item.id || !confirmRemoval('Remove this project task?', item.text)) return;
    const request = { line: item.line, text: item.text };
    return mutateTasks(() => AU.taskRemove(taskPanel.projectId, request), false, {
      successText: 'Task removed',
      failureText: 'The task could not be removed. Refresh and try again.',
      focusIndex: index,
    });
  }

  async function mutateTasks(operation, clearInput, options = {}) {
    const owner = taskPanel.owner;
    const projectId = taskPanel.projectId;
    if (!taskOwnerIsActive(owner, projectId) || !taskPanel.trusted || taskPanel.saving) return;
    taskPanel.saving = true;
    taskPanel.refreshAfterSave = false;
    taskPanel.status = '';
    taskPanel.error = false;
    const request = ++taskPanel.request;
    renderTasksPanel();
    let result = null;
    try { result = await operation(); } catch (error) { /* refresh below */ }
    if (!taskOwnerIsActive(owner, projectId) || request !== taskPanel.request) return;
    taskPanel.saving = false;
    const refreshAfterSave = taskPanel.refreshAfterSave;
    taskPanel.refreshAfterSave = false;
    if (result && result.ok === true && Array.isArray(result.items)) {
      taskPanel.items = taskItemsFrom(result);
      if (clearInput && taskPanel.els) taskPanel.els.input.value = '';
      taskPanel.status = options.successText || '';
      if (Number.isSafeInteger(options.focusIndex)) {
        taskPanel.focusAfterRender = taskPanel.items.length > 0
          ? { index: Math.min(options.focusIndex, taskPanel.items.length - 1), action: 'remove' }
          : { action: 'input' };
      }
      renderTasksPanel();
      if (refreshAfterSave) refreshTasks(owner);
      return;
    }
    taskPanel.status = options.failureText || 'The task could not be updated.';
    taskPanel.error = true;
    if (Number.isSafeInteger(options.focusIndex)) {
      taskPanel.focusAfterRender = {
        index: Math.min(options.focusIndex, Math.max(0, taskPanel.items.length - 1)),
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
    const els = taskPanel.els;
    if (!els || !els.panel) return;
    if (!taskPanel.trusted || current.view !== 'system' ||
        current.projectId !== taskPanel.projectId) {
      els.panel.classList.add('hidden');
      return;
    }

    els.panel.classList.remove('hidden');
    els.panel.setAttribute('aria-busy', String(taskPanel.saving));
    const done = taskPanel.items.filter((item) => item.done).length;
    els.count.textContent = `${done} / ${taskPanel.items.length} done`;
    const previousFocus = taskFocusState(els.list);
    const scrollTop = els.list.scrollTop;
    AUR.clear(els.list);
    if (taskPanel.items.length === 0) {
      els.list.appendChild(AUR.el('div', 'tasks-empty', 'No goals yet — add one'));
    } else {
      taskPanel.items.forEach((item, index) => {
        const row = AUR.el('div', 'task-row' + (item.done ? ' done' : ''));
        row.dataset.taskIndex = String(index);
        const toggle = AUR.el('button', 'task-toggle');
        toggle.type = 'button';
        toggle.disabled = taskPanel.saving;
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
          remove.disabled = taskPanel.saving;
          remove.setAttribute('aria-label', 'Remove task');
          remove.setAttribute('aria-describedby', taskText.id);
          remove.title = 'Remove task';
          remove.addEventListener('click', () => removeTask(item, index));
          row.appendChild(remove);
        }
        els.list.appendChild(row);
      });
    }
    els.status.textContent = taskPanel.status;
    els.status.classList.toggle('error', taskPanel.error);
    els.input.disabled = taskPanel.saving;
    els.add.disabled = taskPanel.saving;
    els.list.scrollTop = scrollTop;
    const requestedFocus = taskPanel.focusAfterRender;
    taskPanel.focusAfterRender = null;
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
    positionTasksPanel();
  }

  function positionTasksPanel() {
    const els = taskPanel.els;
    if (!els || !els.panel || els.panel.classList.contains('hidden')) return;
    const project = document.getElementById('project-card');
    const summary = document.getElementById('summary-card');
    if (!project || project.classList.contains('hidden')) return;
    const top = Math.ceil(project.getBoundingClientRect().bottom + 12);
    const summaryTop = summary ? summary.getBoundingClientRect().top : window.innerHeight;
    const available = Math.max(154, Math.floor(summaryTop - top - 12));
    els.panel.style.top = top + 'px';
    els.panel.style.maxHeight = available + 'px';
  }

  function renderProjectCard() {
    const card = document.getElementById('project-card');
    if (current.view === 'universe' || !current.projectId) { card.classList.add('hidden'); return; }
    const p = store.projects.get(current.projectId);
    if (!p) { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');
    card.dataset.view = current.view;
    AUR.clear(card);

    const head = AUR.el('div', 'pc-head');
    const mark = document.createElement('span');
    mark.innerHTML = projectMarkSvg();
    head.appendChild(mark.firstChild);
    head.appendChild(AUR.el('div', 'pc-title', 'PROJECT: ' + p.name));
    card.appendChild(head);

    const ships = shipsInProject(p.id);
    const needsYou = ships.some(
      (s) => s.attention === 'question' || s.attention === 'permission'
    );
    const state = needsYou ? 'Needs You' : busiestStatus(ships);
    card.appendChild(pcRow('STATE', state, state === 'Building', needsYou ? 'needs-you' : null));
    card.appendChild(pcRow('BUILDS', String(p.totalBuilds || 0)));
    card.appendChild(pcRow('LAST SIGNAL', AUR.relTime(p.lastActivity, playbackReferenceTs())));

    if (current.view === 'system') {
      const repository = AUR.el('div', 'project-card-vcs');
      VCS.renderDetails(repository, p, {
        onOpenRepository(url) {
          if (typeof AU.openExternal === 'function') AU.openExternal(url);
        },
      });
      card.appendChild(repository);
    }

    if (p.exists) {
      const actions = AUR.el('div', 'pc-actions');
      const folder = AUR.el('button', 'pc-btn', 'Open Folder');
      folder.id = 'project-open-folder';
      folder.type = 'button';
      folder.addEventListener('click', () => { AU.openProject(p.id); });
      actions.appendChild(folder);

      const presentation = projectControlPresentation(p.id);
      const terminal = AUR.el('button', 'pc-btn project-terminal', presentation.buttonText);
      terminal.id = 'project-terminal';
      terminal.type = 'button';
      terminal.disabled = presentation.disabled;
      terminal.setAttribute('aria-label', 'Open Terminal');
      terminal.setAttribute('aria-describedby', 'project-control-status');
      terminal.setAttribute('aria-busy', String(presentation.busy));
      terminal.dataset.state = presentation.phase;
      terminal.addEventListener('click', () => { requestProjectTerminal(p.id); });
      actions.appendChild(terminal);
      card.appendChild(actions);

      const status = AUR.el('div', 'project-control-status', presentation.note);
      status.id = 'project-control-status';
      status.dataset.state = presentation.phase;
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      status.setAttribute('aria-atomic', 'true');
      card.appendChild(status);
    }
    positionTasksPanel();
  }

  function pcRow(key, val, accent, tone) {
    const row = AUR.el('div', 'pc-row');
    row.appendChild(AUR.el('div', 'pc-key', key));
    const v = AUR.el('div', 'pc-val' + (accent ? ' accent' : '') + (tone ? ' ' + tone : ''), val);
    row.appendChild(v);
    return row;
  }

  // ---------- planet card ----------
  function renderPlanetCard() {
    const card = document.getElementById('planet-card');
    if (current.view !== 'planet') { card.classList.add('hidden'); return; }
    const pd = activeView && activeView.planetData ? activeView.planetData : null;
    if (!pd) { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');
    AUR.clear(card);

    const ships = shipsInProject(current.projectId);
    const active = ships.length > 0;

    const titleLine = AUR.el('div', 'plc-title-line');
    titleLine.appendChild(AUR.el('div', 'plc-title', 'PLANET: ' + String(pd.name).toUpperCase()));
    card.appendChild(titleLine);

    const status = AUR.el('div', 'plc-status');
    const sdot = AUR.el('span', 'agent-dot');
    sdot.style.background = active ? '#34d399' : '#8b93a8';
    sdot.style.boxShadow = active ? '0 0 7px #34d399' : 'none';
    status.appendChild(sdot);
    status.appendChild(document.createTextNode(active ? 'Active' : 'Dormant'));
    card.appendChild(status);

    const rows = AUR.el('div', 'plc-rows');
    rows.appendChild(pcRow('TYPE', pd.procedural ? 'Unknown' : 'Terrestrial'));
    rows.appendChild(pcRow('RESOURCES', (pd.resources && pd.resources.length) ? pd.resources.join(', ') : '—'));
    rows.appendChild(pcRow('MASS', (pd.files || 0) + ' files'));
    rows.appendChild(pcRow('DIAMETER', (pd.sizeKb || 0) + ' KB'));
    rows.appendChild(pcRow('STRUCTURES', String(pd.subdirs || 0)));
    card.appendChild(rows);

    card.appendChild(AUR.el('div', 'bars-title', 'PLANET STATUS'));
    card.appendChild(bar('Infrastructure', (pd.subdirs || 0) / 10));
    card.appendChild(bar('Resources', (pd.files || 0) / 500));
    card.appendChild(bar('Build Energy', (pd.builds || 0) / 50));
  }

  function bar(key, frac) {
    const pct = Math.round(AUR.clamp(frac, 0, 1) * 100);
    const row = AUR.el('div', 'bar-row');
    row.appendChild(AUR.el('div', 'bar-key', key));
    const track = AUR.el('div', 'bar-track');
    const fill = AUR.el('div', 'bar-fill');
    fill.style.width = pct + '%';
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(AUR.el('div', 'bar-val', pct + '%'));
    return row;
  }

  // ---------- tab bar ----------
  const TABS = ['Overview', 'Surface', 'Orbit', 'Resources', 'Structures', 'Scans'];
  function tabIco() {
    return '<svg class="tab-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.6" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="8"/>' +
      '<circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/></svg>';
  }
  function renderTabbar() {
    const bar = document.getElementById('tabbar');
    if (current.view !== 'planet') { bar.classList.add('hidden'); return; }
    if (bar.childElementCount) { bar.classList.remove('hidden'); return; }
    bar.classList.remove('hidden');
    AUR.clear(bar);
    TABS.forEach((t, i) => {
      const tab = AUR.el('div', 'tab' + (i === 0 ? ' active' : ' disabled'));
      const ico = document.createElement('span');
      ico.innerHTML = tabIco();
      tab.appendChild(ico.firstChild);
      tab.appendChild(AUR.el('span', null, t));
      bar.appendChild(tab);
    });
  }

  function renderBackButton() {
    const btn = document.getElementById('back-btn');
    if (current.view === 'universe') { btn.classList.add('hidden'); return; }
    btn.classList.remove('hidden');
    btn.textContent = current.view === 'planet'
      ? '← ' + (projectName(current.projectId) || 'System')
      : '← Universe';
  }

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
    const scene = activeScene && !activeScene.isDisposed ? activeScene : null;
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
    if (engine) {
      for (const item of engine.scenes || []) if (!item.isDisposed) liveSceneCount++;
    }
    return {
      streamEpoch,
      playback: { ...playback },
      store: {
        projectCount: store.projects.size,
        shipCount: store.ships.size,
        feedCount: store.feed.length,
        totalBuilds: [...store.projects.values()]
          .reduce((sum, project) => sum + (Number(project.totalBuilds) || 0), 0),
        latestActivity: [...store.projects.values()]
          .reduce((latest, project) => Math.max(latest, Number(project.lastActivity) || 0), 0),
      },
      controls: {
        playText: historyEls && historyEls.play ? historyEls.play.textContent : '',
        speedText: historyEls && historyEls.speed ? historyEls.speed.textContent : '',
        timeText: historyEls && historyEls.time ? historyEls.time.textContent : '',
        livePressed: Boolean(historyEls && historyEls.live &&
          historyEls.live.getAttribute('aria-pressed') === 'true'),
        scrubberDisabled: Boolean(historyEls && historyEls.scrubber && historyEls.scrubber.disabled),
        scrubberValue: historyEls && historyEls.scrubber ? Number(historyEls.scrubber.value) : null,
        feedMode: historyEls && historyEls.feedLabel ? historyEls.feedLabel.textContent : '',
        contextText: historyEls && historyEls.context ? historyEls.context.textContent : '',
        startText: historyEls && historyEls.start ? historyEls.start.textContent : '',
        endText: historyEls && historyEls.end ? historyEls.end.textContent : '',
        markerCount: historyEls && historyEls.markers
          ? historyEls.markers.querySelectorAll('.history-marker').length : 0,
        newMarkerCount: historyEls && historyEls.markers
          ? historyEls.markers.querySelectorAll('.history-marker.new').length : 0,
        projectEventText: historyEls && historyEls.projectEvent
          ? historyEls.projectEvent.textContent : '',
      },
      performance: { ...historyPerf },
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
  AUR.historyStats = historyTestMetrics;

  // ---------- go ----------
  boot().catch((e) => {
    console.error('[boot-failure]', e && e.message ? e.message : e);
  });
})();

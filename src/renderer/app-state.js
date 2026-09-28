// app-state.js — shared app-layer state (AUR.app.state) and constants (AUR.app.const).
'use strict';

(function () {
  const AUR = window.AUR;
  const VCS = AUR.ProjectVcsStatus;

  const C = {
    FEED_CAP: 60,
    FEED_SHOW: 30,
    NOTIFICATION_SHIP_THROTTLE_MS: 30_000,
    NOTIFICATION_GLOBAL_THROTTLE_MS: 10_000,
    REPLAY_SPEEDS: [1, 10, 100, 1000],
    HISTORY_SLIDER_MAX: 10_000,
    HISTORY_MARKER_LIMIT: 24,
    SEARCH_DEBOUNCE_MS: 120,
    COMMAND_RAIL_STORAGE_KEY: 'agent-universe.command-rail.v1',
    AGENT_FOCUS_ENVIRONMENT_STORAGE_KEY: 'agent-universe.focus-environment.v1',
    AGENT_FOCUS_VANTAGE_STORAGE_KEY: 'agent-universe.focus-vantage.v1',
    AGENT_FOCUS_ENVIRONMENTS: Object.freeze({
      cockpit: { label: 'COCKPIT LINK', asset: 'assets/cockpit-frame.png' },
      quarters: { label: 'LIVING QUARTERS', asset: 'assets/environment-quarters.png' },
      office: { label: 'ORBITAL OFFICE', asset: 'assets/environment-office.png' },
      station: { label: 'STATION OBSERVATORY', asset: 'assets/environment-station.png' },
    }),
    AGENT_FOCUS_VANTAGES: Object.freeze({
      forward: 'FORWARD',
      starboard: 'STARBOARD',
      aft: 'AFT',
      port: 'PORT',
    }),
  };

  const S = {
    // ---------- store ----------
    store: {
      projects: new Map(), // id -> Project
      ships: new Map(),    // id -> Ship
      feed: [],            // chronological FeedEntry[], capped
    },

    notificationByShip: new Map(),
    liveProjectEvents: new Map(),
    lastNotificationAt: -Infinity,

    // ---------- runtime ----------
    engine: null,
    canvas: null,
    activeView: null,   // { scene, update, dispose }
    activeScene: null,
    current: { view: 'universe', projectId: null, planetName: null },
    routeRequestGeneration: 0,
    booting: true,
    bootEventQueue: [],
    bootVcsQueue: [],
    lastEventSequence: -Infinity,
    streamEpoch: null,
    retiredEpochs: new Set(),
    deferredEpochBatches: [],
    transitionEventQueue: [],
    replayTransitionPending: false,
    replayRequest: 0,
    replayBusy: false,
    historyPreviewTs: null,
    historyPreviewFrame: null,
    historyPendingPreviewTs: null,
    historyMarkerKey: '',
    historyPerf: {
      inputEvents: 0,
      previewFrames: 0,
      seekRequests: 0,
      maxInputHandlerMs: 0,
    },
    historyEls: null,
    terminalRequestSerial: 0,
    projectControl: {
      projectId: null,
      requestId: 0,
      phase: 'idle',
      code: null,
    },
    taskPanel: {
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
    },
    ideaPanel: {
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
    },
    projectSearch: {
      timer: null,
      query: '',
      filter: VCS.FILTERS.ALL,
      results: [],
      selected: 0,
      els: null,
    },
    projectDirectory: {
      open: false,
      timer: null,
      query: '',
      results: [],
      selected: 0,
      els: null,
    },
    commandRail: {
      compact: false,
      ideasCollapsed: false,
      agentsCollapsed: false,
      feedCollapsed: false,
      els: null,
    },
    agentFocus: {
      shipId: null,
      pendingShipId: null,
      previousFocus: null,
      lastFlightUpdate: 0,
      environment: 'cockpit',
      vantage: 'forward',
      els: null,
    },
    projectSettings: {
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
    },
    playback: {
      mode: 'live', available: false, indexing: true,
      minTs: null, maxTs: null, cursorTs: null,
      playing: false, speed: 1, truncated: false,
    },
  };

  AUR.app = { state: S, const: C };
})();

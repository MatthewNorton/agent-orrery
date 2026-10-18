// @ts-check
// First-person agent focus: POV overlay, hologram, navigation map.
'use strict';

(function () {
  const AUR = window.AUR;
  const AU = window.AU;
  const A = AUR.app;
  if (!A) throw new Error('app/state.js must load before app/agent-focus.js');
  const S = A.state, C = A.const;

  // ---------- first-person agent focus ----------
  const AGENT_FOCUS_INERT_IDS = [
    'topbar', 'sidebar', 'back-btn', 'project-card', 'tasks-panel',
    'planet-card', 'summary-card', 'tabbar', 'history-bar',
    'rail-left', 'view-title', 'view-hint', 'needs-you-panel',
  ];

  A.wireAgentFocus = function wireAgentFocus() {
    S.agentFocus.els = {
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
    const els = S.agentFocus.els;
    if (!els.root || !els.frame || !els.exit || !els.folder || !els.terminal) return;
    let environment = 'cockpit';
    try {
      const stored = localStorage.getItem(C.AGENT_FOCUS_ENVIRONMENT_STORAGE_KEY);
      if (stored && Object.hasOwn(C.AGENT_FOCUS_ENVIRONMENTS, stored)) environment = stored;
    } catch (e) { /* storage can be unavailable in hardened renderers */ }
    setAgentFocusEnvironment(environment, false);
    let vantage = 'forward';
    try {
      const stored = localStorage.getItem(C.AGENT_FOCUS_VANTAGE_STORAGE_KEY);
      if (stored && Object.hasOwn(C.AGENT_FOCUS_VANTAGES, stored)) vantage = stored;
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
    for (const item of Object.values(C.AGENT_FOCUS_ENVIRONMENTS)) {
      if (item.asset === els.frame.getAttribute('src')) continue;
      const preload = new Image();
      preload.src = item.asset;
    }
    els.exit.addEventListener('click', () => A.exitAgentFocus(true));
    els.folder.addEventListener('click', () => {
      const ship = S.store.ships.get(S.agentFocus.shipId);
      if (ship) AU.openProject(ship.project);
    });
    els.terminal.addEventListener('click', () => {
      const ship = S.store.ships.get(S.agentFocus.shipId);
      if (ship) A.requestProjectTerminal(ship.project);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !S.agentFocus.shipId) return;
      event.preventDefault();
      event.stopPropagation();
      A.exitAgentFocus(true);
    });
  };

  function setAgentFocusEnvironment(value, persist) {
    const key = typeof value === 'string' && Object.hasOwn(C.AGENT_FOCUS_ENVIRONMENTS, value)
      ? value : 'cockpit';
    const config = C.AGENT_FOCUS_ENVIRONMENTS[key];
    S.agentFocus.environment = key;
    const els = S.agentFocus.els;
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
    try { localStorage.setItem(C.AGENT_FOCUS_ENVIRONMENT_STORAGE_KEY, key); } catch (e) { /* ignore */ }
  }

  function setAgentFocusVantage(value, persist) {
    const key = typeof value === 'string' && Object.hasOwn(C.AGENT_FOCUS_VANTAGES, value)
      ? value : 'forward';
    S.agentFocus.vantage = key;
    const els = S.agentFocus.els;
    if (els && els.root) els.root.dataset.vantage = key;
    if (els && els.vantages) {
      for (const button of els.vantages.querySelectorAll('[data-vantage]')) {
        button.setAttribute('aria-pressed', String(button.dataset.vantage === key));
      }
    }
    if (S.activeView && typeof S.activeView.setShipFocusVantage === 'function') {
      S.activeView.setShipFocusVantage(key);
    }
    if (!persist) return;
    try { localStorage.setItem(C.AGENT_FOCUS_VANTAGE_STORAGE_KEY, key); } catch (e) { /* ignore */ }
  }

  function setAgentFocusInert(value) {
    for (const id of AGENT_FOCUS_INERT_IDS) {
      const element = document.getElementById(id);
      if (element) element.inert = value;
    }
  }

  A.enterAgentFocus = async function enterAgentFocus(shipId) {
    const id = String(shipId || '');
    if (!id || S.agentFocus.pendingShipId) return;
    if (S.agentFocus.shipId === id) {
      A.exitAgentFocus(true);
      return;
    }
    const selected = S.store.ships.get(id);
    if (!selected || !selected.project || !S.store.projects.has(selected.project)) return;
    if (S.agentFocus.shipId) A.exitAgentFocus(false);

    S.agentFocus.previousFocus = document.activeElement;
    S.agentFocus.pendingShipId = id;
    A.renderAgents();
    if (S.current.view !== 'system' || S.current.projectId !== selected.project) {
      await A.openSystem(selected.project);
    }

    const ship = S.store.ships.get(id);
    const canFocus = ship && S.current.view === 'system' && S.current.projectId === ship.project &&
      S.activeView && typeof S.activeView.focusShip === 'function' && S.activeView.focusShip(id);
    S.agentFocus.pendingShipId = null;
    if (!canFocus) {
      A.renderAgents();
      return;
    }

    setAgentFocusVantage(S.agentFocus.vantage, false);
    S.agentFocus.shipId = id;
    document.body.classList.add('agent-focus-active');
    setAgentFocusInert(true);
    A.renderAgentFocus();
    A.renderAgents();
    requestAnimationFrame(() => {
      if (S.agentFocus.shipId === id && S.agentFocus.els && S.agentFocus.els.exit) {
        S.agentFocus.els.exit.focus({ preventScroll: true });
      }
    });
  };

  A.exitAgentFocus = function exitAgentFocus(restoreFocus) {
    const id = S.agentFocus.shipId || S.agentFocus.pendingShipId;
    S.agentFocus.pendingShipId = null;
    if (S.activeView && typeof S.activeView.clearShipFocus === 'function') {
      S.activeView.clearShipFocus();
      A.refreshShipHulls(); // promotions wait while focus mode fades the ships
    }
    S.agentFocus.shipId = null;
    document.body.classList.remove('agent-focus-active');
    setAgentFocusInert(false);
    A.renderAgentFocus();
    A.renderAgents();
    if (!restoreFocus) return;
    requestAnimationFrame(() => {
      const previous = S.agentFocus.previousFocus;
      const fallback = id
        ? document.querySelector(`.agent-row[data-ship-id="${CSS.escape(String(id))}"]`)
        : null;
      const target = previous && previous.isConnected ? previous : fallback;
      if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
    });
  };

  A.renderAgentFocus = function renderAgentFocus() {
    const els = S.agentFocus.els;
    if (!els || !els.root) return;
    const ship = S.agentFocus.shipId ? S.store.ships.get(S.agentFocus.shipId) : null;
    const visible = Boolean(ship && S.current.view === 'system' &&
      S.current.projectId === ship.project && S.activeView);
    els.root.classList.toggle('hidden', !visible);
    if (!visible) return;

    const project = S.store.projects.get(ship.project);
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
    A.renderAgentFocusFlightTarget();
    els.provider.textContent = [provider.label, AUR.modelLabel(ship)].filter(Boolean).join(' · ');
    els.status.textContent = attention ? attention.label : ship.status;
    els.project.textContent = project ? project.name : ship.project;
    els.folder.disabled = !project || project.exists === false;

    const presentation = A.projectControlPresentation(ship.project);
    els.terminal.textContent = presentation.buttonText;
    els.terminal.disabled = presentation.disabled;
    els.terminal.setAttribute('aria-busy', String(presentation.busy));
    els.terminal.dataset.state = presentation.phase;
    els.actionStatus.textContent = presentation.note;
    els.actionStatus.dataset.state = presentation.phase;
  };

  function renderAgentFocusHologram(project) {
    const els = S.agentFocus.els;
    if (!els || !els.hologramSystem) return;
    const systemPlanets = S.activeView && S.activeView.systemData &&
      Array.isArray(S.activeView.systemData.planets)
      ? S.activeView.systemData.planets : [];
    const planets = systemPlanets.slice(0, 7);
    const names = planets.map((planet) => String(planet.name || 'body'));
    const projectId = project ? project.id : S.current.projectId;
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
    const els = S.agentFocus.els;
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

    const state = S.activeView && typeof S.activeView.shipFocusState === 'function'
      ? S.activeView.shipFocusState() : null;
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
      const ship = S.store.ships.get(state.shipId);
      els.hologramShipLabel.textContent = String(ship && ship.name || 'SHIP').toUpperCase();
    }
  }

  A.renderAgentFocusFlightTarget = function renderAgentFocusFlightTarget() {
    const els = S.agentFocus.els;
    if (!S.agentFocus.shipId || !els || !els.target || !S.activeView) return;
    renderAgentFocusNavigationMap();
    const flight = typeof S.activeView.shipFocusState === 'function'
      ? S.activeView.shipFocusState() : null;
    const target = flight && flight.target
      ? String(flight.target).toUpperCase() : 'SYSTEM PATROL';
    if (els.target.textContent !== target) els.target.textContent = target;
  };
})();

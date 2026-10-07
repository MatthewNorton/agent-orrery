// @ts-check
// app-chrome.js — collapsible command rail, recent strip, agents/feed/summary renderers, tab bar.
'use strict';

(function () {
  const AUR = window.AUR;
  const A = AUR.app;               // created by app-state.js; throw if missing
  if (!A) throw new Error('app-state.js must load before app-chrome.js');
  const S = A.state, C = A.const;

  // ---------- collapsible command rail ----------
  function readCommandRailState() {
    try {
      const value = JSON.parse(localStorage.getItem(C.COMMAND_RAIL_STORAGE_KEY) || 'null');
      if (!value || typeof value !== 'object') return;
      S.commandRail.compact = value.compact === true;
      S.commandRail.ideasCollapsed = value.ideasCollapsed === true;
      S.commandRail.agentsCollapsed = value.agentsCollapsed === true;
      S.commandRail.feedCollapsed = value.feedCollapsed === true;
    } catch (error) { /* use the roomy default */ }
  }

  function saveCommandRailState() {
    try {
      localStorage.setItem(C.COMMAND_RAIL_STORAGE_KEY, JSON.stringify({
        compact: S.commandRail.compact,
        ideasCollapsed: S.commandRail.ideasCollapsed,
        agentsCollapsed: S.commandRail.agentsCollapsed,
        feedCollapsed: S.commandRail.feedCollapsed,
      }));
    } catch (error) { /* persistence is a convenience, never a requirement */ }
  }

  A.wireCommandRail = function wireCommandRail() {
    S.commandRail.els = {
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
    const els = S.commandRail.els;
    if (!els.root || !els.toggle || !els.ideasPanel || !els.ideasToggle ||
        !els.ideasCompact || !els.agentsPanel || !els.agentsToggle ||
        !els.agentsCompact || !els.feedPanel || !els.feedToggle || !els.feedCompact) return;
    readCommandRailState();
    els.toggle.addEventListener('click', () => {
      S.commandRail.compact = !S.commandRail.compact;
      applyCommandRailState();
      saveCommandRailState();
    });
    els.agentsToggle.addEventListener('click', () => {
      S.commandRail.agentsCollapsed = !S.commandRail.agentsCollapsed;
      applyCommandRailState();
      saveCommandRailState();
    });
    els.ideasToggle.addEventListener('click', () => {
      S.commandRail.ideasCollapsed = !S.commandRail.ideasCollapsed;
      applyCommandRailState();
      saveCommandRailState();
    });
    els.feedToggle.addEventListener('click', () => {
      S.commandRail.feedCollapsed = !S.commandRail.feedCollapsed;
      applyCommandRailState();
      saveCommandRailState();
    });
    els.ideasCompact.addEventListener('click', () => expandCommandRailSection('ideas'));
    els.agentsCompact.addEventListener('click', () => expandCommandRailSection('agents'));
    els.feedCompact.addEventListener('click', () => expandCommandRailSection('feed'));
    applyCommandRailState();
  };

  function expandCommandRailSection(section) {
    S.commandRail.compact = false;
    if (section === 'ideas') S.commandRail.ideasCollapsed = false;
    if (section === 'agents') S.commandRail.agentsCollapsed = false;
    if (section === 'feed') S.commandRail.feedCollapsed = false;
    applyCommandRailState();
    saveCommandRailState();
  }

  function applyCommandRailState() {
    const els = S.commandRail.els;
    if (!els) return;
    els.root.classList.toggle('compact', S.commandRail.compact);
    document.body.classList.toggle('command-rail-is-compact', S.commandRail.compact);
    els.toggle.setAttribute('aria-expanded', String(!S.commandRail.compact));
    els.toggle.setAttribute('aria-label', S.commandRail.compact
      ? 'Expand command rail' : 'Collapse command rail');
    els.toggle.title = S.commandRail.compact ? 'Expand command rail' : 'Collapse command rail';
    applyCommandSectionState(
      els.ideasPanel, els.ideasToggle, S.commandRail.ideasCollapsed,
      'task ideas'
    );
    applyCommandSectionState(
      els.agentsPanel, els.agentsToggle, S.commandRail.agentsCollapsed,
      'active agents'
    );
    applyCommandSectionState(
      els.feedPanel, els.feedToggle, S.commandRail.feedCollapsed,
      'event feed'
    );
  }

  function applyCommandSectionState(panel, toggle, collapsed, label) {
    panel.classList.toggle('collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', (collapsed ? 'Expand ' : 'Collapse ') + label);
  }

  const RECENT_MAX = 5;
  A.renderRecent = function renderRecent() {
    const nav = document.getElementById('recent');
    if (S.current.view !== 'universe') { nav.classList.add('hidden'); return; }
    const pills = document.getElementById('recent-pills');
    const recent = [...S.store.projects.values()]
      .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))
      .slice(0, RECENT_MAX);
    if (recent.length === 0) { nav.classList.add('hidden'); return; }
    nav.classList.remove('hidden');
    AUR.clear(pills);
    for (const p of recent) {
      const pill = AUR.el('div', 'recent-pill');
      pill.title = p.path || p.name;
      if (A.shipsInProject(p.id).length > 0) pill.appendChild(AUR.el('span', 'pill-dot'));
      pill.appendChild(AUR.el('span', 'pill-name', p.name));
      pill.addEventListener('click', () => A.jumpToProject(p.id));
      pills.appendChild(pill);
    }
  };

  // ---------- agents / feed / summary renderers ----------
  function shipsSorted() {
    const arr = [...S.store.ships.values()];
    arr.sort((a, b) => {
      const ma = AUR.attentionMeta(a.attention);
      const mb = AUR.attentionMeta(b.attention);
      const ra = ma ? ma.rank : 4;
      const rb = mb ? mb.rank : 4;
      return ra - rb;
    });
    return arr;
  }

  A.projectName = function projectName(id) {
    const p = S.store.projects.get(id);
    return p ? p.name : id;
  };

  A.renderAgents = function renderAgents() {
    const list = document.getElementById('agents-list');
    const count = document.getElementById('agents-count');
    const ships = shipsSorted();
    const railEls = S.commandRail.els;
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
      const focused = S.agentFocus.shipId === String(s.id);
      const pending = S.agentFocus.pendingShipId === String(s.id);
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
        : `Enter first-person view for ${s.name} in ${A.projectName(s.project)}`);
      if (attention) {
        row.classList.add('has-attention');
        row.style.setProperty('--attention-color', attention.color);
      }
      row.title = focused ? 'Exit first-person view' : 'Enter first-person view';
      row.addEventListener('click', () => A.enterAgentFocus(s.id));
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
        'span', 'agent-sub-text', s.status + ' · ' + A.projectName(s.project)
      );
      sub.appendChild(providerTag);
      sub.appendChild(subText);
      body.appendChild(nameLine);
      body.appendChild(sub);
      row.appendChild(glyph);
      row.appendChild(body);
      list.appendChild(row);
    }
  };

  A.renderFeed = function renderFeed() {
    const list = document.getElementById('feed-list');
    AUR.clear(list);
    const rows = S.store.feed.slice(-C.FEED_SHOW).reverse();
    const railEls = S.commandRail.els;
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
        row.title = 'Go to ' + A.projectName(f.project);
        row.addEventListener('click', () => A.jumpToProject(f.project));
      }
      const dot = AUR.el('span', 'feed-dot');
      dot.style.background = AUR.feedColor(f.kind);
      const body = AUR.el('div', 'feed-body');
      body.appendChild(AUR.el('div', 'feed-text', f.text));
      body.appendChild(AUR.el('div', 'feed-time', AUR.relTime(f.ts, A.playbackReferenceTs())));
      row.appendChild(dot);
      row.appendChild(body);
      list.appendChild(row);
    }
  };

  function statBlock(num, label) {
    const b = AUR.el('div', 'stat');
    b.appendChild(AUR.el('div', 'stat-num', String(num)));
    b.appendChild(AUR.el('div', 'stat-label', label));
    return b;
  }

  A.renderSummary = function renderSummary() {
    const card = document.getElementById('summary-card');
    AUR.clear(card);
    let title, stats;
    if (S.current.view === 'system') {
      title = 'PROJECT SUMMARY';
      stats = projectSummaryStats(S.current.projectId);
    } else if (S.current.view === 'planet') {
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
  };

  function universeSummaryStats() {
    const projects = S.store.projects.size;
    const active = S.store.ships.size;
    const online = new Set();
    for (const s of S.store.ships.values()) online.add(s.project);
    return [[projects, 'Projects'], [active, 'Active Agents'], [online.size, 'Systems Online']];
  }

  A.shipsInProject = function shipsInProject(projectId) {
    const arr = [];
    for (const s of S.store.ships.values()) if (s.project === projectId) arr.push(s);
    return arr;
  };

  function projectSummaryStats(projectId) {
    const ships = A.shipsInProject(projectId);
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
    const ships = A.shipsInProject(S.current.projectId);
    const pd = S.activeView && S.activeView.planetData ? S.activeView.planetData : null;
    const structures = pd ? pd.subdirs : 0;
    const resources = pd && pd.resources ? pd.resources.length : 0;
    const builds = pd ? pd.builds : 0;
    return [[ships.length, 'Active Agents'], [structures, 'Structures'],
      [resources, 'Resources'], [builds, 'Builds']];
  }

  // ---------- tab bar ----------
  const TABS = ['Overview', 'Surface', 'Orbit', 'Resources', 'Structures', 'Scans'];
  function tabIco() {
    return '<svg class="tab-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.6" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="8"/>' +
      '<circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/></svg>';
  }
  A.renderTabbar = function renderTabbar() {
    const bar = document.getElementById('tabbar');
    if (S.current.view !== 'planet') { bar.classList.add('hidden'); return; }
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
  };

  A.renderBackButton = function renderBackButton() {
    const btn = document.getElementById('back-btn');
    if (S.current.view === 'universe') { btn.classList.add('hidden'); return; }
    btn.classList.remove('hidden');
    btn.textContent = S.current.view === 'planet'
      ? '← ' + (A.projectName(S.current.projectId) || 'System')
      : '← Universe';
  };
})();

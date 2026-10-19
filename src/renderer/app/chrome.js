// @ts-check
// Compact command rail, agents/feed/summary renderers, tab bar.
'use strict';

(function () {
  const AUR = window.AUR;
  const A = AUR.app;
  if (!A) throw new Error('app/state.js must load before app/chrome.js');
  const S = A.state, C = A.const;

  // ---------- command rail: the rail and its sections fold through app/modules.js ----------
  const RAIL_SECTIONS = ['ideas', 'agents', 'feed', 'galaxies'];

  A.wireCommandRail = function wireCommandRail() {
    /** @type {Record<string, HTMLElement | null>} */
    const els = {};
    for (const key of RAIL_SECTIONS) {
      els[key + 'Panel'] = document.getElementById(`${key}-panel`);
      els[key + 'Compact'] = document.getElementById(`compact-${key}-button`);
      els[key + 'CompactCount'] = document.getElementById(`compact-${key}-count`);
    }
    S.commandRail.els = els;
    for (const key of RAIL_SECTIONS) {
      // A compact-rail button opens the rail on that section, unfolded.
      const button = els[key + 'Compact'];
      if (button) button.addEventListener('click', () => {
        A.setModuleCollapsed('rail-right', false);
        A.setModuleCollapsed(key, false);
      });
    }
  };

  /**
   * A rail section's count on its compact button; `empty`, when given, also marks the section.
   * @param {string} key @param {number} n @param {boolean} [empty]
   */
  A.setRailCount = function setRailCount(key, n, empty) {
    const els = S.commandRail.els;
    if (!els) return;
    const panel = els[key + 'Panel'];
    const count = els[key + 'CompactCount'];
    if (panel && typeof empty === 'boolean') panel.classList.toggle('is-empty', empty);
    if (count) count.textContent = String(n);
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

  /** What a list calls a project: its name, or its id when it has none. */
  A.projectLabel = function projectLabel(project) {
    return project.name || project.id;
  };

  /** A sort comparator on projectLabel, with no id tiebreak. */
  A.byProjectName = function byProjectName(a, b) {
    return String(A.projectLabel(a)).localeCompare(String(A.projectLabel(b)));
  };

  A.activePlanetData = function activePlanetData() {
    return S.activeView && S.activeView.planetData ? S.activeView.planetData : null;
  };

  /** How many projects have a ship in flight. */
  A.onlineProjectCount = function onlineProjectCount() {
    const online = new Set();
    for (const s of S.store.ships.values()) online.add(s.project);
    return online.size;
  };

  A.renderAgents = function renderAgents() {
    const list = document.getElementById('agents-list');
    const count = document.getElementById('agents-count');
    const ships = shipsSorted();
    A.setRailCount('agents', ships.length, ships.length === 0);
    let needsYou = 0;
    for (const s of ships) {
      if (AUR.needsYou(s.attention)) needsYou++;
    }
    count.textContent = needsYou > 0 ? needsYou + ' need you' : ships.length + ' Running';
    count.classList.toggle('needs-you', needsYou > 0);
    A.renderNeedsYou(ships);
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
      const row = AUR.button(
        'agent-row clickable' + (s.kind === 'drone' ? ' drone' : '') +
          (focused ? ' focused' : '') + (pending ? ' pending' : ''),
        null,
        () => A.enterAgentFocus(s.id)
      );
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
      const glyph = AUR.el('div', 'agent-glyph');
      glyph.innerHTML = AUR.shipSvg(tint, AUR.isSignalEntity(s));
      const body = AUR.el('div', 'agent-body');
      const nameLine = AUR.el('div', 'agent-name-line');
      const dot = AUR.el('span', 'agent-dot');
      const dotColor = attention ? attention.color : AUR.statusColor(s.status);
      dot.style.background = dotColor;
      dot.style.boxShadow = '0 0 7px ' + dotColor;
      if (AUR.needsYou(s.attention)) dot.classList.add('attention-pulse');
      nameLine.append(AUR.el('span', 'agent-name', s.name), dot);
      if (attention) {
        const badge = AUR.el('span', 'agent-attention-badge', attention.label);
        badge.style.color = attention.color;
        badge.style.borderColor = attention.color;
        badge.style.backgroundColor = attention.color + '1f';
        nameLine.appendChild(badge);
      }
      const modelLabel = AUR.modelLabel(s);
      if (modelLabel) nameLine.appendChild(AUR.el('span', 'agent-model-tag' + (s.local ? ' local' : ''), modelLabel));
      const sub = AUR.el('div', 'agent-sub');
      const providerTag = AUR.el('span', 'agent-provider-tag', provider.label.toUpperCase());
      providerTag.dataset.provider = provider.key;
      providerTag.style.color = provider.color;
      providerTag.style.borderColor = provider.color;
      providerTag.style.backgroundColor = provider.color + '17';
      const subText = AUR.el(
        'span', 'agent-sub-text', s.status + ' · ' + A.projectName(s.project)
      );
      sub.append(providerTag, subText);
      body.append(nameLine, sub);
      row.append(glyph, body);
      list.appendChild(row);
    }
  };

  A.renderFeed = function renderFeed() {
    const list = document.getElementById('feed-list');
    AUR.clear(list);
    const rows = S.store.feed.slice(-C.FEED_SHOW).reverse();
    A.setRailCount('feed', rows.length, rows.length === 0);
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
      body.append(
        AUR.el('div', 'feed-text', f.text),
        AUR.el('div', 'feed-time', AUR.relTime(f.ts, A.playbackReferenceTs()))
      );
      row.append(dot, body);
      list.appendChild(row);
    }
  };

  function statBlock(num, label) {
    const b = AUR.el('div', 'stat');
    b.append(AUR.el('div', 'stat-label', label), AUR.el('div', 'stat-num', String(num)));
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
    A.moduleHead(card, title);
    const row = AUR.el('div', 'summary-stats stats');
    for (const [n, l] of stats) row.appendChild(statBlock(n, l));
    card.appendChild(row);
    A.renderViewTitle();
    A.renderBuildHistogram();
  };

  function universeSummaryStats() {
    return [[S.store.projects.size, 'Projects'], [S.store.ships.size, 'Agents'],
      [A.onlineProjectCount(), 'Online']];
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
    return [[ships.length, 'Agents'], [building, 'Building'],
      [gathering, 'Gathering'], [exploring, 'Exploring']];
  }

  function planetSummaryStats() {
    const ships = A.shipsInProject(S.current.projectId);
    const pd = A.activePlanetData();
    const structures = pd ? pd.subdirs : 0;
    const resources = pd && pd.resources ? pd.resources.length : 0;
    const builds = pd ? pd.builds : 0;
    return [[ships.length, 'Agents'], [structures, 'Structures'],
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
    const planet = S.current.view === 'planet';
    bar.classList.toggle('hidden', !planet);
    if (!planet || bar.childElementCount) return;
    TABS.forEach((t, i) => {
      const tab = AUR.el('div', 'tab' + (i === 0 ? ' active' : ' disabled'));
      const ico = document.createElement('span');
      ico.innerHTML = tabIco();
      tab.append(ico.firstChild, AUR.el('span', null, t));
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

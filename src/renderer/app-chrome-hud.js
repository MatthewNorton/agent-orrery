// @ts-check
'use strict';
// HUD chrome: the view's name over the universe, the live clock, and the needs-you alarm and module.
(function () {
  const A = AUR.app;               // created by app-state.js; throw if missing
  if (!A) throw new Error('app-state.js must load before app-chrome-hud.js');
  const S = A.state;

  const VIEW_KIND = { universe: 'Star chart · live view', system: 'System · live view', planet: 'Planet · live view' };
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => String(n).padStart(2, '0');

  // ---------- the view's name ----------
  A.renderViewTitle = function renderViewTitle() {
    const name = document.getElementById('view-name');
    const kind = document.getElementById('view-kind');
    const sub = document.getElementById('view-sub');
    if (!name || !kind || !sub) return;
    const view = S.current.view;
    let title = 'Universe';
    let line = '';
    if (view === 'system' || view === 'planet') {
      const project = S.store.projects.get(S.current.projectId);
      const ships = A.shipsInProject(S.current.projectId);
      const pd = view === 'planet' && S.activeView && S.activeView.planetData ? S.activeView.planetData : null;
      title = pd ? String(pd.name) : (project ? project.name : 'System');
      const builds = project ? (project.totalBuilds || 0) : 0;
      line = pd
        ? (project ? project.name : '') + ' · ' + ships.length + ' agents'
        : ships.length + ' agents · ' + builds + ' builds';
    } else {
      const online = new Set();
      for (const s of S.store.ships.values()) online.add(s.project);
      line = S.store.projects.size + ' projects · ' + online.size + ' systems online';
    }
    kind.textContent = VIEW_KIND[view] || VIEW_KIND.universe;
    name.textContent = title;
    name.classList.toggle('is-long', title.length > 12);
    sub.textContent = line;
  };

  // ---------- needs you: the alarm in the top bar and the module in the left rail ----------
  function needsRow(ship) {
    const meta = AUR.attentionMeta(ship.attention);
    const row = AUR.el('button', 'needs-row');
    row.type = 'button';
    row.style.setProperty('--tint', meta ? meta.color : '');
    row.setAttribute('aria-label', 'Open ' + ship.name + ' in first-person view');
    row.addEventListener('click', () => A.enterAgentFocus(ship.id));
    const name = AUR.el('span', 'needs-name', ship.name + ' · ');
    name.appendChild(AUR.el('em', null, meta ? meta.label : ''));
    row.appendChild(name);
    row.appendChild(AUR.el('span', 'needs-wait', AUR.relTime(ship.lastActivity, A.playbackReferenceTs())));
    row.appendChild(AUR.el('span', 'needs-sub', A.projectName(ship.project) + ' · ' + ship.status));
    return row;
  }

  A.renderNeedsYou = function renderNeedsYou(ships) {
    const panel = document.getElementById('needs-you-panel');
    const list = document.getElementById('needs-you-list');
    const count = document.getElementById('needs-you-panel-count');
    const alarm = document.getElementById('needs-you');
    const alarmCount = document.getElementById('needs-you-count');
    if (!panel || !list || !alarm) return;
    const waiting = ships.filter((s) => s.attention === 'question' || s.attention === 'permission');
    panel.classList.toggle('hidden', waiting.length === 0);
    alarm.classList.toggle('hidden', waiting.length === 0);
    if (count) count.textContent = pad(waiting.length);
    if (alarmCount) alarmCount.textContent = String(waiting.length);
    alarm.setAttribute('aria-label', waiting.length + ' agents need you; open the first');
    AUR.clear(list);
    for (const s of waiting) list.appendChild(needsRow(s));
  };

  A.wireNeedsYou = function wireNeedsYou() {
    const alarm = document.getElementById('needs-you');
    if (!alarm) return;
    alarm.addEventListener('click', () => {
      const first = /** @type {HTMLElement | null} */ (document.querySelector('#needs-you-list .needs-row'));
      if (first) first.click();
    });
  };

  // ---------- galaxies: one row per group, with its systems, agents and builds ----------
  A.renderGalaxies = function renderGalaxies() {
    const list = document.getElementById('galaxies-list');
    const count = document.getElementById('galaxies-count');
    const GALAXY = window.AUR_GALAXY;
    if (!list || !GALAXY) return;
    const projects = [...S.store.projects.values()];
    const layout = GALAXY.layoutGalaxyProjects(projects);
    const keyOf = new Map(layout.projects.map((p) => [p.id, p.galaxyKey]));
    const rows = new Map(layout.galaxies.map((g) => [g.key, { key: g.key, label: g.label, systems: 0, agents: 0, builds: 0 }]));
    for (const p of projects) {
      const row = rows.get(keyOf.get(String(p.id)));
      if (row) { row.systems += 1; row.builds += p.totalBuilds || 0; }
    }
    for (const ship of S.store.ships.values()) {
      const row = rows.get(keyOf.get(String(ship.project)));
      if (row) row.agents += 1;
    }
    const els = S.commandRail.els;
    if (els && els.galaxiesCompactCount) els.galaxiesCompactCount.textContent = String(rows.size);
    if (count) count.textContent = rows.size + (rows.size === 1 ? ' galaxy' : ' galaxies');
    AUR.clear(list);
    if (rows.size === 0) { list.appendChild(AUR.el('div', 'empty-note', 'No galaxies yet')); return; }
    for (const row of rows.values()) {
      const el = AUR.el('div', 'galaxy-row');
      const swatch = AUR.el('i', 'galaxy-swatch');
      swatch.style.background = GALAXY.galaxyColor(row.key);
      el.appendChild(swatch);
      el.appendChild(AUR.el('span', 'galaxy-name', row.label));
      el.appendChild(AUR.el('span', 'galaxy-builds', String(row.builds)));
      el.appendChild(AUR.el('span', 'galaxy-sub',
        row.systems + (row.systems === 1 ? ' system · ' : ' systems · ') + row.agents + (row.agents === 1 ? ' agent' : ' agents')));
      list.appendChild(el);
    }
  };

  // ---------- builds per half hour, under the timeline; live only ----------
  A.renderBuildHistogram = function renderBuildHistogram() {
    const svg = document.getElementById('history-histogram');
    const total = document.getElementById('history-builds');
    if (!svg) return;
    const h = S.store.buildHistogram;
    const bar = document.getElementById('history-bar');
    const replay = Boolean(bar && bar.dataset.mode === 'replay');
    if (!h || replay) { svg.innerHTML = ''; if (total) total.textContent = ''; return; }
    const max = Math.max(1, ...h.bins);
    const nowBin = Math.min(47, Math.max(0, Math.floor((Date.now() - h.day) / 1800000)));
    let sum = 0, out = '';
    h.bins.forEach((v, i) => {
      sum += v;
      const height = v > 0 ? Math.max(2, (v / max) * 20) : (i <= nowBin ? 1 : 0);
      if (height) out += '<rect x="' + (i * 10 + 1.5) + '" y="' + (20 - height) + '" width="7" height="' + height + '"' + (i === nowBin ? ' class="now"' : '') + '></rect>';
    });
    svg.innerHTML = out;
    if (total) total.textContent = sum ? sum + (sum === 1 ? ' build today' : ' builds today') : '';
  };

  // ---------- the clock: live time, or the replayed time ----------
  function tickClock() {
    const time = document.getElementById('clock-time');
    const date = document.getElementById('clock-date');
    const mode = document.getElementById('clock-mode');
    if (!time || !date || !mode) return;
    const bar = document.getElementById('history-bar');
    const replay = Boolean(bar && bar.dataset.mode === 'replay');
    const d = new Date(replay ? A.playbackReferenceTs() : Date.now());
    time.textContent = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    date.textContent = DAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()];
    mode.textContent = replay ? 'Replay' : 'Live';
    mode.classList.toggle('is-replay', replay);
  }

  A.startClock = function startClock() {
    tickClock();
    setInterval(tickClock, 1000);
  };
})();

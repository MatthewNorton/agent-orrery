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

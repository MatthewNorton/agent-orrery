// @ts-check
// The event feed in the right rail, newest first, and the feed expanded. Expanded, the rail widens
// (app/panels/resize.js keeps that width apart), its other panels show folded without changing their
// own state (app/modules.js asks A.foldedByFeed), and the feed lists every event it keeps with each
// one's time of day, a search, a filter by kind, and a jump back to the newest when new events come
// in while it is scrolled. Folding or hiding the feed, folding its rail, or opening one of the rail's
// other panels puts it back (A.syncFeedExpanded).
'use strict';

(function () {
  const AUR = window.AUR;
  const A = AUR.app;
  if (!A) throw new Error('app/state.js must load before app/panels/feed.js');
  const S = A.state, C = A.const;
  const L = window.AUR_PANEL_LAYOUT;
  const FILTERS = [['all', 'All'], ['builds', 'Builds'], ['ships', 'Ships'], ['attention', 'Attention'], ['systems', 'Systems']];
  /** @type {Set<string>} the right rail's other panels */
  const BESIDE = new Set(L.panelsOn('right').map((/** @type {{ key: string }} */ p) => p.key)
    .filter((/** @type {string} */ key) => key !== 'feed'));
  const RAIL = L.rail('right').module;
  const SCROLLED = 8;
  /** @param {string} path */
  const icon = (path) => `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${path}"></path></svg>`;
  const EXPAND = icon('M9.5 2.5 H13.5 V6.5 M13.5 2.5 L9 7 M6.5 13.5 H2.5 V9.5 M2.5 13.5 L7 9');
  const PUT_BACK = icon('M13.5 2.5 L9.5 6.5 M9.5 3.5 V6.5 H12.5 M2.5 13.5 L6.5 9.5 M6.5 12.5 V9.5 H3.5');

  let filter = 'all', query = '';
  // The newest event's time when the expanded list was last at its top: later ones are new.
  let seen = 0;
  /** @typedef {{ kind: string, text: string, ts: number, project?: string }} FeedEntry */
  /** @type {Map<FeedEntry, HTMLElement>} the expanded list's rows, kept by the event each shows */
  let wideRows = new Map();
  /** @type {{ panel: HTMLElement, list: HTMLElement, toggle: HTMLElement, pill: HTMLElement,
   *   pillText: HTMLElement, count: HTMLElement, counts: Map<string, HTMLElement> } | null} */
  let ui = null;

  /** @param {number} ts */
  const clock = (ts) => {
    const d = new Date(ts);
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
  };
  const newest = () => (S.store.feed.length ? S.store.feed[S.store.feed.length - 1].ts : 0);

  A.feedExpandLabel = () => (S.panels.feedExpanded ? 'Put the event feed back' : 'Expand the event feed');
  A.toggleFeedExpanded = () => A.setFeedExpanded(!S.panels.feedExpanded);
  /** While the feed is expanded, the right rail's other panels show folded. @param {string} key */
  A.foldedByFeed = (key) => S.panels.feedExpanded && BESIDE.has(key);

  /**
   * One event: its kind's mark, the sentence and its age, and its time of day while expanded. A click
   * opens the event's system, unless it ends a selection of the row's text.
   * @param {FeedEntry} f @param {boolean} wide @param {number} ref the time ages count back from
   */
  function row(f, wide, ref) {
    const project = f.project;
    const el = AUR.el('div', 'feed-row' + (project ? ' clickable' : ''));
    if (project) {
      el.title = 'Go to ' + A.projectName(project);
      el.addEventListener('click', () => {
        const selection = getSelection();
        if (!selection || selection.isCollapsed || !el.contains(selection.anchorNode)) A.jumpToProject(project);
      });
    }
    if (wide) el.appendChild(AUR.el('span', 'feed-clock', clock(f.ts)));
    el.appendChild(AUR.el('span', 'feed-dot')).style.background = AUR.feedColor(f.kind);
    el.appendChild(AUR.el('div', 'feed-body')).append(
      AUR.el('div', 'feed-text', f.text),
      AUR.el('div', 'feed-time', AUR.relTime(f.ts, ref))
    );
    return el;
  }

  A.renderFeed = function renderFeed() {
    const list = document.getElementById('feed-list');
    if (!list) return;
    const parts = S.panels.feedExpanded ? ui : null;
    /** @type {FeedEntry[]} */
    const kept = S.store.feed.slice(parts ? -C.FEED_CAP : -C.FEED_SHOW).reverse();
    A.setRailCount('feed', kept.length, kept.length === 0);
    if (parts) return renderWide(parts, kept);
    wideRows.clear();
    AUR.clear(list);
    if (!kept.length) list.appendChild(AUR.el('div', 'empty-note', 'No signals yet'));
    const ref = A.playbackReferenceTs();
    for (const f of kept) list.appendChild(row(f, false, ref));
  };

  /**
   * The expanded list: the events the search and the filter let through, and how many of each kind
   * there are. Rows stay while their events do, so new ones go on top while the browser keeps a
   * scrolled viewer's place (overflow-anchor in rail.css), a selection survives, and only ages change.
   * @param {NonNullable<typeof ui>} parts @param {FeedEntry[]} kept
   */
  function renderWide(parts, kept) {
    const list = parts.list;
    /** @type {Record<string, number>} */
    const n = { all: kept.length };
    for (const f of kept) n[AUR.feedGroup(f.kind)] = (n[AUR.feedGroup(f.kind)] || 0) + 1;
    for (const [key, el] of parts.counts) el.textContent = String(n[key] || 0);
    const q = query.trim().toLowerCase();
    const rows = kept.filter((f) => (filter === 'all' || AUR.feedGroup(f.kind) === filter) &&
      (!q || `${f.text} ${f.project ? A.projectName(f.project) : ''}`.toLowerCase().includes(q)));
    parts.count.textContent = `${rows.length} of ${kept.length} shown`;

    const ref = A.playbackReferenceTs();
    /** @type {Map<FeedEntry, HTMLElement>} */
    const next = new Map();
    for (const f of rows) next.set(f, wideRows.get(f) || row(f, true, ref));
    const keep = new Set(next.values());
    for (const el of /** @type {HTMLElement[]} */ ([...list.children])) if (!keep.has(el)) el.remove();
    let at = list.firstElementChild;
    for (const [f, el] of next) {
      if (el === at) at = el.nextElementSibling;
      else list.insertBefore(el, at);
      const age = el.querySelector('.feed-time');
      if (age) age.textContent = AUR.relTime(f.ts, ref);
    }
    wideRows = next;
    if (!rows.length) list.appendChild(AUR.el('div', 'empty-note', kept.length ? 'No events match that filter' : 'No signals yet'));

    const scrolled = list.classList.contains('is-scrolled');
    if (!scrolled) seen = newest();
    const fresh = scrolled ? kept.filter((f) => f.ts > seen).length : 0;
    parts.pill.hidden = fresh === 0;
    parts.pillText.textContent = `${fresh} new ${fresh === 1 ? 'event' : 'events'}`;
  }

  /** @param {NonNullable<typeof ui>} parts */
  function syncToggle(parts) {
    const label = A.feedExpandLabel();
    parts.toggle.setAttribute('aria-pressed', String(S.panels.feedExpanded));
    parts.toggle.setAttribute('aria-label', label);
    A.titleWithKey(parts.toggle, label, 'feed');
    parts.toggle.innerHTML = S.panels.feedExpanded ? PUT_BACK : EXPAND;
  }

  /** Expands the event feed, or puts it back; whether it changed. @param {boolean} on */
  A.setFeedExpanded = function setFeedExpanded(on) {
    if (!ui || S.panels.feedExpanded === on) return false;
    if (on) {
      // The feed and its rail open first: either one folded would put the feed straight back.
      A.setPanelState('feed', 'open');
      A.setModuleCollapsed(RAIL, false);
    }
    S.panels.feedExpanded = on;
    ui.panel.classList.toggle('is-wide', on);
    syncToggle(ui);
    A.refreshModules();
    A.fitRails('right');
    ui.list.scrollTop = 0;
    ui.list.classList.remove('is-scrolled');
    A.renderFeed();
    return true;
  };

  /**
   * After a panel folds, opens, hides or shows (A.panelsChanged): the expanded feed needs itself and
   * its rail open, and goes back as one of the rail's other panels opens.
   * @param {string} key @param {boolean} opened
   */
  A.syncFeedExpanded = function syncFeedExpanded(key, opened) {
    if (!S.panels.feedExpanded) return;
    if (A.panelState('feed') !== 'open' || S.modules.collapsed.has(RAIL) || (opened && BESIDE.has(key))) {
      A.setFeedExpanded(false);
    }
  };

  A.wireFeed = function wireFeed() {
    const panel = document.getElementById('feed-panel');
    const list = document.getElementById('feed-list');
    const fold = panel && panel.querySelector('.mod-h .mod-x');
    if (!panel || !list || !fold) return;
    const toggle = AUR.button('mod-btn', '', A.toggleFeedExpanded);
    fold.before(toggle);

    const tools = AUR.el('div', 'feed-tools');
    const field = tools.appendChild(AUR.el('label', 'field'));
    field.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path></svg>';
    const search = /** @type {HTMLInputElement} */ (field.appendChild(AUR.el('input')));
    search.type = 'search';
    search.placeholder = 'Filter by agent, project or file';
    search.autocomplete = 'off';
    search.setAttribute('aria-label', 'Filter events');
    search.addEventListener('input', () => { query = search.value; A.renderFeed(); });
    const chips = tools.appendChild(AUR.el('div', 'chips'));
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', 'Kinds of event');
    /** @type {Map<string, HTMLElement>} */
    const counts = new Map();
    const pairs = FILTERS.map(([key, label]) => {
      const chip = chips.appendChild(AUR.button('btn btn--line chip', label));
      counts.set(key, chip.appendChild(AUR.el('span', 'chip-n')));
      return [chip, key];
    });
    const press = AUR.choiceButtons(pairs, (/** @type {string} */ key) => {
      filter = key;
      press(key);
      A.renderFeed();
    });
    press(filter);

    // The pill jumps back to the newest events; the list back at its top clears it. Only a scrolled
    // list keeps its place as events come in above (rail.css).
    const wrap = AUR.el('div', 'feed-wrap');
    const pill = AUR.button('btn feed-new', '', () => { list.scrollTop = 0; });
    pill.innerHTML = icon('M8 13 V3 M4 7 L8 3 L12 7');
    const pillText = pill.appendChild(AUR.el('span'));
    pill.hidden = true;
    list.addEventListener('scroll', () => {
      const scrolled = list.scrollTop > SCROLLED;
      list.classList.toggle('is-scrolled', scrolled);
      if (scrolled || pill.hidden) return;
      seen = newest();
      pill.hidden = true;
    }, { passive: true });

    const foot = AUR.el('div', 'feed-foot');
    const count = foot.appendChild(AUR.el('span'));
    foot.appendChild(AUR.el('span', '', `The feed keeps the last ${C.FEED_CAP} events. Older activity is on the timeline.`));
    list.before(tools, wrap);
    wrap.append(pill, list);
    wrap.after(foot);
    ui = { panel, list, toggle, pill, pillText, count, counts };
    syncToggle(ui);
  };
})();

// @ts-check
// Keyboard shortcuts. The table, and when a key press belongs to something else, are shortcuts.js;
// this runs them from one document key handler, lists them in Settings › Shortcuts with an On/Off
// for single keys, and gives the chrome their key chips (A.keyChips) and titles (A.titleWithKey).
// Escape closes the panels menu, then Settings (the dialog closes itself), then the expanded feed,
// then the toast; the agent view, the directory and the search take their own Escape first.
'use strict';

(function () {
  const AUR = window.AUR;
  const A = AUR.app;
  if (!A) throw new Error('app/state.js must load before app/keys.js');
  const S = A.state, C = A.const;
  const K = window.AUR_SHORTCUTS, L = window.AUR_PANEL_LAYOUT;
  const MAC = /Mac/.test(navigator.platform);
  /** @typedef {{ id: string, label: string, keys: string[][], panel?: string }} Shortcut */
  /** @type {{ title: string, rows: Shortcut[] }[]} */
  const GROUPS = K.groups(L.PANELS);
  /** @type {Shortcut[]} */
  const ROWS = GROUPS.flatMap((g) => g.rows);
  const SHORTCUTS = K.index(GROUPS);
  // Single keys are on unless the viewer turned them off (wireKeys reads it).
  let singleKeys = true;
  /** @type {Map<HTMLElement, { label: string, id: string }>} controls whose title names their key */
  const titled = new Map();

  /** @param {string} id */
  const keysOf = (id) => ROWS.find((r) => r.id === id)?.keys[0] || null;
  /** @param {string[]} names */
  const kbds = (names, cls = 'kbd') => K.display(names, MAC).map((/** @type {string} */ n) => AUR.el('kbd', cls, n));

  /**
   * A shortcut's keys as chips, then `text`; null when it has none. Single-key chips hide while
   * single keys are off (.keys-off), and chips without text are only a hint to the eye.
   * @param {string} id @param {string} [text]
   */
  A.keyChips = function keyChips(id, text = '') {
    const names = keysOf(id);
    if (!names) return null;
    const span = AUR.el('span', 'key-hint' + (K.singleKey(names) ? ' key-single' : ''));
    span.append(...kbds(names));
    if (text) span.append(text);
    else span.setAttribute('aria-hidden', 'true');
    return span;
  };

  /** @param {HTMLElement} el @param {{ label: string, id: string }} t */
  function applyTitle(el, { label, id }) {
    const names = keysOf(id);
    if (names && (singleKeys || !K.singleKey(names))) {
      el.title = `${label} (${K.display(names, MAC).join(' ')})`;
      el.setAttribute('aria-keyshortcuts', names.map((n) => (n === 'Mod' ? (MAC ? 'Meta' : 'Control') : n)).join('+'));
    } else {
      el.title = label;
      el.removeAttribute('aria-keyshortcuts');
    }
  }

  /** A control's title, "Fold every panel (\)", and its aria-keyshortcuts, kept while single keys turn on or off. */
  A.titleWithKey = function titleWithKey(/** @type {HTMLElement} */ el, /** @type {string} */ label, /** @type {string} */ id) {
    titled.set(el, { label, id });
    applyTitle(el, { label, id });
  };

  /** Clicks a control that is on screen and enabled. @param {string} id */
  function clickShown(id) {
    const el = /** @type {HTMLButtonElement | null} */ (document.getElementById(id));
    if (!el || el.disabled || !AUR.isShown(el)) return false;
    el.click();
    return true;
  }

  /** A panel's key: hides or shows it, or says where it shows when this view has none. @param {string} key */
  function togglePanel(key) {
    const panel = L.panel(key);
    if (L.showsIn(panel, S.current.view)) A.togglePanelHidden(key);
    else A.showToast(`${panel.name} shows in the ${panel.where.toLowerCase()}`);
  }

  /** @param {string} module */
  const foldRail = (module) => A.setModuleCollapsed(module, !S.modules.collapsed.has(module));

  /** @type {Record<string, () => unknown>} what each shortcut does; false: nothing to do, so the key goes on */
  const ACTIONS = {
    search: () => {
      const input = /** @type {HTMLInputElement | null} */ (document.getElementById('search-input'));
      input?.focus();
      input?.select();
    },
    back: () => clickShown('back-btn'),
    'needs-you': () => clickShown('needs-you') || A.showToast('No agent needs you right now'),
    settings: () => A.openProjectSettings(),
    shortcuts: () => {
      A.openProjectSettings();
      A.showSettingsTab('keys');
    },
    escape: () => A.closePanelsMenu(true) || (!S.projectSettings.open && (A.setFeedExpanded(false) || A.dismissToast())),
    // Play works in history; live, the key says how to get there.
    play: () => {
      if (clickShown('history-play')) return true;
      if (S.playback.mode === 'replay') return false;
      A.showToast('Drag the timeline back to play history');
      return true;
    },
    live: () => clickShown('history-live'),
    'rail-left': () => foldRail('rail-left'),
    'rail-right': () => foldRail('rail-right'),
    rails: () => A.toggleAllRails(),
    feed: () => A.toggleFeedExpanded(),
  };

  /** The text of the text field that has focus, or null when focus is not in one. @param {EventTarget | null} el */
  function fieldText(el) {
    if (el instanceof HTMLElement && el.isContentEditable) return el.textContent || '';
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return el.value;
    if (el instanceof HTMLInputElement) return /^(range|checkbox|radio|button|submit|reset|color|file)$/.test(el.type) ? null : el.value;
    return null;
  }

  /** @param {KeyboardEvent} event */
  function onKey(event) {
    if (event.defaultPrevented) return;
    const target = event.target instanceof Element ? event.target : null;
    const row = K.route(event, {
      field: fieldText(target),
      onButton: Boolean(target && target.closest('button, a[href], summary, input[type="checkbox"], input[type="radio"]')),
      singleKeys: singleKeys && !S.projectSettings.open,
    }, SHORTCUTS, MAC);
    if (!row) return;
    if ((row.panel ? togglePanel(row.panel) : ACTIONS[row.id]()) !== false) event.preventDefault();
  }

  /** Settings › Shortcuts: each group's shortcuts and their keys. @param {HTMLElement} list */
  function renderList(list) {
    for (const group of GROUPS) {
      const box = list.appendChild(AUR.el('div', 'key-group'));
      box.appendChild(AUR.el('h4', '', group.title));
      for (const row of group.rows) {
        const line = box.appendChild(AUR.el('div', 'key-row'));
        line.appendChild(AUR.el('span', '', row.label));
        const keys = line.appendChild(AUR.el('span', 'key-hint'));
        row.keys.forEach((names, i) => {
          if (i) keys.appendChild(AUR.el('span', 'key-or', 'or'));
          keys.append(...kbds(names));
        });
      }
    }
  }

  A.wireKeys = function wireKeys() {
    singleKeys = AUR.storedJson(C.SINGLE_KEYS_STORAGE_KEY, true) !== false;
    document.addEventListener('keydown', onKey);
    const list = document.getElementById('key-list');
    if (list) renderList(list);
    // The search shows its key until it has focus; the view hint ends with how to find this list.
    const searchKey = A.keyChips('search');
    searchKey?.classList.add('search-kbd');
    if (searchKey) document.querySelector('#project-search .search-control')?.appendChild(searchKey);
    const help = AUR.el('span', 'key-single');
    help.append(' · ', ...kbds(['?'], 'kbd kbd--sm'), ' shortcuts');
    document.getElementById('view-hint')?.appendChild(help);

    const toggle = document.getElementById('single-keys');
    const show = () => {
      document.documentElement.classList.toggle('keys-off', !singleKeys);
      if (toggle) {
        toggle.setAttribute('aria-pressed', String(singleKeys));
        toggle.textContent = singleKeys ? 'On' : 'Off';
      }
      titled.forEach((t, el) => applyTitle(el, t));
    };
    toggle?.addEventListener('click', () => {
      singleKeys = !singleKeys;
      AUR.storeJson(C.SINGLE_KEYS_STORAGE_KEY, singleKeys);
      show();
    });
    show();
  };
})();

// @ts-check
// The panels menu, from the caret beside the top bar's panels button: a tick for each panel the view
// shows (choosing one hides or shows it and leaves the menu open), then actions for the whole layout.
// Arrow keys, Home and End move through it; Escape, Tab or a click elsewhere closes it.
'use strict';

(function () {
  const AUR = window.AUR;
  const A = AUR.app;
  if (!A) throw new Error('app/state.js must load before app/panels/menu.js');
  const S = A.state;
  const L = window.AUR_PANEL_LAYOUT;
  /** @type {Record<string, string>} */
  const VIEWS = { universe: 'Universe view', system: 'System view', planet: 'Planet view' };

  const caret = () => document.getElementById('panels-menu-button');
  const menu = () => document.getElementById('panels-menu');
  /** @param {HTMLElement} m */
  const items = (m) => /** @type {HTMLElement[]} */ ([...m.querySelectorAll('[role^="menuitem"]')]);

  A.wirePanelsMenu = function wirePanelsMenu() {
    const button = caret(), m = menu();
    if (!button || !m) return;
    button.addEventListener('click', () => (m.hidden ? open(button, m) : A.closePanelsMenu(true)));
    m.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        A.closePanelsMenu(true);
        return;
      }
      if (event.key === 'Tab') return A.closePanelsMenu(false);
      const list = items(m);
      const at = list.indexOf(/** @type {HTMLElement} */ (document.activeElement));
      const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: list.length - 1 }[event.key];
      if (to === undefined) return;
      event.preventDefault();
      list[(to + list.length) % list.length].focus();
    });
    document.addEventListener('pointerdown', (event) => {
      const target = event.target instanceof Node ? event.target : null;
      if (!m.hidden && target && !m.contains(target) && !button.contains(target)) A.closePanelsMenu(false);
    });
  };

  /** @param {HTMLElement} button @param {HTMLElement} m */
  function open(button, m) {
    render(m);
    m.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    items(m)[0]?.focus();
  }

  /** @param {boolean} refocus */
  A.closePanelsMenu = function closePanelsMenu(refocus) {
    const button = caret(), m = menu();
    if (!button || !m || m.hidden) return;
    m.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (refocus) button.focus();
  };

  // While the menu is open its ticks and notes follow the panels.
  A.syncPanelsMenu = function syncPanelsMenu() {
    const m = menu();
    if (!m || m.hidden) return;
    for (const item of /** @type {NodeListOf<HTMLElement>} */ (m.querySelectorAll('[data-panel]'))) {
      const panel = L.panel(item.dataset.panel || '');
      if (panel) mark(item, panel);
    }
  };

  /** @param {HTMLElement} item @param {{ key: string, never: string }} panel */
  function mark(item, panel) {
    const state = A.panelState(panel.key);
    item.setAttribute('aria-checked', String(state !== 'hidden'));
    const note = item.querySelector('.panels-menu-note');
    if (note) note.textContent = panel.never === 'hidden' ? 'Always' : state === 'folded' ? 'Folded' : '';
  }

  /** @param {HTMLElement} m */
  function render(m) {
    AUR.clear(m);
    const view = S.current.view;
    const head = m.appendChild(AUR.el('div', 'panels-menu-head'));
    head.append(AUR.el('span', 'mod-title', 'Panels'), AUR.el('span', 'mod-m', VIEWS[view] || ''));
    for (const rail of L.RAILS) {
      const panels = L.PANELS.filter((/** @type {{ rail: string, views: string[] | null }} */ p) =>
        p.rail === rail.side && (!p.views || p.views.includes(view)));
      if (!panels.length) continue;
      const group = m.appendChild(AUR.el('div', 'panels-menu-group'));
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', rail.label);
      group.appendChild(AUR.el('div', 'panels-menu-label', rail.label)).setAttribute('aria-hidden', 'true');
      for (const panel of panels) group.appendChild(panelItem(panel));
    }
    m.appendChild(AUR.el('div', 'panels-menu-sep')).setAttribute('role', 'separator');
    m.appendChild(action(A.foldAllLabel(), A.toggleAllRails));
    m.appendChild(action('Start every run with this layout', () => {
      A.saveLaunchLayout(A.currentPanelLayout());
      A.renderLaunchLayout();
      A.showToast('Every run now starts with this layout');
    }));
    m.appendChild(action('Panel settings…', () => {
      A.openProjectSettings();
      A.showSettingsTab('panels');
    }, false));
  }

  /** @param {{ key: string, name: string, never: string }} panel */
  function panelItem(panel) {
    const item = AUR.button('panels-menu-item');
    item.setAttribute('role', 'menuitemcheckbox');
    item.dataset.panel = panel.key;
    item.tabIndex = -1;
    if (panel.never === 'hidden') item.setAttribute('aria-disabled', 'true');
    item.append(AUR.el('span', 'panels-menu-check'), AUR.el('span', 'panels-menu-name', panel.name),
      AUR.el('span', 'panels-menu-note'));
    mark(item, panel);
    item.addEventListener('click', () => A.togglePanelHidden(panel.key));
    return item;
  }

  // An action closes the menu first; focus goes back to the caret unless the action takes it.
  /** @param {string} label @param {() => void} run @param {boolean} [refocus] */
  function action(label, run, refocus = true) {
    const item = AUR.button('panels-menu-item panels-menu-action', label, () => {
      A.closePanelsMenu(refocus);
      run();
    });
    item.setAttribute('role', 'menuitem');
    item.tabIndex = -1;
    return item;
  }
})();

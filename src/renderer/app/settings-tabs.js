// @ts-check
// Settings in tabs: one tab's pane shows at a time. Arrow keys, Home and End move between the tabs
// (the ARIA tabs pattern, the pane following focus). The chosen tab is the one marked aria-selected,
// so it stays chosen while the app runs; the panes keep their controls' ids.
'use strict';

(function () {
  const AUR = window.AUR;
  const A = AUR.app;
  if (!A) throw new Error('app/state.js must load before app/settings-tabs.js');

  const allTabs = () => /** @type {HTMLElement[]} */ ([...document.querySelectorAll('#settings-tabs [role="tab"]')]);

  /** @param {HTMLElement} chosen @param {boolean} focus */
  function select(chosen, focus) {
    for (const tab of allTabs()) {
      const on = tab === chosen;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      const pane = document.getElementById(tab.getAttribute('aria-controls') || '');
      if (pane) pane.hidden = !on;
    }
    if (focus) chosen.focus();
  }

  /** @param {string} key a tab's data-tab, such as 'projects' */
  A.showSettingsTab = function showSettingsTab(key) {
    const tab = allTabs().find((t) => t.dataset.tab === key);
    if (tab) select(tab, false);
  };

  A.focusSettingsTab = function focusSettingsTab() {
    const tab = allTabs().find((t) => t.getAttribute('aria-selected') === 'true');
    if (tab) tab.focus();
  };

  A.wireSettingsTabs = function wireSettingsTabs() {
    const tabs = allTabs();
    tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => select(tab, false));
      tab.addEventListener('keydown', (event) => {
        const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[event.key];
        if (to === undefined) return;
        event.preventDefault();
        select(tabs[(to + tabs.length) % tabs.length], true);
      });
    });
  };
})();

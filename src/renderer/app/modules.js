// @ts-check
// app/modules.js — folding chrome: any `[data-module]` (a module on either rail, or a rail itself)
// folds to its header from the `.mod-x` chevron in that header. One delegated click listener
// serves them all, the top bar's panels button folds or opens both rails at once, and the set
// of folded keys persists between runs.
'use strict';

(function () {
  const AUR = window.AUR;
  const A = AUR.app;               // created by app/state.js; throw if missing
  if (!A) throw new Error('app/state.js must load before app/modules.js');
  const S = A.state, C = A.const;

  const RAILS = ['rail-left', 'rail-right'];

  /** @param {HTMLElement} section */
  function applyModuleState(section) {
    const collapsed = S.modules.collapsed.has(section.dataset.module || '');
    section.classList.toggle('is-collapsed', collapsed);
    const toggle = section.querySelector(':scope > .mod-h .mod-x');
    const title = section.querySelector(':scope > .mod-h .mod-title');
    if (!toggle) return;
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', (collapsed ? 'Expand ' : 'Collapse ') + (title ? title.textContent : 'module'));
  }

  // The panels button reads as pressed while both rails are folded.
  function syncPanelsToggle() {
    const button = document.getElementById('panels-toggle');
    if (!button) return;
    const folded = RAILS.every((key) => S.modules.collapsed.has(key));
    button.setAttribute('aria-pressed', String(folded));
    button.title = folded ? 'Open every panel' : 'Fold every panel';
    button.setAttribute('aria-label', button.title);
  }

  /** @param {string} key @param {boolean} collapsed */
  A.setModuleCollapsed = function setModuleCollapsed(key, collapsed) {
    if (collapsed) S.modules.collapsed.add(key);
    else S.modules.collapsed.delete(key);
    AUR.storeJson(C.MODULES_STORAGE_KEY, [...S.modules.collapsed]);
    const section = /** @type {HTMLElement | null} */ (document.querySelector(`[data-module="${key}"]`));
    if (section) applyModuleState(section);
    syncPanelsToggle();
  };

  /**
   * The header of a card that rebuilds on every render: index, an optional lead node, the title,
   * extra nodes, then the chevron. Appended to the section, which then takes its saved state.
   * @param {HTMLElement} section
   * @param {string} title
   * @param {{ lead?: Node | null, extras?: Node[] }} [parts]
   */
  A.moduleHead = function moduleHead(section, title, parts = {}) {
    const head = AUR.el('header', 'mod-h');
    head.appendChild(AUR.el('span', 'mod-i index'));
    if (parts.lead) head.appendChild(parts.lead);
    head.appendChild(AUR.el('h2', 'mod-title', title));
    for (const node of parts.extras || []) head.appendChild(node);
    const toggle = AUR.el('button', 'mod-x');
    toggle.type = 'button';
    head.appendChild(toggle);
    section.appendChild(head);
    applyModuleState(section);
  };

  A.wireModules = function wireModules() {
    const keys = AUR.storedJson(C.MODULES_STORAGE_KEY, []);
    S.modules.collapsed = new Set(Array.isArray(keys) ? keys.filter((key) => typeof key === 'string') : []);
    document.addEventListener('click', (event) => {
      const toggle = event.target instanceof Element ? event.target.closest('.mod-x') : null;
      const section = toggle && /** @type {HTMLElement | null} */ (toggle.closest('[data-module]'));
      if (!section) return;
      const key = section.dataset.module || '';
      A.setModuleCollapsed(key, !S.modules.collapsed.has(key));
    });
    const panels = document.getElementById('panels-toggle');
    if (panels) {
      panels.addEventListener('click', () => {
        const fold = !RAILS.every((key) => S.modules.collapsed.has(key));
        for (const key of RAILS) A.setModuleCollapsed(key, fold);
      });
    }
    const sections = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-module]'));
    for (const section of sections) applyModuleState(section);
    syncPanelsToggle();
  };
})();

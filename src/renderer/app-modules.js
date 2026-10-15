// @ts-check
// app-modules.js — collapsible modules: any `.mod[data-module]` on either rail folds to its header
// from the `.mod-x` chevron in that header. One delegated click listener serves every module, and
// the set of folded modules persists between runs.
'use strict';

(function () {
  const AUR = window.AUR;
  const A = AUR.app;               // created by app-state.js; throw if missing
  if (!A) throw new Error('app-state.js must load before app-modules.js');
  const S = A.state, C = A.const;

  /** @param {HTMLElement} section */
  function applyModuleState(section) {
    const collapsed = S.modules.collapsed.has(section.dataset.module || '');
    section.classList.toggle('is-collapsed', collapsed);
    const toggle = section.querySelector('.mod-h .mod-x');
    const title = section.querySelector('.mod-title');
    if (!toggle) return;
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', (collapsed ? 'Expand ' : 'Collapse ') + (title ? title.textContent : 'module'));
  }

  /** @param {string} key @param {boolean} collapsed */
  A.setModuleCollapsed = function setModuleCollapsed(key, collapsed) {
    if (collapsed) S.modules.collapsed.add(key);
    else S.modules.collapsed.delete(key);
    AUR.storeJson(C.MODULES_STORAGE_KEY, [...S.modules.collapsed]);
    const section = /** @type {HTMLElement | null} */ (document.querySelector(`.mod[data-module="${key}"]`));
    if (section) applyModuleState(section);
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
      const toggle = event.target instanceof Element ? event.target.closest('.mod-h .mod-x') : null;
      const section = toggle && /** @type {HTMLElement | null} */ (toggle.closest('.mod[data-module]'));
      if (!section) return;
      const key = section.dataset.module || '';
      A.setModuleCollapsed(key, !S.modules.collapsed.has(key));
    });
    const sections = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.mod[data-module]'));
    for (const section of sections) applyModuleState(section);
  };
})();

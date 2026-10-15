// @ts-check
// app-modules.js — collapsible modules on the left rail: one header builder for the cards that
// rebuild on render, one wiring pass for the panels with static markup, and the persisted set
// of collapsed modules.
'use strict';

(function () {
  const AUR = window.AUR;
  const A = AUR.app;               // created by app-state.js; throw if missing
  if (!A) throw new Error('app-state.js must load before app-modules.js');
  const S = A.state, C = A.const;

  const CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6"></path></svg>';

  function readCollapsed() {
    try {
      const keys = JSON.parse(localStorage.getItem(C.MODULES_STORAGE_KEY) || '[]');
      if (Array.isArray(keys)) S.modules.collapsed = new Set(keys.filter((key) => typeof key === 'string'));
    } catch (error) { /* use the roomy default */ }
  }

  function saveCollapsed() {
    try {
      localStorage.setItem(C.MODULES_STORAGE_KEY, JSON.stringify([...S.modules.collapsed]));
    } catch (error) { /* persistence is a convenience, never a requirement */ }
  }

  /** @param {HTMLElement} section @param {HTMLElement} toggle @param {string} title */
  function applyModuleState(section, toggle, title) {
    const collapsed = S.modules.collapsed.has(section.dataset.module || '');
    section.classList.toggle('is-collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', (collapsed ? 'Expand ' : 'Collapse ') + title);
  }

  /** @param {HTMLElement} section @param {HTMLElement} toggle @param {string} title */
  function wireToggle(section, toggle, title) {
    if (!toggle.firstChild) toggle.innerHTML = CHEVRON;
    toggle.addEventListener('click', () => {
      const key = section.dataset.module || '';
      if (S.modules.collapsed.has(key)) S.modules.collapsed.delete(key);
      else S.modules.collapsed.add(key);
      saveCollapsed();
      applyModuleState(section, toggle, title);
      A.positionTasksPanel();
    });
    applyModuleState(section, toggle, title);
    return toggle;
  }

  /**
   * The header of a card that rebuilds on every render: index, an optional lead node, the title,
   * extra nodes, then the chevron. The section's saved state is applied at the same time.
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
    head.appendChild(wireToggle(section, toggle, title));
    return head;
  };

  // Reads the saved set before any card renders, draws every empty chevron button in the
  // chrome (the right rail's included), and wires the panels whose header is static markup.
  A.wireModules = function wireModules() {
    readCollapsed();
    for (const button of document.querySelectorAll('.mod-x:empty')) button.innerHTML = CHEVRON;
    const sections = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.mod[data-module]'));
    for (const section of sections) {
      const toggle = /** @type {HTMLElement | null} */ (section.querySelector('.mod-h .mod-x'));
      const title = section.querySelector('.mod-title');
      if (toggle && title) wireToggle(section, toggle, title.textContent || '');
    }
  };
})();

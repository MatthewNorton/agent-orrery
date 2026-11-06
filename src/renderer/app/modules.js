// @ts-check
// Folding chrome: any `[data-module]` (a module on either rail, or a rail itself)
// folds to its header from the `.mod-x` chevron in that header. One delegated click listener
// serves them all, and the top bar's panels button folds or opens both rails at once. Folds
// last for the run; each run starts from the At launch layout (app/panels/layout.js).
'use strict';

(function () {
  const AUR = window.AUR;
  const A = AUR.app;
  if (!A) throw new Error('app/state.js must load before app/modules.js');
  const S = A.state;

  /** @type {string[]} the rails' own data-module keys */
  const RAILS = window.AUR_PANEL_LAYOUT.RAILS.map((/** @type {{ module: string }} */ r) => r.module).filter(Boolean);
  const allFolded = () => RAILS.every((key) => S.modules.collapsed.has(key));

  /** What the panels button does next: fold both rails, or open them. */
  A.foldAllLabel = () => (allFolded() ? 'Open every panel' : 'Fold every panel');

  A.toggleAllRails = function toggleAllRails() {
    const fold = !allFolded();
    for (const key of RAILS) A.setModuleCollapsed(key, fold);
  };

  /** Shows a section folded or open: its own fold, or folded while the expanded feed needs its rail. @param {HTMLElement} section */
  function applyModuleState(section) {
    const key = section.dataset.module || '';
    const collapsed = S.modules.collapsed.has(key) || A.foldedByFeed(key);
    section.classList.toggle('is-collapsed', collapsed);
    const toggle = section.querySelector(':scope > .mod-h .mod-x');
    const title = section.querySelector(':scope > .mod-h .mod-title');
    if (!toggle) return;
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', (collapsed ? 'Expand ' : 'Collapse ') + (title ? title.textContent : 'module'));
  }

  // The panels button reads as pressed while both rails are folded.
  A.syncPanelsToggle = function syncPanelsToggle() {
    const button = document.getElementById('panels-toggle');
    if (!button) return;
    button.setAttribute('aria-pressed', String(allFolded()));
    const label = A.foldAllLabel();
    button.setAttribute('aria-label', label);
    A.titleWithKey(button, label, 'rails');
  };

  /** @param {string} key @param {boolean} collapsed */
  A.setModuleCollapsed = function setModuleCollapsed(key, collapsed) {
    if (collapsed) S.modules.collapsed.add(key);
    else S.modules.collapsed.delete(key);
    const section = /** @type {HTMLElement | null} */ (document.querySelector(`[data-module="${key}"]`));
    if (section) applyModuleState(section);
    A.panelsChanged(key, !collapsed);
  };

  A.refreshModules = function refreshModules() {
    for (const section of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-module]'))) {
      applyModuleState(section);
    }
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
    head.appendChild(AUR.button('mod-x'));
    section.appendChild(head);
    applyModuleState(section);
  };

  A.wireModules = function wireModules() {
    document.addEventListener('click', (event) => {
      const toggle = event.target instanceof Element ? event.target.closest('.mod-x') : null;
      const section = toggle && /** @type {HTMLElement | null} */ (toggle.closest('[data-module]'));
      // What the chevron shows flips: a panel the expanded feed folds opens, and the feed goes back.
      if (section) A.setModuleCollapsed(section.dataset.module || '', !section.classList.contains('is-collapsed'));
    });
    document.getElementById('panels-toggle')?.addEventListener('click', A.toggleAllRails);
    A.refreshModules();
    A.syncPanelsToggle();
  };
})();

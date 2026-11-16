// @ts-check
// Settings › Panels › At launch: the layout every run starts from. A row per panel picks Open,
// Folded or Hidden; three actions keep the layout on screen now, apply this one to the window, or
// restore the defaults.
'use strict';

(function () {
  const AUR = window.AUR;
  const A = AUR.app;
  if (!A) throw new Error('app/state.js must load before app/panels/launch.js');
  const L = window.AUR_PANEL_LAYOUT;
  const OPTIONS = [['open', 'Open'], ['folded', 'Folded'], ['hidden', 'Hidden']];
  /** @type {Map<string, (state: string) => void>} each row's choice buttons, by panel key */
  const presses = new Map();

  /** Marks each row's saved state and puts a note under the table. @param {string} [note] */
  A.renderLaunchLayout = function renderLaunchLayout(note = '') {
    const layout = A.launchLayout();
    for (const [key, press] of presses) press(layout[key]);
    const status = document.getElementById('panel-launch-status');
    if (status) status.textContent = note;
  };

  A.wireLaunchLayout = function wireLaunchLayout() {
    const table = document.getElementById('panel-launch');
    const current = document.getElementById('panel-launch-current');
    const apply = document.getElementById('panel-launch-apply');
    const reset = document.getElementById('panel-launch-defaults');
    if (!table || !current || !apply || !reset) return;
    for (const rail of L.RAILS) {
      table.appendChild(AUR.el('h4', 'panel-launch-group', rail.label));
      for (const panel of L.panelsOn(rail.side)) {
        table.appendChild(row(panel));
      }
    }
    current.addEventListener('click', () => {
      A.saveLaunchLayout(A.currentPanelLayout());
      A.renderLaunchLayout('Saved. The next run starts with the layout you have now.');
    });
    apply.addEventListener('click', () => {
      A.applyPanelLayout(A.launchLayout());
      A.renderLaunchLayout('Applied to this window.');
    });
    reset.addEventListener('click', () => {
      A.saveLaunchLayout(L.defaults());
      A.renderLaunchLayout('Defaults back: Summary and Galaxies start hidden, Ideas and Tasks start folded.');
    });
    A.renderLaunchLayout();
  };

  /**
   * A panel's row: its name and where it shows, its key, then Open, Folded or Hidden.
   * @param {{ key: string, name: string, where: string, never: string, neverWhy?: string }} panel
   */
  function row(panel) {
    const el = AUR.el('div', 'panel-launch-row');
    const name = el.appendChild(AUR.el('div', 'panel-launch-name'));
    name.appendChild(AUR.el('span', 'panel-launch-title', panel.name));
    if (panel.where) name.appendChild(AUR.el('span', 'panel-launch-where', panel.where));
    el.append(A.keyChips(`panel-${panel.key}`) || '');
    const choice = el.appendChild(AUR.el('div', 'settings-choice panel-launch-choice'));
    choice.setAttribute('role', 'group');
    choice.setAttribute('aria-label', `${panel.name} at launch`);
    const pairs = OPTIONS.map(([state, text]) => {
      const button = choice.appendChild(AUR.button('settings-locate', text));
      button.disabled = panel.never === state;
      button.title = button.disabled ? panel.neverWhy || '' : `${text} at launch`;
      return [button, state];
    });
    presses.set(panel.key, AUR.choiceButtons(pairs, (/** @type {string} */ state) => {
      A.saveLaunchLayout({ ...A.launchLayout(), [panel.key]: state });
      A.renderLaunchLayout();
    }));
    return el;
  }
})();

// @ts-check
// Each panel is open, folded to its header, or hidden, for the run in progress. Every run starts
// from the At launch layout (Settings › Panels, app/panels/launch.js); the panels menu
// (app/panels/menu.js) and the chevrons change only the run. Folding is app/modules.js, and a
// hidden panel keeps its fold for when it comes back. Hidden is `.is-dismissed`, apart from the
// `.hidden` a view sets; a rail with no panel on screen takes no room (hud.css).
'use strict';

(function () {
  const AUR = window.AUR;
  const A = AUR.app;
  if (!A) throw new Error('app/state.js must load before app/panels/layout.js');
  const S = A.state, C = A.const;
  const L = window.AUR_PANEL_LAYOUT;
  /** @type {Record<string, string>} the panels that skip their renders while hidden, and their chrome */
  const LAZY = { galaxies: 'GALAXIES' };

  /** @param {string} key */
  A.panelState = function panelState(key) {
    if (S.panels.hidden.has(key)) return 'hidden';
    return S.modules.collapsed.has(key) ? 'folded' : 'open';
  };

  A.currentPanelLayout = () => Object.fromEntries(L.PANELS.map((p) => [p.key, A.panelState(p.key)]));

  /**
   * Hides or shows a panel, and the folded right rail's button for it. A panel that skips its
   * renders while hidden renders as it comes back.
   * @param {{ key: string, id: string }} panel @param {boolean} hide
   */
  function setHidden(panel, hide) {
    if (S.panels.hidden.has(panel.key) === hide) return;
    if (hide) S.panels.hidden.add(panel.key);
    else S.panels.hidden.delete(panel.key);
    for (const id of [panel.id, `compact-${panel.key}-button`]) {
      document.getElementById(id)?.classList.toggle('is-dismissed', hide);
    }
    if (!hide && LAZY[panel.key]) A.renderChromeNow(C.CHROME[LAZY[panel.key]]);
  }

  /** @param {string} key @param {string} state */
  A.setPanelState = function setPanelState(key, state) {
    const panel = L.panel(key);
    if (!panel || !L.allowed(key, state)) return;
    setHidden(panel, state === 'hidden');
    if (state !== 'hidden' && panel.never !== 'folded') A.setModuleCollapsed(key, state === 'folded');
    A.syncPanelsMenu();
  };

  /** Hides a panel, with Undo, or shows it again as it was. @param {string} key */
  A.togglePanelHidden = function togglePanelHidden(key) {
    const panel = L.panel(key);
    if (!panel || panel.never === 'hidden') return;
    const hide = !S.panels.hidden.has(key);
    setHidden(panel, hide);
    if (hide) {
      A.showToast(`${panel.name} hidden`, {
        label: 'Undo',
        run: () => { if (S.panels.hidden.has(key)) A.togglePanelHidden(key); },
      });
    } else {
      A.dismissToast();
      // A panel shown on a folded rail opens the rail, so it comes into sight.
      const rail = L.RAILS.find((/** @type {{ side: string }} */ r) => r.side === panel.rail);
      if (rail && S.modules.collapsed.has(rail.module)) A.setModuleCollapsed(rail.module, false);
    }
    A.syncPanelsMenu();
  };

  /** The layout every run starts from. */
  A.launchLayout = () => L.normalize(AUR.storedJson(C.PANEL_LAUNCH_STORAGE_KEY, null));

  /** @param {Record<string, string>} layout */
  A.saveLaunchLayout = (layout) => AUR.storeJson(C.PANEL_LAUNCH_STORAGE_KEY, L.normalize(layout));

  /** @param {Record<string, string>} layout */
  A.applyPanelLayout = function applyPanelLayout(layout) {
    for (const panel of L.PANELS) A.setPanelState(panel.key, layout[panel.key]);
  };

  A.wirePanels = function wirePanels() {
    A.wirePanelLook();
    // The first run with launch layouts keeps the panels folded before them.
    if (!AUR.storedJson(C.PANEL_LAUNCH_STORAGE_KEY, null)) {
      A.saveLaunchLayout(L.fromFolded(AUR.storedJson(C.MODULES_STORAGE_KEY, null)));
    }
    A.applyPanelLayout(A.launchLayout());
    A.wirePanelsMenu();
    A.wireLaunchLayout();
  };
})();

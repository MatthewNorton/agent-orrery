// @ts-check
// Resizing: a rail's inner edge drags its width and the gap under a panel drags that panel's height,
// by pointer or keys (kit/SPEC.md, Resizing). Sizes are CSS px, kept per viewer. A rail stops short of
// the other rail (panel-layout.js fitRails); a sized panel grows only into room its rail has left.
'use strict';

(function () {
  const AUR = window.AUR;
  const A = AUR.app;
  if (!A) throw new Error('app/state.js must load before app/panels/resize.js');
  const S = A.state, C = A.const;
  const L = window.AUR_PANEL_LAYOUT;
  const root = document.documentElement;
  const STEP = 16, BIG_STEP = 64;

  /** @param {string} name */
  const cssPx = (name) => parseFloat(getComputedStyle(root).getPropertyValue(name)) || 0;
  /** @type {{ side: string, label: string, module: string, width: string }[]} the two side rails */
  const SIDES = L.RAILS.filter((/** @type {{ width?: string }} */ r) => r.width);
  /** @type {{ key: string, id: string, name: string, minH: number }[]} */
  const RESIZABLE = L.PANELS.filter((/** @type {{ minH?: number }} */ p) => p.minH);
  // Tokens, read before any rail is sized: each rail's width, the folded right rail's, the edge margin.
  /** @type {Record<string, number>} */
  const DEFAULT_WIDTH = Object.fromEntries(SIDES.map((r) => [r.side, cssPx(r.width)]));
  const COMPACT_W = cssPx('--sidebar-compact-w'), MARGIN = cssPx('--space-3');

  const zoom = () => A.uiZoom();
  /** @param {string} module */
  const railOf = (module) => /** @type {HTMLElement | null} */ (document.querySelector(`[data-module="${module}"]`));
  // CSS px across the window, between the margins at its edges.
  const room = () => innerWidth / zoom() - 2 * MARGIN;
  const store = () => AUR.storeJson(C.PANEL_SIZES_STORAGE_KEY, S.panels.sizes);

  /** How a rail shows: open, folded to its compact strip, or not at all. @param {HTMLElement | null} el */
  function shown(el) {
    if (!el || !AUR.isShown(el)) return 'none';
    return el.classList.contains('is-collapsed') ? 'compact' : 'open';
  }

  // While the event feed is expanded the right rail keeps a width of its own (app/panels/feed.js).
  /** @param {string} side */
  const sizeKey = (side) => (side === 'right' && S.panels.feedExpanded ? 'rightExpanded' : side);
  /** The width a rail asks for. @param {string} side */
  function wantWidth(side) {
    const own = S.panels.sizes.rails[side] || DEFAULT_WIDTH[side], key = sizeKey(side);
    return key === side ? own : L.expandedWidth(innerWidth / zoom(), own, S.panels.sizes.rails[key]);
  }

  /**
   * The widths both rails fit at; `yields` gives way when they do not, and `ask` stands in for a
   * rail's kept width. @param {string} yields @param {Record<string, number>} [ask]
   * @returns {Record<string, number>}
   */
  function fit(yields, ask = {}) {
    /** @type {Record<string, number>} */ const want = {};
    /** @type {Record<string, string>} */ const state = {};
    for (const rail of SIDES) {
      want[rail.side] = ask[rail.side] || wantWidth(rail.side);
      state[rail.side] = shown(railOf(rail.module));
    }
    return L.fitRails(room(), want, state, COMPACT_W, yields);
  }

  /** Sets both rails to widths that fit the window. @param {string} [yields] */
  A.fitRails = function fitRails(yields = 'left') {
    const width = fit(yields);
    for (const rail of SIDES) root.style.setProperty(rail.width, `${width[rail.side]}px`);
  };

  // A rail that folds, opens, empties or fills changes the room beside it, and so does the window
  // (app/boot.js reports both): one refit a frame, and none while a drag fits as it goes.
  let frame = 0;
  A.refitRails = function refitRails() {
    if (frame || root.classList.contains('is-resizing')) return;
    frame = requestAnimationFrame(() => { frame = 0; A.fitRails(); });
  };

  /**
   * A separator, dragged or stepped with keys. `grows` is 1 when the size grows with the pointer's x
   * or y and -1 when it shrinks; sizes are CSS px. How far it can go is measured as a drag or a key
   * press starts, and each step then shows the size it set rather than measuring the layout again.
   * @param {string} className @param {string} label @param {'x' | 'y'} axis
   * @param {{ grows: number, min: number, size: () => number, max: () => number,
   *   set: (value: number) => void, reset: () => void }} spec
   */
  function separator(className, label, axis, spec) {
    const grip = AUR.el('div', className);
    grip.setAttribute('role', 'separator');
    grip.setAttribute('aria-orientation', axis === 'x' ? 'vertical' : 'horizontal');
    grip.setAttribute('aria-label', label);
    grip.setAttribute('aria-valuemin', String(spec.min));
    grip.tabIndex = 0;
    const badge = grip.appendChild(AUR.el('span', 'grip-size'));
    let max = spec.min;
    /** @param {number} value */
    const show = (value) => {
      grip.setAttribute('aria-valuenow', String(value));
      badge.textContent = `${value} px`;
      return value;
    };
    const measure = () => {
      max = Math.round(spec.max());
      grip.setAttribute('aria-valuemax', String(max));
      return show(Math.round(spec.size()));
    };
    /** @param {number} value */
    const to = (value) => {
      const size = L.clamp(value, spec.min, max);
      spec.set(size);
      show(size);
    };
    const reset = () => { spec.reset(); measure(); store(); };
    /** @param {PointerEvent} event */
    const at = (event) => (axis === 'x' ? event.clientX : event.clientY);

    // A drag starts from the size on screen, which can be less than the one kept.
    grip.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const from = measure(), start = at(event), scale = zoom();
      grip.setPointerCapture(event.pointerId);
      root.classList.add('is-resizing');
      grip.classList.add('is-dragging');
      /** @param {PointerEvent} e */
      const move = (e) => to(from + spec.grows * (at(e) - start) / scale);
      grip.addEventListener('pointermove', move);
      grip.addEventListener('lostpointercapture', () => {
        grip.removeEventListener('pointermove', move);
        root.classList.remove('is-resizing');
        grip.classList.remove('is-dragging');
        store();
      }, { once: true });
    });
    grip.addEventListener('dblclick', reset);
    grip.addEventListener('focus', measure);
    grip.addEventListener('keydown', (event) => {
      /** @type {Record<string, number>} */
      const steps = axis === 'x' ? { ArrowLeft: -1, ArrowRight: 1 } : { ArrowUp: -1, ArrowDown: 1 };
      if (event.key === 'Enter') reset();
      else if (steps[event.key]) to(measure() + steps[event.key] * spec.grows * (event.shiftKey ? BIG_STEP : STEP));
      else if (event.key === 'Home') to(spec.min);
      else if (event.key === 'End') { measure(); to(max); }
      else return;
      event.preventDefault();
      store();
    });
    return grip;
  }

  /** A rail's width grip, on its inner edge. @param {{ side: string, label: string, module: string }} rail */
  function railGrip(rail) {
    const el = railOf(rail.module);
    if (!el) return;
    el.appendChild(separator('rail-grip', `${rail.label} width`, 'x', {
      grows: rail.side === 'left' ? 1 : -1,
      min: L.RAIL_MIN,
      size: () => el.getBoundingClientRect().width / zoom(),
      // As wide as the window lets it be beside the other rail as that one is.
      max: () => fit(rail.side, { [rail.side]: Infinity })[rail.side],
      set: (width) => { S.panels.sizes.rails[sizeKey(rail.side)] = width; A.fitRails(rail.side); },
      reset: () => { delete S.panels.sizes.rails[sizeKey(rail.side)]; A.fitRails(rail.side); },
    }));
  }

  /** @param {{ key: string, id: string }} panel */
  function applyHeight(panel) {
    const el = document.getElementById(panel.id);
    if (!el) return;
    const height = S.panels.sizes.panels[panel.key];
    el.classList.toggle('is-sized', Boolean(height));
    if (height) el.style.setProperty('--panel-h', `${height}px`);
    else el.style.removeProperty('--panel-h');
  }

  /**
   * How much taller a panel can get, in CSS px: the free space under its rail's last panel, and
   * what the rail's other panels can give up, down to their least height (sized ones keep theirs).
   * Its grip shows only while the panel does, so the rail has at least this panel on screen.
   * @param {HTMLElement} el
   */
  function roomBelow(el) {
    const rail = /** @type {HTMLElement} */ (el.parentElement);
    const scale = zoom();
    const panels = [...rail.children].filter((k) => k.classList.contains('mod') && k.getClientRects().length > 0);
    const last = panels[panels.length - 1];
    let more = (rail.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom) / scale;
    for (const k of panels) {
      if (k === el || k.classList.contains('is-sized')) continue;
      const style = getComputedStyle(k);
      if (parseFloat(style.flexShrink) > 0) {
        more += Math.max(0, k.getBoundingClientRect().height / scale - (parseFloat(style.minHeight) || 0));
      }
    }
    return Math.max(0, more);
  }

  /** A panel's height grip, in the gap under it. @param {{ key: string, id: string, name: string, minH: number }} panel */
  function panelGrip(panel) {
    const el = document.getElementById(panel.id);
    if (!el) return;
    const size = () => el.getBoundingClientRect().height / zoom();
    el.after(separator('panel-grip', `${panel.name} height`, 'y', {
      grows: 1,
      min: panel.minH,
      size,
      max: () => size() + roomBelow(el),
      set: (height) => { S.panels.sizes.panels[panel.key] = height; applyHeight(panel); },
      reset: () => { delete S.panels.sizes.panels[panel.key]; applyHeight(panel); },
    }));
  }

  A.resetPanelSizes = function resetPanelSizes() {
    S.panels.sizes = L.normalizeSizes(null);
    for (const panel of RESIZABLE) applyHeight(panel);
    A.fitRails();
    store();
  };

  A.wirePanelSizes = function wirePanelSizes() {
    S.panels.sizes = L.normalizeSizes(AUR.storedJson(C.PANEL_SIZES_STORAGE_KEY, null));
    for (const rail of SIDES) railGrip(rail);
    for (const panel of RESIZABLE) {
      panelGrip(panel);
      applyHeight(panel);
    }
    A.fitRails();
  };
})();

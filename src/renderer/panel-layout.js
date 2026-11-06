// @ts-check
// The chrome's panels and the layout every run starts from, as pure data and functions: each panel
// is open, folded to its header, or hidden. UMD keeps the same table available to the renderer
// (window.AUR_PANEL_LAYOUT) and the Node tests.
'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AUR_PANEL_LAYOUT = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const STATES = Object.freeze(['open', 'folded', 'hidden']);

  // Where the panels sit, in the order the panels menu and Settings list them; `module` is the
  // rail's own data-module, which folds the whole rail, and `width` the property that sizes it.
  const RAILS = Object.freeze([
    { side: 'left', label: 'Left rail', module: 'rail-left', width: '--rail-l' },
    { side: 'right', label: 'Right rail', module: 'rail-right', width: '--rail-r' },
    { side: 'bottom', label: 'Bottom', module: '' },
  ].map((rail) => Object.freeze(rail)));

  // In that order too. `key` is the element's data-module (the timeline has none), `id` its
  // element, `views` the views that show it (null: every view), `where` the note Settings gives it,
  // `never` the state it cannot take and `neverWhy` the reason, `launch` its default, and `minH` the
  // least height a viewer can drag it to (a panel without one keeps the height of its content).
  const PANELS = Object.freeze([
    { key: 'needs-you', name: 'Needs you', rail: 'left', id: 'needs-you-panel', views: null, where: 'While an agent waits', never: 'hidden', neverWhy: 'Needs you never hides while an agent waits', launch: 'open', minH: 72 },
    { key: 'summary', name: 'Summary', rail: 'left', id: 'summary-card', views: null, where: '', never: '', launch: 'hidden', minH: 96 },
    { key: 'project', name: 'Project', rail: 'left', id: 'project-card', views: ['system', 'planet'], where: 'System and planet views', never: '', launch: 'open' },
    { key: 'tasks', name: 'Tasks', rail: 'left', id: 'tasks-panel', views: ['system'], where: 'System view', never: '', launch: 'folded' },
    { key: 'planet', name: 'Planet', rail: 'left', id: 'planet-card', views: ['planet'], where: 'Planet view', never: '', launch: 'open' },
    { key: 'agents', name: 'Fleet', rail: 'right', id: 'agents-panel', views: null, where: '', never: '', launch: 'open', minH: 140 },
    { key: 'galaxies', name: 'Galaxies', rail: 'right', id: 'galaxies-panel', views: null, where: '', never: '', launch: 'hidden', minH: 104 },
    { key: 'feed', name: 'Event feed', rail: 'right', id: 'feed-panel', views: null, where: '', never: '', launch: 'open', minH: 104 },
    { key: 'ideas', name: 'Ideas', rail: 'right', id: 'ideas-panel', views: null, where: '', never: '', launch: 'folded', minH: 132 },
    { key: 'timeline', name: 'Timeline', rail: 'bottom', id: 'history-bar', views: null, where: 'Live and history playback', never: 'folded', neverWhy: 'The timeline does not fold', launch: 'open' },
  ].map((panel) => Object.freeze(panel)));

  const byKey = new Map(PANELS.map((panel) => [panel.key, panel]));

  // A rail is at least RAIL_MIN wide and stops RAIL_GAP short of the other rail, so both edges
  // stay in reach; it has no other limit.
  const RAIL_MIN = 240;
  const RAIL_GAP = 24;

  /** @param {string} key */
  const panel = (key) => byKey.get(key) || null;
  /** The panels on one rail, in order. @param {string} side */
  const panelsOn = (side) => PANELS.filter((p) => p.rail === side);
  /** @param {string} side */
  const rail = (side) => RAILS.find((r) => r.side === side) || null;

  /** Whether a panel can take a state. */
  function allowed(key, state) {
    const p = byKey.get(key);
    return Boolean(p) && STATES.includes(state) && p.never !== state;
  }

  /** The layout of a first run: Summary and Galaxies hidden, Tasks and Ideas folded. */
  function defaults() {
    return Object.fromEntries(PANELS.map((p) => [p.key, p.launch]));
  }

  /** A stored layout, with anything missing, unknown or not allowed taken from the defaults. */
  function normalize(raw) {
    const layout = defaults();
    if (raw && typeof raw === 'object') {
      for (const p of PANELS) if (allowed(p.key, raw[p.key])) layout[p.key] = raw[p.key];
    }
    return layout;
  }

  /** The defaults with the panels folded before launch layouts existed (the old folded keys). */
  function fromFolded(keys) {
    const layout = defaults();
    if (Array.isArray(keys)) for (const key of keys) if (allowed(key, 'folded')) layout[key] = 'folded';
    return layout;
  }

  /** A size between a floor and a ceiling, in whole px; the floor wins when they cross. */
  function clamp(value, min, max) {
    return Math.round(Math.max(min, Math.min(value, max)));
  }

  /** The width a rail has in `room` (CSS px between the window's edge margins) beside `other` px of rail. */
  function railRoom(room, other) {
    return other > 0 ? room - other - RAIL_GAP : room;
  }

  /**
   * Both rails' widths for the window. `want` is the width each asks for, `shown` how each shows
   * ('open', 'compact' at `compact` px, or 'none'), and `yields` the side that gives way when the two
   * do not fit: the other keeps its width as long as this one can still be RAIL_MIN.
   */
  function fitRails(room, want, shown, compact, yields) {
    const keep = yields === 'left' ? 'right' : 'left';
    // A rail's width on screen when open at `open` px: the strip when folded, none when not shown.
    const onScreen = (side, open) => ({ open, compact }[shown[side]] || 0);
    const kept = clamp(want[keep], RAIL_MIN, railRoom(room, onScreen(yields, RAIL_MIN)));
    return { [keep]: kept, [yields]: clamp(want[yields], RAIL_MIN, railRoom(room, onScreen(keep, kept))) };
  }

  /**
   * The right rail's width while the event feed is expanded, in a window `windowW` CSS px wide: the
   * width kept for it, else a share of the window up to 640 px, and never narrower than the rail is.
   */
  function expandedWidth(windowW, own, kept) {
    return kept || Math.max(own, Math.round(Math.min(640, windowW * 0.46)));
  }

  /**
   * Stored sizes, keeping only whole numbers at or above their floor: `rails` (left, right, and the
   * right rail's width while the event feed is expanded) and `panels` (heights by panel key).
   */
  function normalizeSizes(raw) {
    const sizes = { rails: {}, panels: {} };
    const ok = (value, min) => Number.isFinite(value) && value >= min;
    const rails = raw && raw.rails, panels = raw && raw.panels;
    for (const side of ['left', 'right', 'rightExpanded']) {
      if (rails && ok(rails[side], RAIL_MIN)) sizes.rails[side] = Math.round(rails[side]);
    }
    for (const p of PANELS) {
      if (p.minH && panels && ok(panels[p.key], p.minH)) sizes.panels[p.key] = Math.round(panels[p.key]);
    }
    return sizes;
  }

  return {
    RAILS, PANELS, RAIL_MIN, panel, panelsOn, rail, allowed, defaults, normalize, fromFolded,
    clamp, fitRails, expandedWidth, normalizeSizes,
  };
});

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
  // rail's own data-module, which folds the whole rail.
  const RAILS = Object.freeze([
    { side: 'left', label: 'Left rail', module: 'rail-left' },
    { side: 'right', label: 'Right rail', module: 'rail-right' },
    { side: 'bottom', label: 'Bottom', module: '' },
  ].map((rail) => Object.freeze(rail)));

  // In that order too. `key` is the element's data-module (the timeline has none), `id` its
  // element, `views` the views that show it (null: every view), `where` the note Settings gives it,
  // `never` the state it cannot take and `neverWhy` the reason, `launch` its default.
  const PANELS = Object.freeze([
    { key: 'needs-you', name: 'Needs you', rail: 'left', id: 'needs-you-panel', views: null, where: 'While an agent waits', never: 'hidden', neverWhy: 'Needs you never hides while an agent waits', launch: 'open' },
    { key: 'summary', name: 'Summary', rail: 'left', id: 'summary-card', views: null, where: '', never: '', launch: 'hidden' },
    { key: 'project', name: 'Project', rail: 'left', id: 'project-card', views: ['system', 'planet'], where: 'System and planet views', never: '', launch: 'open' },
    { key: 'tasks', name: 'Tasks', rail: 'left', id: 'tasks-panel', views: ['system'], where: 'System view', never: '', launch: 'folded' },
    { key: 'planet', name: 'Planet', rail: 'left', id: 'planet-card', views: ['planet'], where: 'Planet view', never: '', launch: 'open' },
    { key: 'agents', name: 'Fleet', rail: 'right', id: 'agents-panel', views: null, where: '', never: '', launch: 'open' },
    { key: 'galaxies', name: 'Galaxies', rail: 'right', id: 'galaxies-panel', views: null, where: '', never: '', launch: 'hidden' },
    { key: 'feed', name: 'Event feed', rail: 'right', id: 'feed-panel', views: null, where: '', never: '', launch: 'open' },
    { key: 'ideas', name: 'Ideas', rail: 'right', id: 'ideas-panel', views: null, where: '', never: '', launch: 'folded' },
    { key: 'timeline', name: 'Timeline', rail: 'bottom', id: 'history-bar', views: null, where: 'Live and history playback', never: 'folded', neverWhy: 'The timeline does not fold', launch: 'open' },
  ].map((panel) => Object.freeze(panel)));

  const byKey = new Map(PANELS.map((panel) => [panel.key, panel]));

  /** @param {string} key */
  const panel = (key) => byKey.get(key) || null;

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

  return { RAILS, PANELS, panel, allowed, defaults, normalize, fromFolded };
});

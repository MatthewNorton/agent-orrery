// @ts-check
// The keyboard shortcuts as data, and which one a key press asks for. One table feeds the key
// handler (app/keys.js), the Settings › Shortcuts list and the key hints in the chrome. UMD keeps it
// available to the renderer (window.AUR_SHORTCUTS) and the Node tests.
'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AUR_SHORTCUTS = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  /**
   * A shortcut: `id` names what it does (app/keys.js), `label` is its line in the list, `keys` its
   * key combinations, each the names of its keys as shown (Mod is Ctrl, or ⌘ on macOS), and `panel`
   * the panel a panel's key shows or hides.
   * @typedef {{ id: string, label: string, keys: string[][], panel?: string }} Shortcut
   * @typedef {{ title: string, rows: Shortcut[] }} Group
   * @typedef {Map<string, { row: Shortcut, keys: string[] }>} Index each combination's shortcut
   * @typedef {{ key: string, ctrlKey: boolean, metaKey: boolean, shiftKey: boolean, altKey: boolean,
   *   repeat?: boolean, isComposing?: boolean }} Press
   */
  /** @type {Group[]} */
  const FIXED = [
    { title: 'Go to and views', rows: [
      { id: 'search', label: 'Go to a project, agent or folder', keys: [['/'], ['Mod', 'K']] },
      { id: 'back', label: 'Back one level', keys: [['Backspace']] },
      { id: 'needs-you', label: 'Open the first agent that needs you', keys: [['N']] },
      { id: 'settings', label: 'Settings', keys: [['Mod', ',']] },
      { id: 'shortcuts', label: 'This list', keys: [['?']] },
      { id: 'escape', label: 'Close, or put an expanded panel back', keys: [['Esc']] },
    ] },
    { title: 'Timeline', rows: [
      { id: 'play', label: 'Play or pause history', keys: [['Space']] },
      { id: 'live', label: 'Return to live', keys: [['L']] },
    ] },
    { title: 'Panels', rows: [
      { id: 'rail-left', label: 'Fold or open the left rail', keys: [['[']] },
      { id: 'rail-right', label: 'Fold or open the right rail', keys: [[']']] },
      { id: 'rails', label: 'Fold or open every panel', keys: [['\\']] },
      { id: 'feed', label: 'Expand the event feed, or put it back', keys: [['Shift', 'E']] },
    ] },
  ];
  /** @type {Record<string, string>} what a keydown calls a key, where the list names it otherwise */
  const NAMES = { ' ': 'Space', Escape: 'Esc' };
  const LETTER = /^[a-z]$/i;

  /**
   * The shortcuts in their groups; each panel with a `letter` (panel-layout.js) adds its row,
   * `panel-<key>`, to Panels.
   * @param {{ key: string, name: string, letter?: string }[]} panels
   * @returns {Group[]}
   */
  function groups(panels) {
    const own = panels.filter((p) => p.letter).map((p) =>
      ({ id: `panel-${p.key}`, panel: p.key, label: `Show or hide ${p.name}`, keys: [[String(p.letter)]] }));
    return FIXED.map((g) => ({ title: g.title, rows: g.title === 'Panels' ? [...g.rows, ...own] : g.rows }));
  }

  /** A combination as one string, such as 'Mod+k', 'Shift+e' or '?'; Shift counts only with a letter. @param {string[]} names */
  function combo(names) {
    const key = names[names.length - 1];
    return [...names.slice(0, -1), LETTER.test(key) ? key.toLowerCase() : key].join('+');
  }

  /** Each combination in the list and its shortcut, built once for route(). @param {Group[]} list @returns {Index} */
  function index(list) {
    return new Map(list.flatMap((g) => g.rows).flatMap((row) => row.keys.map((keys) =>
      /** @type {[string, { row: Shortcut, keys: string[] }]} */ ([combo(keys), { row, keys }]))));
  }

  /** The combination a press makes, or '' when it holds the other platform's modifier. @param {Press} press @param {boolean} mac */
  function pressed(press, mac) {
    if (mac ? press.ctrlKey : press.metaKey) return '';
    const key = NAMES[press.key] || press.key;
    const letter = LETTER.test(key);
    const names = [(mac ? press.metaKey : press.ctrlKey) && 'Mod', letter && press.shiftKey && 'Shift', key];
    return combo(/** @type {string[]} */ (names.filter(Boolean)));
  }

  /** Whether a combination stops working while single keys are off: all but Ctrl (⌘) ones and Esc. @param {string[]} names */
  const singleKey = (names) => names[0] !== 'Mod' && names[0] !== 'Esc';

  /**
   * What a key press does, or null when it belongs to something else. `where` says where focus is:
   * `field` is the text of the focused text field (null when focus is not in one), `onButton` that
   * focus is on a button, and `singleKeys` that single-key shortcuts work now (they are on and
   * Settings is closed). Ctrl (⌘) shortcuts always work, and Escape does unless a field with text has
   * focus, which it clears first. Alt, a held key and a key that composes text are never shortcuts.
   * @param {Press} press
   * @param {{ field: string | null, onButton: boolean, singleKeys: boolean }} where
   * @param {Index} shortcuts @param {boolean} mac
   * @returns {Shortcut | null}
   */
  function route(press, where, shortcuts, mac) {
    if (press.altKey || press.repeat || press.isComposing) return null;
    const hit = shortcuts.get(pressed(press, mac));
    if (!hit) return null;
    if (hit.keys[0] === 'Esc') return where.field ? null : hit.row;
    if (!singleKey(hit.keys)) return hit.row;
    if (where.field !== null || !where.singleKeys) return null;
    return where.onButton && press.key === ' ' ? null : hit.row;
  }

  /** A combination's keys as shown on this platform. @param {string[]} names @param {boolean} mac */
  const display = (names, mac) => names.map((n) => (n === 'Mod' ? (mac ? '⌘' : 'Ctrl') : n));

  return { groups, index, route, display, singleKey };
});

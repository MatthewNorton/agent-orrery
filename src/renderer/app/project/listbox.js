// @ts-check
// The listbox the search results and the ALL PROJECTS directory share: debounce, keys, selection, rows.
'use strict';

(function () {
  const AUR = window.AUR;
  const A = AUR.app;
  if (!A) throw new Error('app/state.js must load before app/project/listbox.js');
  const C = A.const;
  const PRESS_SLOP = 4; // px a pointer may drift between press and release and still have stayed put

  // `state` is S.projectSearch or S.projectDirectory: { timer, results, selected }.
  A.cancelListboxTimer = function cancelListboxTimer(state) {
    if (state.timer != null) clearTimeout(state.timer);
    state.timer = null;
  };

  A.debounceListbox = function debounceListbox(state, update) {
    A.cancelListboxTimer(state);
    state.timer = setTimeout(() => {
      state.timer = null;
      update();
    }, C.SEARCH_DEBOUNCE_MS);
  };

  /**
   * Each entry's row key: `keyOf`, and where entries share one, a count after it.
   * Security: the rows are told apart by these, so two entries with one key must not share a row.
   * @returns {string[]}
   */
  function rowKeys(results, keyOf) {
    const used = new Set();
    return results.map((entry) => {
      const key = String(keyOf(entry));
      let own = key;
      for (let n = 2; used.has(own); n++) own = key + '\0' + n;
      used.add(own);
      return own;
    });
  }

  /**
   * The field's keys and the list's clicks. Escape runs `escape`; arrows move the selection
   * (`select` shows it) and Enter activates it, once a pending query has run. While an input method
   * composes text the keys are its own: Enter commits the text and Escape cancels it. A click
   * activates the entry its row stands for (`keyOf`), at whatever index a refresh has put it since
   * the press. When the refresh moved the rows under a pointer that stayed put, the release lands
   * on another row or past the list, and the entry that was pressed is still the one meant: so the
   * press and the click are heard on the document.
   */
  A.wireListbox = function wireListbox(list, input, state, { escape, update, activate, select, keyOf }) {
    const rowKey = (event) => {
      const target = /** @type {Element} */ (event.target);
      const row = /** @type {HTMLElement | null} */ (target.closest ? target.closest('[role="option"]') : null);
      return row && row.parentNode === list ? row.dataset.key : null;
    };
    /** @type {{ key: string | null, x: number, y: number } | null} the press the next click completes */
    let pressed = null;
    document.addEventListener('mousedown', (event) => { pressed = { key: rowKey(event), x: event.clientX, y: event.clientY }; });
    document.addEventListener('click', (event) => {
      const stayed = pressed && Math.abs(event.clientX - pressed.x) < PRESS_SLOP && Math.abs(event.clientY - pressed.y) < PRESS_SLOP;
      const key = stayed ? pressed.key : rowKey(event);
      pressed = null;
      const index = key == null ? -1 : rowKeys(state.results, keyOf).indexOf(key);
      if (index >= 0) activate(index);
    });
    input.addEventListener('keydown', (event) => {
      if (AUR.composing(event)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        escape();
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter') return;
      event.preventDefault();
      event.stopPropagation();
      if (state.timer != null) {
        A.cancelListboxTimer(state);
        update();
      }
      if (event.key === 'Enter') {
        activate(state.selected);
        return;
      }
      if (state.results.length === 0) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      state.selected = (state.selected + delta + state.results.length) % state.results.length;
      select();
    });
  };

  /** After a re-query: the first row for a new query, else the same entry, else the nearest row. */
  A.keepSelection = function keepSelection(state, previous, queryChanged, keyOf) {
    const previousIndex = previous
      ? state.results.findIndex((entry) => keyOf(entry) === keyOf(previous))
      : -1;
    state.selected = queryChanged ? 0 : previousIndex >= 0
      ? previousIndex : Math.min(state.selected, Math.max(0, state.results.length - 1));
  };

  /** @param {Element} row @param {boolean} selected */
  function markRow(row, selected) {
    row.classList.toggle('selected', selected);
    row.setAttribute('aria-selected', String(selected));
  }

  /**
   * Moves the selection to `state.selected` on the rows as they stand and brings that row into
   * view: an arrow key changes no row's content.
   */
  A.selectListboxRow = function selectListboxRow(list, input, state, idPrefix) {
    [...list.children].forEach((row, index) => markRow(row, index === state.selected));
    input.setAttribute('aria-activedescendant', idPrefix + state.selected);
    const row = list.children[state.selected];
    if (row) row.scrollIntoView({ block: 'nearest' });
  };

  /**
   * Makes `node` read as `fresh` does and keeps its elements, wherever their tags line up: a press
   * on a row, or on a part of one, ends in no click once the pressed element has been replaced.
   * @param {Element} node @param {Element} fresh
   */
  function adopt(node, fresh) {
    for (const { name } of [...node.attributes]) if (!fresh.hasAttribute(name)) node.removeAttribute(name);
    for (const { name, value } of [...fresh.attributes]) if (node.getAttribute(name) !== value) node.setAttribute(name, value);
    const kids = [...node.childNodes], next = [...fresh.childNodes];
    next.forEach((child, i) => {
      const old = kids[i];
      if (!old) node.appendChild(child);
      else if (old.nodeName !== child.nodeName) node.replaceChild(child, old);
      else if (old.nodeType === 1) adopt(/** @type {Element} */ (old), /** @type {Element} */ (child));
      else if (old.nodeValue !== child.nodeValue) old.nodeValue = child.nodeValue;
    });
    for (const extra of kids.slice(next.length)) extra.remove();
  }

  /**
   * One `rowClass` option button per result, completed by `fill`; the selected one is the active
   * descendant. An entry (`keyOf`) that was listed keeps its row's elements, changed only where
   * their content did and left where they are unless the order changed, so a refresh from the store,
   * also one that adds or drops a row above, neither loses a click that is under way nor moves the list.
   * The selected row is brought into view only when the selection moved to another row.
   */
  A.renderListbox = function renderListbox(list, input, state, opts) {
    if (state.results.length === 0) {
      AUR.clear(list);
      list.appendChild(AUR.el('div', opts.emptyClass, opts.emptyText));
      input.removeAttribute('aria-activedescendant');
      return;
    }
    const was = list.querySelector('[aria-selected="true"]');
    const rows = /** @type {HTMLElement[]} */ ([...list.children]);
    const held = new Map(rows.map((row) => [row.dataset.key, row]));
    const keys = rowKeys(state.results, opts.keyOf);
    const listed = new Set(keys);
    let at = 0; // the next row not yet placed
    state.results.forEach((entry, index) => {
      // Rows of entries no longer listed (and the note of an empty list) leave first, so no row is moved past them.
      while (at < rows.length && !listed.has(rows[at].dataset.key)) rows[at++].remove();
      const row = AUR.button(opts.rowClass);
      row.id = opts.idPrefix + index;
      row.dataset.key = keys[index];
      row.setAttribute('role', 'option');
      opts.fill(row, entry);
      markRow(row, index === state.selected);
      const old = held.get(row.dataset.key);
      // Where the entry's row stands among those not yet placed; a new entry has none.
      const from = old ? rows.indexOf(old, at) : -1;
      if (from < 0) { list.insertBefore(row, rows[at] || null); return; }
      if (from === at) at++;
      else { list.insertBefore(old, rows[at]); rows.splice(from, 1); }
      adopt(old, row);
    });
    while (at < rows.length) rows[at++].remove();
    input.setAttribute('aria-activedescendant', opts.idPrefix + state.selected);
    const selectedRow = list.children[state.selected];
    if (selectedRow && selectedRow !== was) selectedRow.scrollIntoView({ block: 'nearest' });
  };
})();

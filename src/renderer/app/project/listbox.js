// @ts-check
// The listbox the search results and the ALL PROJECTS directory share: debounce, keys, selection, rows.
'use strict';

(function () {
  const AUR = window.AUR;
  const A = AUR.app;
  if (!A) throw new Error('app/state.js must load before app/project/listbox.js');
  const C = A.const;

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
   * Escape runs `escape`; arrows move the selection (`select` shows it) and Enter activates it, once
   * a pending query has run. While an input method composes text the keys are its own: Enter
   * commits the text and Escape cancels it.
   */
  A.wireListboxKeys = function wireListboxKeys(input, state, { escape, update, activate, select }) {
    input.addEventListener('keydown', (event) => {
      if (event.isComposing || event.keyCode === 229) return;
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

  /** Makes `row` read as `fresh` does, keeping the element: a press on it still ends in its click. */
  function adoptRow(row, fresh) {
    for (const { name } of [...row.attributes]) if (!fresh.hasAttribute(name)) row.removeAttribute(name);
    for (const { name, value } of [...fresh.attributes]) if (row.getAttribute(name) !== value) row.setAttribute(name, value);
    row.replaceChildren(...fresh.childNodes);
  }

  /**
   * One `rowClass` option button per result, completed by `fill`; the selected one is the active
   * descendant. A row whose entry (`keyOf`) stays in its place keeps its element, changed only
   * where its content did, so a refresh from the store neither drops a click that is under way nor
   * moves the list; the selected row is brought into view only when the selection moved.
   */
  A.renderListbox = function renderListbox(list, input, state, opts) {
    if (state.results.length === 0) {
      AUR.clear(list);
      list.appendChild(AUR.el('div', opts.emptyClass, opts.emptyText));
      input.removeAttribute('aria-activedescendant');
      return;
    }
    const was = list.querySelector('[aria-selected="true"]');
    const wasAt = was instanceof HTMLElement ? was.id + ' ' + was.dataset.key : '';
    state.results.forEach((entry, index) => {
      const row = AUR.button(opts.rowClass, null, () => opts.activate(index));
      row.id = opts.idPrefix + index;
      row.dataset.key = String(opts.keyOf(entry));
      row.setAttribute('role', 'option');
      opts.fill(row, entry);
      markRow(row, index === state.selected);
      const old = list.children[index];
      if (!old) list.appendChild(row);
      else if (!(old instanceof HTMLButtonElement) || old.dataset.key !== row.dataset.key) list.replaceChild(row, old);
      else if (!old.isEqualNode(row)) adoptRow(old, row);
    });
    while (list.children.length > state.results.length) list.lastElementChild.remove();
    input.setAttribute('aria-activedescendant', opts.idPrefix + state.selected);
    const selectedRow = /** @type {HTMLElement} */ (list.children[state.selected]);
    if (selectedRow.id + ' ' + selectedRow.dataset.key !== wasAt) selectedRow.scrollIntoView({ block: 'nearest' });
  };
})();

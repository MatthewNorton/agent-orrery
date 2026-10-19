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

  /** Escape runs `escape`; arrows move the selection and Enter activates it, once a pending query has run. */
  A.wireListboxKeys = function wireListboxKeys(input, state, { escape, update, activate, render }) {
    input.addEventListener('keydown', (event) => {
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
      render();
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

  /** One `rowClass` option button per result, completed by `fill`; the selected one is the active descendant. */
  A.renderListbox = function renderListbox(list, input, state, opts) {
    AUR.clear(list);
    if (state.results.length === 0) {
      list.appendChild(AUR.el('div', opts.emptyClass, opts.emptyText));
      input.removeAttribute('aria-activedescendant');
      return;
    }
    let selectedRow = null;
    state.results.forEach((entry, index) => {
      const selected = index === state.selected;
      const row = AUR.button(opts.rowClass + (selected ? ' selected' : ''), null, () => opts.activate(index));
      row.id = opts.idPrefix + index;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(selected));
      opts.fill(row, entry);
      list.appendChild(row);
      if (selected) selectedRow = row;
    });
    input.setAttribute('aria-activedescendant', opts.idPrefix + state.selected);
    if (selectedRow) selectedRow.scrollIntoView({ block: 'nearest' });
  };
})();

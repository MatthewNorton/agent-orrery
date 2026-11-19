// @ts-check
// Go to: the search palette, a dialog from the top bar's search button, / or Ctrl K. Its query ranks
// projects, agents and folders (search-core.js) under the GitHub filter and brightens the matching
// systems on the universe map; rows are filled by app/project/search-rows.js.
'use strict';

(function () {
  const AUR = window.AUR;
  const VCS = AUR.ProjectVcsStatus;
  const A = AUR.app;
  if (!A) throw new Error('app/state.js must load before app/project/search.js');
  const S = A.state;
  const LABEL = 'Go to a project, agent or folder';
  const ROW_ID = 'search-result-';

  A.wireProjectSearch = function wireProjectSearch() {
    wireVcsFilter();
    const els = {
      button: document.getElementById('search-button'),
      dialog: /** @type {HTMLDialogElement | null} */ (document.getElementById('search-dialog')),
      input: /** @type {HTMLInputElement | null} */ (document.getElementById('search-input')),
      results: document.getElementById('search-results'),
      scope: document.getElementById('search-scope'),
    };
    // Wired whole or not at all: everything below takes a missing els for a palette that is not there.
    if (!els.button || !els.dialog || !els.input || !els.results) return;
    S.projectSearch.els = els;

    A.titleWithKey(els.button, LABEL, 'search');
    els.button.addEventListener('click', A.openProjectSearch);
    AUR.closeOnBackdrop(els.dialog, A.clearProjectSearch);
    els.dialog.addEventListener('close', finishClose);

    els.input.addEventListener('input', () => {
      if (els.input.value.trim()) {
        A.debounceListbox(S.projectSearch, updateProjectSearch);
        return;
      }
      A.cancelListboxTimer(S.projectSearch);
      updateProjectSearch();
    });

    A.wireListboxKeys(els.input, S.projectSearch, {
      escape: A.clearProjectSearch,
      update: updateProjectSearch,
      activate: activateProjectSearchResult,
      select: () => A.selectListboxRow(els.results, els.input, S.projectSearch, ROW_ID),
    });
  };

  // The GitHub filter narrows the palette, PROJECTS and the map, so it is wired on its own.
  function wireVcsFilter() {
    const filter = document.getElementById('project-vcs-filter');
    if (!filter) return;
    S.projectSearch.filterEls = { filter, count: document.getElementById('project-vcs-filter-count') };
    filter.addEventListener('click', () => {
      S.projectSearch.filter = S.projectSearch.filter === VCS.FILTERS.GITHUB
        ? VCS.FILTERS.ALL : VCS.FILTERS.GITHUB;
      A.refreshProjectSearchFromStore();
      A.refreshProjectDirectoryFromStore();
    });
  }

  /**
   * Opens the palette, or puts the caret back in its field when it is open; false when it cannot:
   * over Settings, or while agent focus has made the top bar, and so the search button, inert.
   * @returns {boolean}
   */
  A.openProjectSearch = function openProjectSearch() {
    const els = S.projectSearch.els;
    if (!els || !els.dialog || S.projectSettings.open || els.button.closest('[inert]')) return false;
    if (!els.dialog.open) {
      A.closeProjectDirectory(false);
      const active = document.activeElement;
      S.projectSearch.opener = active instanceof HTMLElement && active !== document.body ? active : null;
      els.dialog.showModal();
      els.button.setAttribute('aria-expanded', 'true');
      renderProjectVcsFilter();
    }
    els.input.focus();
    els.input.select();
    return true;
  };

  /** Clears the query and closes the palette: Escape, a click outside, a pick, a view switch. */
  A.clearProjectSearch = function clearProjectSearch() {
    // At once, not on the close event: a view switch reads the field straight after.
    resetQuery();
    const dialog = S.projectSearch.els && S.projectSearch.els.dialog;
    if (dialog && dialog.open) dialog.close();
  };

  function resetQuery() {
    A.cancelListboxTimer(S.projectSearch);
    S.projectSearch.query = '';
    S.projectSearch.results = [];
    S.projectSearch.selected = 0;
    const els = S.projectSearch.els;
    if (els && els.input) {
      els.input.value = '';
      renderProjectSearchResults();
    }
    A.syncProjectMatches();
  }

  // However it closed (Escape on a clicked row closes it natively), the query goes and focus goes
  // back where it was, unless a pick has moved on.
  function finishClose() {
    const els = S.projectSearch.els;
    if (els.input.value || S.projectSearch.query) resetQuery();
    els.button.setAttribute('aria-expanded', 'false');
    const back = S.projectSearch.opener;
    S.projectSearch.opener = null;
    if (back && back.isConnected && back.getClientRects().length > 0) back.focus();
  }

  function renderProjectVcsFilter() {
    const fe = S.projectSearch.filterEls;
    if (!fe) return;
    const githubCount = VCS.filterProjects([...S.store.projects.values()], {
      filter: VCS.FILTERS.GITHUB,
    }).length;
    const active = S.projectSearch.filter === VCS.FILTERS.GITHUB;
    fe.filter.setAttribute('aria-pressed', String(active));
    fe.filter.setAttribute('aria-label', active
      ? `Show all projects; ${githubCount} have GitHub repositories`
      : `Focus on the ${githubCount} projects with GitHub repositories`);
    fe.filter.title = active ? 'Show all projects' : 'Focus on GitHub projects';
    if (fe.count) fe.count.textContent = String(githubCount);
    const scope = S.projectSearch.els && S.projectSearch.els.scope;
    if (scope) scope.textContent = active ? 'GitHub projects only' : '';
  }

  A.refreshProjectSearchFromStore = function refreshProjectSearchFromStore() {
    const els = S.projectSearch.els;
    if (els && els.input.value.trim()) { updateProjectSearch(); return; }
    A.syncProjectMatches();
    renderProjectVcsFilter();
  };

  const underFilter = (projects) => VCS.filterProjects(projects, { filter: S.projectSearch.filter });

  /**
   * Brightens `found`'s systems on the view's map; with none given, the projects under the GitHub
   * filter, or no system singled out while it shows all.
   * @param {any[]} [found]
   */
  A.syncProjectMatches = function syncProjectMatches(found) {
    if (!S.activeView) return;
    const projects = found ||
      (S.projectSearch.filter === VCS.FILTERS.ALL ? null : underFilter([...S.store.projects.values()]));
    S.activeView.setSearchMatches(projects && new Set(projects.map((project) => project.id)));
  };

  function updateProjectSearch() {
    const els = S.projectSearch.els;
    if (!els) return;
    const query = els.input.value.trim();
    const queryChanged = query !== S.projectSearch.query;
    const previous = queryChanged ? null : S.projectSearch.results[S.projectSearch.selected];
    S.projectSearch.query = query;
    if (!query) {
      S.projectSearch.results = [];
      S.projectSearch.selected = 0;
      renderProjectSearchResults();
      A.syncProjectMatches();
      renderProjectVcsFilter();
      return;
    }

    const visible = underFilter([...S.store.projects.values()]);
    const shown = new Set(visible.map((project) => project.id));
    // By the name its row shows, then its path, branch and repository together.
    const found = AUR.rankProjects(visible, query, { nameOf: A.projectLabel, othersOf: VCS.otherSearchTexts });
    const rows = [
      ...found.slice(0, 6).map((hit) => ({ kind: 'project', key: 'p:' + hit.project.id, ...hit })),
      ...AUR.searchAgents([...S.store.ships.values()].filter((ship) => shown.has(ship.project)), query, 4)
        .map((hit) => ({ kind: 'agent', key: 'a:' + hit.ship.id, ...hit })),
      ...AUR.searchPlanets(visible, query, 4)
        .map((hit) => ({ kind: 'planet', key: 'f:' + hit.project.id + '/' + hit.planet, ...hit })),
    ];
    // Rows found only fuzzily go after every row found otherwise, each part in the kinds' order.
    S.projectSearch.results = [...rows.filter((row) => !row.fuzzy), ...rows.filter((row) => row.fuzzy)].slice(0, 10);
    A.keepSelection(S.projectSearch, previous, queryChanged, (entry) => entry.key);
    renderProjectSearchResults();
    A.syncProjectMatches(found.map((hit) => hit.project));
    renderProjectVcsFilter();
  }

  function renderProjectSearchResults() {
    const els = S.projectSearch.els;
    if (!els) return;
    const open = Boolean(els.input.value.trim());
    els.results.classList.toggle('hidden', !open);
    els.input.setAttribute('aria-expanded', String(open));
    if (!open) {
      AUR.clear(els.results);
      els.input.removeAttribute('aria-activedescendant');
      return;
    }
    A.renderListbox(els.results, els.input, S.projectSearch, {
      idPrefix: ROW_ID,
      rowClass: 'search-result',
      emptyClass: 'search-empty',
      emptyText: 'Nothing found',
      keyOf: (entry) => entry.key,
      fill: A.searchRowFiller(S.projectSearch.results),
      activate: activateProjectSearchResult,
    });
  }

  function activateProjectSearchResult(index) {
    const entry = S.projectSearch.results[index] || S.projectSearch.results[0];
    if (!entry) return;
    S.projectSearch.opener = null; // the pick moves on, and focus with it
    A.clearProjectSearch();
    // The dialog's own close hands focus back to what had it before the palette. A pick leaves that
    // behind too: a field there would take the next keys as text.
    const restored = document.activeElement;
    if (restored instanceof HTMLElement && restored !== document.body) restored.blur();
    if (entry.kind === 'agent') A.enterAgentFocus(entry.ship.id);
    else if (entry.kind === 'planet') A.openPlanet(entry.project.id, entry.planet);
    else A.openSystem(entry.project.id);
  }
})();

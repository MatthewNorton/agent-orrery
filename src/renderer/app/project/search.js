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
  /** @type {HTMLElement | null} what had focus before the palette opened; a pick clears it */
  let opener = null;

  A.wireProjectSearch = function wireProjectSearch() {
    const dialog = /** @type {HTMLDialogElement | null} */ (document.getElementById('search-dialog'));
    const els = {
      button: document.getElementById('search-button'),
      dialog,
      palette: dialog && dialog.querySelector('.search-palette'),
      input: /** @type {HTMLInputElement | null} */ (document.getElementById('search-input')),
      results: document.getElementById('search-results'),
      scope: document.getElementById('search-scope'),
      filter: document.getElementById('project-vcs-filter'),
      filterCount: document.getElementById('project-vcs-filter-count'),
    };
    // Wired whole or not at all: everything below takes a missing els for a palette that is not there.
    if (!els.button || !els.dialog || !els.palette || !els.input || !els.results) return;
    S.projectSearch.els = els;

    A.titleWithKey(els.button, LABEL, 'search');
    els.button.addEventListener('click', A.openProjectSearch);
    AUR.closeOnBackdrop(els.dialog, els.palette, A.clearProjectSearch);
    els.dialog.addEventListener('close', finishClose);

    els.input.addEventListener('input', () => {
      if (els.input.value.trim()) {
        A.debounceListbox(S.projectSearch, updateProjectSearch);
        return;
      }
      A.cancelListboxTimer(S.projectSearch);
      updateProjectSearch();
    });

    if (els.filter) {
      els.filter.addEventListener('click', () => {
        S.projectSearch.filter = S.projectSearch.filter === VCS.FILTERS.GITHUB
          ? VCS.FILTERS.ALL : VCS.FILTERS.GITHUB;
        updateProjectSearch();
        A.refreshProjectDirectoryFromStore();
      });
    }

    A.wireListboxKeys(els.input, S.projectSearch, {
      escape: A.clearProjectSearch,
      update: updateProjectSearch,
      activate: activateProjectSearchResult,
      render: renderProjectSearchResults,
    });
  };

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
      opener = active instanceof HTMLElement && active !== document.body ? active : null;
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
    const back = opener;
    opener = null;
    if (back && back.isConnected && back.getClientRects().length > 0) back.focus();
  }

  function renderProjectVcsFilter() {
    const els = S.projectSearch.els;
    if (!els || !els.filter) return;
    const githubCount = VCS.filterProjects([...S.store.projects.values()], {
      filter: VCS.FILTERS.GITHUB,
    }).length;
    const active = S.projectSearch.filter === VCS.FILTERS.GITHUB;
    els.filter.setAttribute('aria-pressed', String(active));
    els.filter.setAttribute('aria-label', active
      ? `Show all projects; ${githubCount} have GitHub repositories`
      : `Focus on the ${githubCount} projects with GitHub repositories`);
    els.filter.title = active ? 'Show all projects' : 'Focus on GitHub projects';
    if (els.filterCount) els.filterCount.textContent = String(githubCount);
    if (els.scope) els.scope.textContent = active ? 'GitHub projects only' : '';
  }

  A.refreshProjectSearchFromStore = function refreshProjectSearchFromStore() {
    const els = S.projectSearch.els;
    if (!els) return;
    if (els.input.value.trim()) updateProjectSearch();
    else { A.syncProjectMatches(); renderProjectVcsFilter(); }
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
    // After its name, a project's path, branch and repository rank together (VCS.searchTexts).
    const found = AUR.rankProjects(visible, query, VCS.searchTexts);
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

  /** A project's galaxy, repository, branch and path, joined: a project's line in other lists. */
  A.projectSearchSubtitle = function projectSearchSubtitle(project) {
    const galaxy = A.projectGalaxyLabel(project);
    const detail = [];
    if (galaxy) detail.push(String(galaxy));
    const vcs = VCS.normalize(project);
    if (vcs.nameWithOwner) detail.push(vcs.nameWithOwner);
    if (vcs.branch) detail.push(vcs.branch);
    if (project.path) detail.push(String(project.path));
    return detail.join(' · ');
  };

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
    const fill = A.searchRowFiller(S.projectSearch.results);
    A.renderListbox(els.results, els.input, S.projectSearch, {
      idPrefix: 'search-result-',
      rowClass: 'search-result',
      emptyClass: 'search-empty',
      emptyText: 'Nothing found',
      fill,
      activate: activateProjectSearchResult,
    });
  }

  function activateProjectSearchResult(index) {
    const entry = S.projectSearch.results[index] || S.projectSearch.results[0];
    if (!entry) return;
    opener = null; // the pick moves on, and focus with it
    A.clearProjectSearch();
    if (entry.kind === 'agent') A.enterAgentFocus(entry.ship.id);
    else if (entry.kind === 'planet') A.openPlanet(entry.project.id, entry.planet);
    else A.openSystem(entry.project.id);
  }
})();

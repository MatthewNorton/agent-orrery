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

  /** `ranked` first, then the rest of `matches`, sorted by `compareRest` when given. */
  A.rankedFirst = function rankedFirst(matches, ranked, compareRest) {
    const rankedIds = new Set(ranked.map((project) => project.id));
    const rest = matches.filter((project) => !rankedIds.has(project.id));
    return [...ranked, ...(compareRest ? rest.sort(compareRest) : rest)];
  };

  A.wireProjectSearch = function wireProjectSearch() {
    S.projectSearch.els = {
      button: document.getElementById('search-button'),
      dialog: /** @type {HTMLDialogElement | null} */ (document.getElementById('search-dialog')),
      input: /** @type {HTMLInputElement | null} */ (document.getElementById('search-input')),
      results: document.getElementById('search-results'),
      scope: document.getElementById('search-scope'),
      filter: document.getElementById('project-vcs-filter'),
      filterCount: document.getElementById('project-vcs-filter-count'),
    };
    const els = S.projectSearch.els;
    if (!els.button || !els.dialog || !els.input || !els.results) return;

    A.titleWithKey(els.button, LABEL, 'search');
    els.button.addEventListener('click', A.openProjectSearch);
    // The dialog is the palette's box, so a click on the dialog itself fell on the backdrop.
    els.dialog.addEventListener('click', (event) => {
      if (event.target === els.dialog) A.clearProjectSearch();
    });
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
   * Opens the palette, or puts the caret back in its field when it is open. Not over Settings, nor
   * while agent focus has made the top bar, and so the search button, inert.
   */
  A.openProjectSearch = function openProjectSearch() {
    const els = S.projectSearch.els;
    if (!els || !els.dialog || S.projectSettings.open || els.button.closest('[inert]')) return;
    if (!els.dialog.open) {
      A.closeProjectDirectory(false);
      const active = document.activeElement;
      S.projectSearch.opener = active instanceof HTMLElement && active !== document.body ? active : null;
      S.projectSearch.open = true;
      els.dialog.showModal();
      els.button.setAttribute('aria-expanded', 'true');
      renderProjectVcsFilter();
    }
    els.input.focus();
    els.input.select();
  };

  /** Clears the query and closes the palette: Escape, a click outside, a pick, a view switch. */
  A.clearProjectSearch = function clearProjectSearch() {
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

  // However it closed, focus goes back where it was, unless a pick has moved on.
  function finishClose() {
    const els = S.projectSearch.els;
    S.projectSearch.open = false;
    resetQuery();
    els.button.setAttribute('aria-expanded', 'false');
    const opener = S.projectSearch.opener;
    S.projectSearch.opener = null;
    if (opener && opener.isConnected && opener.getClientRects().length > 0) opener.focus();
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

  // The palette's projects for a query: name, path and fuzzy ranks (search-core.js), with the
  // projects whose repository or branch holds the query after the sure ranks and before the fuzzy.
  function findProjects(projects, query) {
    const filtered = underFilter(projects);
    if (!query) return filtered;
    const ranked = AUR.searchProjects(filtered, query, Math.max(filtered.length, 1));
    const rankedIds = new Set(ranked.map((project) => project.id));
    const sure = new Set(VCS.filterProjects(filtered, { query }).map((project) => project.id));
    return [
      ...ranked.filter((project) => sure.has(project.id)),
      ...filtered.filter((project) => sure.has(project.id) && !rankedIds.has(project.id)).sort(A.byProjectName),
      ...ranked.filter((project) => !sure.has(project.id)),
    ];
  }

  /**
   * Brightens the matching systems on the view's map. With no query given, the palette's own
   * matches; the directory gives its query, matched on name, path, branch and repository.
   * @param {any[]} [projects] @param {string} [query]
   */
  A.syncProjectMatches = function syncProjectMatches(projects, query) {
    if (!S.activeView) return;
    const palette = query == null;
    const needle = palette && S.projectSearch.els ? S.projectSearch.els.input.value.trim() : String(query || '').trim();
    if (!needle && S.projectSearch.filter === VCS.FILTERS.ALL) {
      S.activeView.setSearchMatches(null);
      return;
    }
    const source = projects || [...S.store.projects.values()];
    const found = palette ? findProjects(source, needle)
      : VCS.filterProjects(source, { filter: S.projectSearch.filter, query: needle });
    S.activeView.setSearchMatches(new Set(found.map((project) => project.id)));
  };

  function onlyFuzzy(entry, query) {
    if (entry.kind === 'project') return !VCS.matchesSearch(entry.project, query);
    const hit = AUR.matchText(entry.kind === 'agent' ? entry.ship.name : entry.planet, query);
    const status = entry.kind === 'agent' && String(entry.ship.status || '').toLowerCase().includes(query.toLowerCase());
    return Boolean(hit && hit.rank === AUR.SEARCH_FUZZY && !status);
  }

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

    const projects = [...S.store.projects.values()];
    const shown = new Set(underFilter(projects).map((project) => project.id));
    const projectEntries = findProjects(projects, query).slice(0, 6)
      .map((project) => ({ kind: 'project', key: 'p:' + project.id, project }));
    const agentEntries = AUR.searchAgents([...S.store.ships.values()].filter((ship) => shown.has(ship.project)), query, 4)
      .map((ship) => ({ kind: 'agent', key: 'a:' + ship.id, ship }));
    const planetEntries = AUR.searchPlanets(underFilter(projects), query, 4)
      .map((hit) => ({ kind: 'planet', key: 'f:' + hit.project.id + '/' + hit.planet, project: hit.project, planet: hit.planet }));
    // Rows found only fuzzily go after every row found otherwise; the sort keeps the kinds' order.
    S.projectSearch.results = [...projectEntries, ...agentEntries, ...planetEntries]
      .sort((a, b) => Number(onlyFuzzy(a, query)) - Number(onlyFuzzy(b, query))).slice(0, 10);
    A.keepSelection(S.projectSearch, previous, queryChanged, (entry) => entry.key);
    renderProjectSearchResults();
    A.syncProjectMatches(projects);
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
    const fill = A.searchRowFiller(S.projectSearch.results, S.projectSearch.query);
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
    S.projectSearch.opener = null;
    A.clearProjectSearch();
    if (entry.kind === 'agent') A.enterAgentFocus(entry.ship.id);
    else if (entry.kind === 'planet') A.openPlanet(entry.project.id, entry.planet);
    else A.openSystem(entry.project.id);
  }
})();

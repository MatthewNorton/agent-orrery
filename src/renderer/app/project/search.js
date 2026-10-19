// @ts-check
// Project search in every view: topbar query, GitHub filter, universe match highlighting, shared ranking.
'use strict';

(function () {
  const AUR = window.AUR;
  const VCS = AUR.ProjectVcsStatus;
  const A = AUR.app;
  if (!A) throw new Error('app/state.js must load before app/project/search.js');
  const S = A.state;

  /** `ranked` first, then the rest of `matches`, sorted by `compareRest` when given. */
  A.rankedFirst = function rankedFirst(matches, ranked, compareRest) {
    const rankedIds = new Set(ranked.map((project) => project.id));
    const rest = matches.filter((project) => !rankedIds.has(project.id));
    return [...ranked, ...(compareRest ? rest.sort(compareRest) : rest)];
  };

  // ---------- project search ----------
  A.wireProjectSearch = function wireProjectSearch() {
    S.projectSearch.els = {
      input: document.getElementById('search-input'),
      results: document.getElementById('search-results'),
      filter: document.getElementById('project-vcs-filter'),
      filterCount: document.getElementById('project-vcs-filter-count'),
    };
    const els = S.projectSearch.els;
    if (!els.input || !els.results) return;

    els.input.addEventListener('input', () => {
      if (els.input.value.trim()) {
        A.debounceListbox(S.projectSearch, updateProjectSearch);
        return;
      }
      A.cancelListboxTimer(S.projectSearch);
      updateProjectSearch();
    });

    els.input.addEventListener('focus', () => A.closeProjectDirectory(false));

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

  A.clearProjectSearch = function clearProjectSearch() {
    A.cancelListboxTimer(S.projectSearch);
    S.projectSearch.query = '';
    S.projectSearch.results = [];
    S.projectSearch.selected = 0;
    const els = S.projectSearch.els;
    if (els) {
      els.input.value = '';
      els.input.setAttribute('aria-expanded', 'false');
      els.input.removeAttribute('aria-activedescendant');
      els.results.classList.add('hidden');
      AUR.clear(els.results);
    }
    A.syncProjectMatches();
  };

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
  }

  A.refreshProjectSearchFromStore = function refreshProjectSearchFromStore() {
    const els = S.projectSearch.els;
    if (!els) return;
    if (els.input.value.trim()) updateProjectSearch();
    else { A.syncProjectMatches(); renderProjectVcsFilter(); }
  };

  function matchingProjects(projects, query) {
    return VCS.filterProjects(projects, { filter: S.projectSearch.filter, query });
  }

  A.syncProjectMatches = function syncProjectMatches(projects, query) {
    if (!S.activeView) return;
    const needle = query == null && S.projectSearch.els
      ? S.projectSearch.els.input.value.trim() : String(query || '').trim();
    if (!needle && S.projectSearch.filter === VCS.FILTERS.ALL) {
      S.activeView.setSearchMatches(null);
      return;
    }
    const source = projects || [...S.store.projects.values()];
    S.activeView.setSearchMatches(new Set(matchingProjects(source, needle).map((project) => project.id)));
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

    const projects = [...S.store.projects.values()];
    const matches = matchingProjects(projects, query);
    const projectEntries = A.rankedFirst(matches, AUR.searchProjects(matches, query), A.byProjectName)
      .slice(0, 6)
      .map((project) => ({ kind: 'project', key: 'p:' + project.id, project }));
    const agentEntries = AUR.searchAgents([...S.store.ships.values()], query, 4)
      .map((ship) => ({ kind: 'agent', key: 'a:' + ship.id, ship }));
    const planetEntries = AUR.searchPlanets(projects, query, 4)
      .map((hit) => ({ kind: 'planet', key: 'f:' + hit.project.id + '/' + hit.planet, project: hit.project, planet: hit.planet }));
    S.projectSearch.results = [...projectEntries, ...agentEntries, ...planetEntries].slice(0, 10);
    A.keepSelection(S.projectSearch, previous, queryChanged, (entry) => entry.key);
    renderProjectSearchResults();
    A.syncProjectMatches(projects, query);
    renderProjectVcsFilter();
  }

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
    A.renderListbox(els.results, els.input, S.projectSearch, {
      idPrefix: 'search-result-',
      rowClass: 'search-result',
      emptyClass: 'search-empty',
      emptyText: 'Nothing found',
      fill: fillSearchRow,
      activate: activateProjectSearchResult,
    });
  }

  function fillSearchRow(row, entry) {
    const live = entry.kind === 'project' && A.shipsInProject(entry.project.id).length > 0;
    const dot = AUR.el('span', 'search-result-dot' + (live ? ' live' : ''));
    if (entry.kind === 'agent') dot.style.background = AUR.providerMeta(entry.ship.provider).color;
    const copy = AUR.el('span', 'search-result-copy');
    let name, meta, kind;
    if (entry.kind === 'agent') {
      name = entry.ship.name; meta = entry.ship.status + ' · ' + A.projectName(entry.ship.project); kind = 'Agent';
    } else if (entry.kind === 'planet') {
      name = entry.planet; meta = A.projectLabel(entry.project); kind = 'Folder';
    } else {
      name = A.projectLabel(entry.project); meta = A.projectSearchSubtitle(entry.project); kind = 'Project';
    }
    copy.append(AUR.el('span', 'search-result-name', name), AUR.el('span', 'search-result-meta', meta));
    row.append(dot, copy, AUR.el('span', 'search-result-kind', kind));
  }

  function activateProjectSearchResult(index) {
    const entry = S.projectSearch.results[index] || S.projectSearch.results[0];
    if (!entry) return;
    A.clearProjectSearch();
    if (entry.kind === 'agent') A.enterAgentFocus(entry.ship.id);
    else if (entry.kind === 'planet') A.openPlanet(entry.project.id, entry.planet);
    else A.openSystem(entry.project.id);
  }
})();

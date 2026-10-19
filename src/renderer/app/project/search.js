// @ts-check
// Project search in every view: topbar query, GitHub filter, universe match highlighting.
'use strict';

(function () {
  const AUR = window.AUR;
  const VCS = AUR.ProjectVcsStatus;
  const A = AUR.app;
  if (!A) throw new Error('app/state.js must load before app/project/search.js');
  const S = A.state, C = A.const;

  // ---------- listbox: the search results and the ALL PROJECTS directory ----------
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

  /** `ranked` first, then the rest of `matches`, sorted by `compareRest` when given. */
  A.rankedFirst = function rankedFirst(matches, ranked, compareRest) {
    const rankedIds = new Set(ranked.map((project) => project.id));
    const rest = matches.filter((project) => !rankedIds.has(project.id));
    return [...ranked, ...(compareRest ? rest.sort(compareRest) : rest)];
  };

  /** One option button per result, completed by `fill`; the selected one is the active descendant. */
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
      const row = AUR.button(opts.rowClass(entry) + (selected ? ' selected' : ''));
      row.id = opts.idPrefix + index;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(selected));
      opts.fill(row, entry);
      row.addEventListener('click', () => opts.activate(index));
      list.appendChild(row);
      if (selected) selectedRow = row;
    });
    input.setAttribute('aria-activedescendant', opts.idPrefix + state.selected);
    if (selectedRow) selectedRow.scrollIntoView({ block: 'nearest' });
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
    const source = projects || [...S.store.projects.values()];
    const needle = query == null && S.projectSearch.els
      ? S.projectSearch.els.input.value.trim() : String(query || '').trim();
    const active = Boolean(needle) || S.projectSearch.filter !== VCS.FILTERS.ALL;
    S.activeView.setSearchMatches(active
      ? new Set(matchingProjects(source, needle).map((project) => project.id))
      : null);
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
      rowClass: () => 'search-result',
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

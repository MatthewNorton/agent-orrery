// @ts-check
// app/project/search.js — project search in every view: topbar query, GitHub filter, universe match highlighting.
'use strict';

(function () {
  const AUR = window.AUR;
  const VCS = AUR.ProjectVcsStatus;
  const A = AUR.app;               // created by app/state.js; throw if missing
  if (!A) throw new Error('app/state.js must load before app/project/search.js');
  const S = A.state, C = A.const;

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
      cancelProjectSearchTimer();
      if (!els.input.value.trim()) {
        updateProjectSearch();
        return;
      }
      S.projectSearch.timer = setTimeout(() => {
        S.projectSearch.timer = null;
        updateProjectSearch();
      }, C.SEARCH_DEBOUNCE_MS);
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

    els.input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        A.clearProjectSearch();
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter') return;
      event.preventDefault();
      event.stopPropagation();
      flushProjectSearch();
      if (event.key === 'Enter') {
        activateProjectSearchResult(S.projectSearch.selected);
        return;
      }
      if (S.projectSearch.results.length === 0) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      S.projectSearch.selected = (S.projectSearch.selected + delta + S.projectSearch.results.length) %
        S.projectSearch.results.length;
      renderProjectSearchResults();
    });
  };

  function cancelProjectSearchTimer() {
    if (S.projectSearch.timer != null) clearTimeout(S.projectSearch.timer);
    S.projectSearch.timer = null;
  }

  function flushProjectSearch() {
    if (S.projectSearch.timer == null) return;
    cancelProjectSearchTimer();
    updateProjectSearch();
  }

  A.clearProjectSearch = function clearProjectSearch() {
    cancelProjectSearchTimer();
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
    if (!S.activeView || typeof S.activeView.setSearchMatches !== 'function') return;
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
    const ranked = AUR.searchProjects(matches, query);
    const rankedIds = new Set(ranked.map((project) => project.id));
    const extras = matches.filter((project) => !rankedIds.has(project.id)).sort((a, b) =>
      String(a.name || a.id).localeCompare(String(b.name || b.id))
    );
    const projectEntries = [...ranked, ...extras].slice(0, 6)
      .map((project) => ({ kind: 'project', key: 'p:' + project.id, project }));
    const agentEntries = AUR.searchAgents([...S.store.ships.values()], query, 4)
      .map((ship) => ({ kind: 'agent', key: 'a:' + ship.id, ship }));
    const planetEntries = AUR.searchPlanets(projects, query, 4)
      .map((hit) => ({ kind: 'planet', key: 'f:' + hit.project.id + '/' + hit.planet, project: hit.project, planet: hit.planet }));
    S.projectSearch.results = [...projectEntries, ...agentEntries, ...planetEntries].slice(0, 10);
    const previousIndex = previous
      ? S.projectSearch.results.findIndex((entry) => entry.key === previous.key)
      : -1;
    S.projectSearch.selected = queryChanged ? 0 : previousIndex >= 0
      ? previousIndex : Math.min(S.projectSearch.selected, Math.max(0, S.projectSearch.results.length - 1));
    renderProjectSearchResults();
    A.syncProjectMatches(projects, query);
    renderProjectVcsFilter();
  }

  A.projectSearchSubtitle = function projectSearchSubtitle(project) {
    const galaxy = typeof project.galaxy === 'string'
      ? project.galaxy
      : project.galaxy && (project.galaxy.label || project.galaxy.key);
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
    AUR.clear(els.results);
    if (!open) {
      els.input.removeAttribute('aria-activedescendant');
      return;
    }
    if (S.projectSearch.results.length === 0) {
      els.results.appendChild(AUR.el('div', 'search-empty', 'Nothing found'));
      els.input.removeAttribute('aria-activedescendant');
      return;
    }

    S.projectSearch.results.forEach((entry, index) => {
      const selected = index === S.projectSearch.selected;
      const row = AUR.el('button', 'search-result' + (selected ? ' selected' : ''));
      row.type = 'button';
      row.id = 'search-result-' + index;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(selected));
      const live = entry.kind === 'project' && A.shipsInProject(entry.project.id).length > 0;
      const dot = AUR.el('span', 'search-result-dot' + (live ? ' live' : ''));
      if (entry.kind === 'agent') dot.style.background = AUR.providerMeta(entry.ship.provider).color;
      const copy = AUR.el('span', 'search-result-copy');
      let name, meta, kind;
      if (entry.kind === 'agent') {
        name = entry.ship.name; meta = entry.ship.status + ' · ' + A.projectName(entry.ship.project); kind = 'Agent';
      } else if (entry.kind === 'planet') {
        name = entry.planet; meta = entry.project.name || entry.project.id; kind = 'Folder';
      } else {
        name = entry.project.name || entry.project.id; meta = A.projectSearchSubtitle(entry.project); kind = 'Project';
      }
      copy.appendChild(AUR.el('span', 'search-result-name', name));
      copy.appendChild(AUR.el('span', 'search-result-meta', meta));
      row.appendChild(dot);
      row.appendChild(copy);
      row.appendChild(AUR.el('span', 'search-result-kind', kind));
      row.addEventListener('click', () => activateProjectSearchResult(index));
      els.results.appendChild(row);
    });
    els.input.setAttribute('aria-activedescendant', 'search-result-' + S.projectSearch.selected);
    const selectedRow = els.results.querySelector('.search-result.selected');
    if (selectedRow) selectedRow.scrollIntoView({ block: 'nearest' });
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

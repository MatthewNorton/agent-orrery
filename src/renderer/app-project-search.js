// app-project-search.js — universe project search and the searchable all-projects directory.
'use strict';

(function () {
  const AUR = window.AUR;
  const VCS = AUR.ProjectVcsStatus;
  const A = AUR.app;               // created by app-state.js; throw if missing
  if (!A) throw new Error('app-state.js must load before app-project-search.js');
  const S = A.state, C = A.const;

  // ---------- universe project search ----------
  A.wireProjectSearch = function wireProjectSearch() {
    S.projectSearch.els = {
      root: document.getElementById('project-search'),
      input: document.getElementById('search-input'),
      results: document.getElementById('search-results'),
      filter: document.getElementById('project-vcs-filter'),
      filterCount: document.getElementById('project-vcs-filter-count'),
    };
    const els = S.projectSearch.els;
    if (!els.root || !els.input || !els.results) return;

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
    if (S.activeView && typeof S.activeView.setSearchMatches === 'function') {
      syncUniverseProjectMatches();
    }
  };

  A.renderProjectSearchVisibility = function renderProjectSearchVisibility() {
    const els = S.projectSearch.els;
    if (!els) return;
    els.root.classList.toggle('hidden', S.current.view !== 'universe');
    renderProjectVcsFilter();
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
    A.renderProjectSearchVisibility();
    if (!els || S.current.view !== 'universe') return;
    if (els.input.value.trim() || S.projectSearch.filter !== VCS.FILTERS.ALL) updateProjectSearch();
    else syncUniverseProjectMatches();
  };

  function matchingUniverseProjects(projects, query) {
    return VCS.filterProjects(projects, { filter: S.projectSearch.filter, query });
  }

  function syncUniverseProjectMatches(projects, query) {
    if (!S.activeView || typeof S.activeView.setSearchMatches !== 'function' ||
        S.current.view !== 'universe') return;
    const source = projects || [...S.store.projects.values()];
    const needle = query == null && S.projectSearch.els
      ? S.projectSearch.els.input.value.trim() : String(query || '').trim();
    const active = Boolean(needle) || S.projectSearch.filter !== VCS.FILTERS.ALL;
    S.activeView.setSearchMatches(active
      ? new Set(matchingUniverseProjects(source, needle).map((project) => project.id))
      : null);
  }

  function updateProjectSearch() {
    const els = S.projectSearch.els;
    if (!els || S.current.view !== 'universe') return;
    const query = els.input.value.trim();
    const queryChanged = query !== S.projectSearch.query;
    const previous = queryChanged ? null : S.projectSearch.results[S.projectSearch.selected];
    S.projectSearch.query = query;
    if (!query) {
      S.projectSearch.results = [];
      S.projectSearch.selected = 0;
      renderProjectSearchResults();
      syncUniverseProjectMatches();
      renderProjectVcsFilter();
      return;
    }

    const projects = [...S.store.projects.values()];
    const matches = matchingUniverseProjects(projects, query);
    const ranked = AUR.searchProjects(matches, query);
    const rankedIds = new Set(ranked.map((project) => project.id));
    const extras = matches.filter((project) => !rankedIds.has(project.id)).sort((a, b) =>
      String(a.name || a.id).localeCompare(String(b.name || b.id))
    );
    S.projectSearch.results = [...ranked, ...extras].slice(0, 8);
    const previousIndex = previous
      ? S.projectSearch.results.findIndex((project) => project.id === previous.id)
      : -1;
    S.projectSearch.selected = queryChanged ? 0 : previousIndex >= 0
      ? previousIndex : Math.min(S.projectSearch.selected, Math.max(0, S.projectSearch.results.length - 1));
    renderProjectSearchResults();
    syncUniverseProjectMatches(projects, query);
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
    const open = S.current.view === 'universe' && Boolean(els.input.value.trim());
    els.results.classList.toggle('hidden', !open);
    els.input.setAttribute('aria-expanded', String(open));
    AUR.clear(els.results);
    if (!open) {
      els.input.removeAttribute('aria-activedescendant');
      return;
    }
    if (S.projectSearch.results.length === 0) {
      els.results.appendChild(AUR.el('div', 'search-empty', 'No systems found'));
      els.input.removeAttribute('aria-activedescendant');
      return;
    }

    S.projectSearch.results.forEach((project, index) => {
      const selected = index === S.projectSearch.selected;
      const row = AUR.el('button', 'search-result' + (selected ? ' selected' : ''));
      row.type = 'button';
      row.id = 'search-result-' + index;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(selected));
      const dot = AUR.el('span', 'search-result-dot' +
        (A.shipsInProject(project.id).length > 0 ? ' live' : ''));
      const copy = AUR.el('span', 'search-result-copy');
      copy.appendChild(AUR.el('span', 'search-result-name', project.name || project.id));
      copy.appendChild(AUR.el('span', 'search-result-meta', A.projectSearchSubtitle(project)));
      row.appendChild(dot);
      row.appendChild(copy);
      row.addEventListener('click', () => activateProjectSearchResult(index));
      els.results.appendChild(row);
    });
    els.input.setAttribute('aria-activedescendant', 'search-result-' + S.projectSearch.selected);
    const selectedRow = els.results.querySelector('.search-result.selected');
    if (selectedRow) selectedRow.scrollIntoView({ block: 'nearest' });
  }

  function activateProjectSearchResult(index) {
    const project = S.projectSearch.results[index] || S.projectSearch.results[0];
    if (!project) return;
    A.clearProjectSearch();
    A.openSystem(project.id);
  }

  // ---------- searchable all-projects directory ----------
  A.wireProjectDirectory = function wireProjectDirectory() {
    S.projectDirectory.els = {
      button: document.getElementById('project-directory-button'),
      buttonCount: document.getElementById('project-directory-button-count'),
      panel: document.getElementById('project-directory'),
      scrim: document.getElementById('project-directory-scrim'),
      close: document.getElementById('project-directory-close'),
      subtitle: document.getElementById('project-directory-subtitle'),
      input: document.getElementById('project-directory-input'),
      list: document.getElementById('project-directory-list'),
    };
    const els = S.projectDirectory.els;
    if (!els.button || !els.buttonCount || !els.panel || !els.scrim || !els.close ||
        !els.subtitle || !els.input || !els.list) return;

    els.button.addEventListener('click', () => {
      if (S.projectDirectory.open) A.closeProjectDirectory();
      else openProjectDirectory();
    });
    els.close.addEventListener('click', () => A.closeProjectDirectory());
    els.scrim.addEventListener('click', () => A.closeProjectDirectory());
    els.input.addEventListener('input', () => {
      cancelProjectDirectoryTimer();
      S.projectDirectory.timer = setTimeout(() => {
        S.projectDirectory.timer = null;
        updateProjectDirectory();
      }, C.SEARCH_DEBOUNCE_MS);
    });
    els.input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        A.closeProjectDirectory();
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter') return;
      event.preventDefault();
      event.stopPropagation();
      flushProjectDirectory();
      if (event.key === 'Enter') {
        activateProjectDirectoryResult(S.projectDirectory.selected);
        return;
      }
      if (S.projectDirectory.results.length === 0) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      S.projectDirectory.selected = (
        S.projectDirectory.selected + delta + S.projectDirectory.results.length
      ) % S.projectDirectory.results.length;
      renderProjectDirectoryResults();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !S.projectDirectory.open) return;
      event.preventDefault();
      A.closeProjectDirectory();
    });
    A.renderProjectDirectory();
  };

  function openProjectDirectory() {
    const els = S.projectDirectory.els;
    if (!els || S.projectDirectory.open) return;
    A.clearProjectSearch();
    S.projectDirectory.open = true;
    S.projectDirectory.query = '';
    S.projectDirectory.selected = 0;
    els.input.value = '';
    updateProjectDirectory();
    requestAnimationFrame(() => els.input.focus());
  }

  A.closeProjectDirectory = function closeProjectDirectory(restoreFocus = true) {
    const els = S.projectDirectory.els;
    if (!els || !S.projectDirectory.open) return;
    cancelProjectDirectoryTimer();
    S.projectDirectory.open = false;
    S.projectDirectory.query = '';
    S.projectDirectory.results = [];
    S.projectDirectory.selected = 0;
    els.input.value = '';
    A.renderProjectDirectory();
    if (S.activeView && typeof S.activeView.setSearchMatches === 'function') {
      syncUniverseProjectMatches();
    }
    if (restoreFocus) els.button.focus();
  };

  function cancelProjectDirectoryTimer() {
    if (S.projectDirectory.timer != null) clearTimeout(S.projectDirectory.timer);
    S.projectDirectory.timer = null;
  }

  function flushProjectDirectory() {
    if (S.projectDirectory.timer == null) return;
    cancelProjectDirectoryTimer();
    updateProjectDirectory();
  }

  function projectsByActivity() {
    const activeCounts = new Map();
    for (const ship of S.store.ships.values()) {
      activeCounts.set(ship.project, (activeCounts.get(ship.project) || 0) + 1);
    }
    return [...S.store.projects.values()].sort((a, b) => {
      const activeDelta = (activeCounts.get(b.id) || 0) - (activeCounts.get(a.id) || 0);
      if (activeDelta !== 0) return activeDelta;
      const existsDelta = Number(b.exists !== false) - Number(a.exists !== false);
      if (existsDelta !== 0) return existsDelta;
      const activityDelta = (Number(b.lastActivity) || 0) - (Number(a.lastActivity) || 0);
      if (activityDelta !== 0) return activityDelta;
      return String(a.name || a.id).localeCompare(String(b.name || b.id));
    });
  }

  function updateProjectDirectory() {
    const els = S.projectDirectory.els;
    if (!els || !S.projectDirectory.open) return;
    const query = els.input.value.trim();
    const queryChanged = query !== S.projectDirectory.query;
    const previous = queryChanged ? null : S.projectDirectory.results[S.projectDirectory.selected];
    const allProjects = projectsByActivity();
    const projects = S.current.view === 'universe'
      ? VCS.filterProjects(allProjects, { filter: S.projectSearch.filter })
      : allProjects;
    S.projectDirectory.query = query;
    if (query) {
      const matches = VCS.filterProjects(projects, { query });
      const ranked = AUR.searchProjects(matches, query, Math.max(matches.length, 8));
      const rankedIds = new Set(ranked.map((project) => project.id));
      S.projectDirectory.results = [
        ...ranked,
        ...matches.filter((project) => !rankedIds.has(project.id)),
      ];
    } else {
      S.projectDirectory.results = projects;
    }
    const previousIndex = previous
      ? S.projectDirectory.results.findIndex((project) => project.id === previous.id)
      : -1;
    S.projectDirectory.selected = queryChanged ? 0 : previousIndex >= 0
      ? previousIndex
      : Math.min(S.projectDirectory.selected, Math.max(0, S.projectDirectory.results.length - 1));
    A.renderProjectDirectory();
    if (S.activeView && typeof S.activeView.setSearchMatches === 'function') {
      const active = Boolean(query) || S.projectSearch.filter !== VCS.FILTERS.ALL;
      S.activeView.setSearchMatches(active
        ? new Set(S.projectDirectory.results.map((project) => project.id))
        : null);
    }
  }

  A.refreshProjectDirectoryFromStore = function refreshProjectDirectoryFromStore() {
    A.renderProjectDirectory();
    if (S.projectDirectory.open) updateProjectDirectory();
  };

  A.renderProjectDirectory = function renderProjectDirectory() {
    const els = S.projectDirectory.els;
    if (!els) return;
    const total = S.store.projects.size;
    els.buttonCount.textContent = String(total);
    els.button.setAttribute('aria-label', `Open all projects, ${total} projects`);
    els.button.setAttribute('aria-expanded', String(S.projectDirectory.open));
    els.panel.classList.toggle('hidden', !S.projectDirectory.open);
    els.scrim.classList.toggle('hidden', !S.projectDirectory.open);
    els.input.setAttribute('aria-expanded', String(S.projectDirectory.open));
    if (!S.projectDirectory.open) {
      els.input.removeAttribute('aria-activedescendant');
      return;
    }
    const shown = S.projectDirectory.results.length;
    const githubOnly = S.current.view === 'universe' && S.projectSearch.filter === VCS.FILTERS.GITHUB;
    els.subtitle.textContent = S.projectDirectory.query || githubOnly
      ? `${shown} of ${total} projects${githubOnly ? ' · GitHub only' : ''}`
      : `${total} projects · active first`;
    renderProjectDirectoryResults();
  };

  A.projectGalaxyLabel = function projectGalaxyLabel(project) {
    if (typeof project.galaxy === 'string') return project.galaxy;
    if (project.galaxy) return project.galaxy.label || project.galaxy.key || '';
    return '';
  };

  function renderProjectDirectoryResults() {
    const els = S.projectDirectory.els;
    if (!els || !S.projectDirectory.open) return;
    AUR.clear(els.list);
    if (S.projectDirectory.results.length === 0) {
      els.list.appendChild(AUR.el('div', 'project-directory-empty', 'No projects found'));
      els.input.removeAttribute('aria-activedescendant');
      return;
    }

    S.projectDirectory.results.forEach((project, index) => {
      const ships = A.shipsInProject(project.id);
      const active = ships.length > 0;
      const missing = project.exists === false;
      const selected = index === S.projectDirectory.selected;
      const row = AUR.el(
        'button', 'project-directory-row' + (active ? ' active' : '') +
          (missing ? ' missing' : '') + (selected ? ' selected' : '')
      );
      row.type = 'button';
      row.id = 'project-directory-result-' + index;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(selected));
      row.title = missing ? 'Recover this project path' : 'Open ' + (project.name || project.id);

      row.appendChild(AUR.el('span', 'project-directory-dot'));
      const copy = AUR.el('span', 'project-directory-copy');
      copy.appendChild(AUR.el('span', 'project-directory-name', project.name || project.id));
      copy.appendChild(AUR.el('span', 'project-directory-path', project.path || 'No path available'));
      row.appendChild(copy);

      const meta = AUR.el('span', 'project-directory-meta');
      const state = missing ? 'MISSING' : active
        ? `${ships.length} AGENT${ships.length === 1 ? '' : 'S'}`
        : AUR.relTime(project.lastActivity, A.playbackReferenceTs());
      meta.appendChild(AUR.el('span', 'project-directory-state', state));
      meta.appendChild(AUR.el('span', 'project-directory-galaxy', A.projectGalaxyLabel(project)));
      const vcsMarkers = AUR.el('span', 'project-directory-vcs');
      VCS.renderMarkers(vcsMarkers, project);
      meta.appendChild(vcsMarkers);
      row.appendChild(meta);
      row.addEventListener('click', () => activateProjectDirectoryResult(index));
      els.list.appendChild(row);
    });
    els.input.setAttribute(
      'aria-activedescendant', 'project-directory-result-' + S.projectDirectory.selected
    );
    const selectedRow = els.list.querySelector('.project-directory-row.selected');
    if (selectedRow) selectedRow.scrollIntoView({ block: 'nearest' });
  }

  function activateProjectDirectoryResult(index) {
    const project = S.projectDirectory.results[index] || S.projectDirectory.results[0];
    if (!project) return;
    A.closeProjectDirectory(false);
    if (project.exists === false) {
      A.openProjectSettings();
      return;
    }
    A.openSystem(project.id);
  }
})();

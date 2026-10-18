// @ts-check
// app/project/directory.js — the searchable ALL PROJECTS directory dialog.
'use strict';

(function () {
  const AUR = window.AUR;
  const VCS = AUR.ProjectVcsStatus;
  const A = AUR.app;               // created by app/state.js; throw if missing
  if (!A) throw new Error('app/state.js must load before app/project/directory.js');
  const S = A.state, C = A.const;

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
    A.syncProjectMatches();
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
    const projects = VCS.filterProjects(allProjects, { filter: S.projectSearch.filter });
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
    const githubOnly = S.projectSearch.filter === VCS.FILTERS.GITHUB;
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

// @ts-check
// The searchable ALL PROJECTS directory dialog.
'use strict';

(function () {
  const AUR = window.AUR;
  const VCS = AUR.ProjectVcsStatus;
  const A = AUR.app;
  if (!A) throw new Error('app/state.js must load before app/project/directory.js');
  const S = A.state;

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
      A.debounceListbox(S.projectDirectory, updateProjectDirectory);
    });
    A.wireListboxKeys(els.input, S.projectDirectory, {
      escape: () => A.closeProjectDirectory(),
      update: updateProjectDirectory,
      activate: activateProjectDirectoryResult,
      render: renderProjectDirectoryResults,
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
    A.cancelListboxTimer(S.projectDirectory);
    S.projectDirectory.open = false;
    S.projectDirectory.query = '';
    S.projectDirectory.results = [];
    S.projectDirectory.selected = 0;
    els.input.value = '';
    A.renderProjectDirectory();
    A.syncProjectMatches();
    if (restoreFocus) els.button.focus();
  };

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
      return A.byProjectName(a, b);
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
      S.projectDirectory.results = A.rankedFirst(
        matches, AUR.searchProjects(matches, query, Math.max(matches.length, 8))
      );
    } else {
      S.projectDirectory.results = projects;
    }
    A.keepSelection(S.projectDirectory, previous, queryChanged, (project) => project.id);
    A.renderProjectDirectory();
    A.syncProjectMatches(allProjects, query);
  }

  A.refreshProjectDirectoryFromStore = function refreshProjectDirectoryFromStore() {
    if (S.projectDirectory.open) updateProjectDirectory();
    else A.renderProjectDirectory();
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
    A.renderListbox(els.list, els.input, S.projectDirectory, {
      idPrefix: 'project-directory-result-',
      rowClass: (project) => 'project-directory-row' +
        (A.shipsInProject(project.id).length > 0 ? ' active' : '') +
        (project.exists === false ? ' missing' : ''),
      emptyClass: 'project-directory-empty',
      emptyText: 'No projects found',
      fill: fillDirectoryRow,
      activate: activateProjectDirectoryResult,
    });
  }

  function fillDirectoryRow(row, project) {
    const ships = A.shipsInProject(project.id);
    const missing = project.exists === false;
    row.title = missing ? 'Recover this project path' : 'Open ' + A.projectLabel(project);

    const copy = AUR.el('span', 'project-directory-copy');
    copy.append(
      AUR.el('span', 'project-directory-name', A.projectLabel(project)),
      AUR.el('span', 'project-directory-path', project.path || 'No path available')
    );
    const meta = AUR.el('span', 'project-directory-meta');
    const state = missing ? 'MISSING' : ships.length > 0
      ? `${ships.length} AGENT${ships.length === 1 ? '' : 'S'}`
      : AUR.relTime(project.lastActivity, A.playbackReferenceTs());
    const vcsMarkers = AUR.el('span', 'project-directory-vcs');
    VCS.renderMarkers(vcsMarkers, project);
    meta.append(
      AUR.el('span', 'project-directory-state', state),
      AUR.el('span', 'project-directory-galaxy', A.projectGalaxyLabel(project)),
      vcsMarkers
    );
    row.append(AUR.el('span', 'project-directory-dot'), copy, meta);
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

// @ts-check
// Presentation-only Git/GitHub project status.
//
// The component intentionally does not inspect repositories or call GitHub.
// The Electron main process owns those concerns and passes a sanitized snapshot
// into this renderer-only module.
'use strict';

(function exposeProjectVcsStatus(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    const AUR = (root.AUR = root.AUR || {});
    AUR.ProjectVcsStatus = api;
  }
})(typeof window !== 'undefined' ? window : null, function createProjectVcsStatusApi() {
  const FILTERS = Object.freeze({
    ALL: 'all',
    GITHUB: 'github',
    LOCAL: 'local',
  });

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICON_PATHS = Object.freeze({
    github: 'M8 0C3.58 0 0 3.64 0 8.13c0 3.59 2.29 6.64 5.47 7.71.4.08.55-.17.55-.39 0-.19-.01-.7-.01-1.38-2.23.49-2.7-1.09-2.7-1.09-.36-.94-.89-1.19-.89-1.19-.73-.5.06-.49.06-.49.8.06 1.23.84 1.23.84.72 1.25 1.88.89 2.34.68.07-.53.28-.89.51-1.09-1.78-.21-3.65-.91-3.65-4.02 0-.89.31-1.61.82-2.18-.08-.21-.36-1.04.08-2.15 0 0 .67-.22 2.2.83A7.54 7.54 0 0 1 8 4.74c.68 0 1.36.09 2 .27 1.53-1.05 2.2-.83 2.2-.83.44 1.11.16 1.94.08 2.15.51.57.82 1.29.82 2.18 0 3.12-1.88 3.81-3.67 4.01.29.25.54.75.54 1.51 0 1.09-.01 1.97-.01 2.24 0 .22.15.47.55.39A8.14 8.14 0 0 0 16 8.13C16 3.64 12.42 0 8 0Z',
    branch: 'M5 3a2 2 0 1 0-1 1.73v5.54A2 2 0 1 0 6 12V9h4a3 3 0 0 0 3-3V4.73A2 2 0 1 0 11 3v3a1 1 0 0 1-1 1H6V4.73A2 2 0 0 0 5 3Z',
    pullRequest: 'M5 3a2 2 0 1 0-1 1.73v6.54A2 2 0 1 0 6 13V4.73A2 2 0 0 0 5 3Zm6.5-.5L9 5h2v4.17A3 3 0 0 0 9 12v1.27A2 2 0 1 0 11 15v-3a1 1 0 0 1 1-1h1V5h2l-2.5-2.5a.71.71 0 0 0-1 0Z',
  });

  function text(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function nonNegativeInteger(value) {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }

  function githubIdentity(url) {
    const value = text(url).replace(/\.git$/i, '');
    if (!value) return null;
    const match = value.match(/(?:https?:\/\/|ssh:\/\/git@|git@)?github\.com[/:]([^/]+)\/([^/#]+)$/i);
    if (!match) return null;
    return Object.freeze({ owner: match[1], repository: match[2], nameWithOwner: `${match[1]}/${match[2]}` });
  }

  function normalize(input) {
    const source = input && typeof input === 'object' ? input : {};
    const vcs = source.vcs && typeof source.vcs === 'object' ? source.vcs : {};
    const git = source.git && typeof source.git === 'object' ? source.git
      : vcs.git && typeof vcs.git === 'object' ? vcs.git : {};
    const github = source.github && typeof source.github === 'object' ? source.github
      : vcs.github && typeof vcs.github === 'object' ? vcs.github : {};
    const remote = githubIdentity(github.url || github.remoteUrl || '');
    const explicitName = text(github.nameWithOwner);
    const nameWithOwner = explicitName || (remote && remote.nameWithOwner) || null;
    const hasGitHub = Boolean(nameWithOwner);
    const changedFiles = nonNegativeInteger(git.changedFiles);
    const dirty = git.dirty === true || (changedFiles != null && changedFiles > 0);
    const detached = git.detached === true;
    const branch = text(git.branch) || null;
    const openPullRequests = nonNegativeInteger(github.openPullRequests);
    const githubState = !hasGitHub ? 'absent'
      : text(github.state) || (openPullRequests == null ? 'unknown' : 'ready');

    return Object.freeze({
      projectId: text(source.projectId || source.id),
      projectName: text(source.projectName || source.name) || 'Unnamed project',
      projectPath: text(source.projectPath || source.path),
      branch,
      branchLabel: detached ? 'Detached HEAD' : branch || 'Branch unavailable',
      detached,
      dirty,
      changedFiles,
      hasGitHub,
      githubUrl: hasGitHub ? text(github.url || github.remoteUrl) || `https://github.com/${nameWithOwner}` : null,
      nameWithOwner,
      openPullRequests,
      githubState,
    });
  }

  function matchesFilter(input, filter) {
    const status = normalize(input);
    if (filter === FILTERS.GITHUB) return status.hasGitHub;
    if (filter === FILTERS.LOCAL) return !status.hasGitHub;
    return true;
  }

  function matchesSearch(input, query) {
    const status = normalize(input);
    const needle = text(query).toLowerCase();
    if (!needle) return true;
    return [
      status.projectName,
      status.projectPath,
      status.branchLabel,
      status.nameWithOwner || '',
    ].join('\n').toLowerCase().includes(needle);
  }

  function filterProjects(projects, options) {
    const list = Array.isArray(projects) ? projects : [];
    const settings = options && typeof options === 'object' ? options : {};
    const filter = text(settings.filter) || FILTERS.ALL;
    return list.filter((project) => matchesFilter(project, filter) && matchesSearch(project, settings.query));
  }

  function requireDocument(options) {
    const doc = options && options.document
      ? options.document
      : typeof document !== 'undefined' ? document : null;
    if (!doc) throw new Error('ProjectVcsStatus rendering requires a document');
    return doc;
  }

  function icon(doc, name) {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    const path = doc.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', ICON_PATHS[name]);
    svg.appendChild(path);
    return svg;
  }

  function element(doc, tag, className, content) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (content != null) node.textContent = content;
    return node;
  }

  function createMarker(doc, className, label, child) {
    const marker = element(doc, 'span', `project-vcs-marker ${className}`);
    marker.setAttribute('role', 'img');
    marker.setAttribute('aria-label', label);
    marker.title = label;
    marker.appendChild(child);
    return marker;
  }

  function createMarkers(input, options) {
    const doc = requireDocument(options);
    const status = normalize(input);
    const markers = element(doc, 'span', 'project-vcs-markers');
    markers.dataset.projectId = status.projectId;

    if (status.hasGitHub) {
      markers.appendChild(createMarker(
        doc,
        'project-vcs-marker-github',
        `GitHub repository: ${status.nameWithOwner}`,
        icon(doc, 'github')
      ));
    }

    if (status.dirty) {
      const count = status.changedFiles == null ? '' : `${status.changedFiles} `;
      markers.appendChild(createMarker(
        doc,
        'project-vcs-marker-dirty',
        `${count}uncommitted change${status.changedFiles === 1 ? '' : 's'}`,
        element(doc, 'span', 'project-vcs-dirty-symbol', '!')
      ));
    }

    if (!markers.childNodes.length) markers.classList.add('project-vcs-markers-empty');
    return markers;
  }

  function detailRow(doc, iconName, label, value, tone) {
    const row = element(doc, 'div', `project-vcs-detail-row${tone ? ` ${tone}` : ''}`);
    const symbol = element(doc, 'span', 'project-vcs-detail-icon');
    symbol.appendChild(icon(doc, iconName));
    row.appendChild(symbol);
    const copy = element(doc, 'span', 'project-vcs-detail-copy');
    copy.appendChild(element(doc, 'span', 'project-vcs-detail-label', label));
    const valueNode = element(doc, 'span', 'project-vcs-detail-value', value);
    valueNode.title = value;
    copy.appendChild(valueNode);
    row.appendChild(copy);
    return row;
  }

  function pullRequestLabel(status) {
    if (!status.hasGitHub) return 'No GitHub remote';
    if (status.githubState === 'loading') return 'Checking GitHub…';
    if (status.githubState === 'error') return 'GitHub unavailable';
    if (status.openPullRequests == null) return 'Not fetched';
    return `${status.openPullRequests} open${status.githubState === 'stale' ? ' · stale' : ''}`;
  }

  function createDetails(input, options) {
    const doc = requireDocument(options);
    const status = normalize(input);
    const details = element(doc, 'section', 'project-vcs-details');
    details.dataset.projectId = status.projectId;
    details.setAttribute('aria-label', `Repository status for ${status.projectName}`);

    const head = element(doc, 'header', 'project-vcs-details-head');
    head.appendChild(element(doc, 'span', 'project-vcs-details-title', 'REPOSITORY STATUS'));
    const connection = element(
      doc,
      'span',
      `project-vcs-connection ${status.hasGitHub ? 'is-connected' : 'is-local'}`,
      status.hasGitHub ? 'GITHUB' : 'LOCAL ONLY'
    );
    head.appendChild(connection);
    details.appendChild(head);

    if (status.hasGitHub) {
      const repository = element(doc, 'a', 'project-vcs-repository-link');
      repository.href = status.githubUrl;
      repository.target = '_blank';
      repository.rel = 'noreferrer';
      repository.appendChild(icon(doc, 'github'));
      repository.appendChild(element(doc, 'span', '', status.nameWithOwner));
      if (options && typeof options.onOpenRepository === 'function') {
        repository.addEventListener('click', (event) => {
          event.preventDefault();
          options.onOpenRepository(status.githubUrl);
        });
      }
      details.appendChild(repository);
    }

    const rows = element(doc, 'div', 'project-vcs-detail-rows');
    rows.appendChild(detailRow(doc, 'branch', 'BRANCH', status.branchLabel, status.detached ? 'is-warning' : ''));
    const changes = status.dirty
      ? status.changedFiles == null ? 'Uncommitted changes' : `${status.changedFiles} uncommitted`
      : 'Clean';
    rows.appendChild(detailRow(doc, 'branch', 'WORKTREE', changes, status.dirty ? 'is-dirty' : 'is-clean'));
    const pulls = pullRequestLabel(status);
    const pullTone = status.openPullRequests > 0 ? 'has-pulls' : '';
    rows.appendChild(detailRow(doc, 'pullRequest', 'PULL REQUESTS', pulls, pullTone));
    details.appendChild(rows);
    return details;
  }

  function replace(container, node) {
    if (!container || typeof container.replaceChildren !== 'function') {
      throw new Error('ProjectVcsStatus requires a DOM container');
    }
    container.replaceChildren(node);
    return node;
  }

  return Object.freeze({
    FILTERS,
    normalize,
    githubIdentity,
    matchesFilter,
    matchesSearch,
    filterProjects,
    pullRequestLabel,
    createMarkers,
    createDetails,
    renderMarkers(container, input, options) {
      return replace(container, createMarkers(input, options));
    },
    renderDetails(container, input, options) {
      return replace(container, createDetails(input, options));
    },
  });
});

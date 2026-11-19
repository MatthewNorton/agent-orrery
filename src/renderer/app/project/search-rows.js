// @ts-check
// A Go to palette row: the live dot, the name with its match's characters marked, the full path, what
// the row adds (repository and branch, or the agent's status) and its kind. Where the path has to
// give way, its tail stays: the folders that tell it from a namesake in the same results.
'use strict';

(function () {
  const AUR = window.AUR;
  const VCS = AUR.ProjectVcsStatus;
  const A = AUR.app;
  if (!A) throw new Error('app/state.js must load before app/project/search-rows.js');
  const S = A.state;
  const KIND = { project: 'Project', agent: 'Agent', planet: 'Folder' };
  const TAIL_MIN = 2;

  const rowName = (entry) => String(entry.kind === 'agent' ? entry.ship.name
    : entry.kind === 'planet' ? entry.planet : A.projectLabel(entry.project));

  function rowPath(entry) {
    if (entry.kind === 'agent') {
      const project = S.store.projects.get(entry.ship.project);
      return String(project && project.path || '');
    }
    const base = String(entry.project.path || '');
    // '(root)' stands for the project's top-level files, so its path is the project's own.
    if (entry.kind !== 'planet' || !base || entry.planet === '(root)') return base;
    // A drive or filesystem root ends in its separator already.
    return base + (/[\\/]$/.test(base) ? '' : base.includes('\\') ? '\\' : '/') + entry.planet;
  }

  const folders = (path) => path.split(/[\\/]/).filter(Boolean);
  const lastOf = (parts, count) => parts.slice(-count).join('/');

  /** `items` grouped by `keyOf`, in the order their keys first appear. */
  function grouped(items, keyOf) {
    const groups = new Map();
    for (const item of items) {
      const key = keyOf(item);
      groups.set(key, [...(groups.get(key) || []), item]);
    }
    return [...groups.values()];
  }

  /** How many of its last folders each path keeps: TAIL_MIN, or as many as part it from the others. */
  function tailsApart(paths) {
    const parts = paths.map(folders);
    return parts.map((own, i) => {
      let count = Math.min(TAIL_MIN, own.length);
      while (count < own.length && parts.some((other, j) => j !== i && lastOf(other, count) === lastOf(own, count))) count++;
      return count;
    });
  }

  /** Each row's tail, in folders, by its key: what parts it from the rows of the same name. */
  function tailCounts(entries) {
    const counts = new Map();
    for (const group of grouped(entries, (entry) => entry.kind + '\n' + rowName(entry))) {
      const apart = tailsApart(group.map(rowPath));
      group.forEach((entry, i) => counts.set(entry.key, apart[i]));
    }
    return counts;
  }

  /** Where the last `count` folders of `path` start: the separator before them, or 0 for all of it. */
  function tailStart(path, count) {
    let at = path.replace(/[\\/]+$/, '').length; // a root's own separator ends no folder
    for (let n = 0; n < count && at > 0; n++) {
      at = Math.max(path.lastIndexOf('\\', at - 1), path.lastIndexOf('/', at - 1));
    }
    return Math.max(at, 0);
  }

  /** `text` in a span, with the characters at `positions` in <mark>. */
  function marked(cls, text, positions) {
    const span = AUR.el('span', cls);
    const at = new Set(positions);
    let run = '', inMark = false;
    const flush = () => {
      if (run) span.append(inMark ? AUR.el('mark', '', run) : run);
      run = '';
    };
    for (let i = 0; i < text.length; i++) {
      if (at.has(i) !== inMark) { flush(); inMark = !inMark; }
      run += text[i];
    }
    flush();
    return span;
  }

  // Repository and branch, and the galaxy where the path does not already name it (the graveyard).
  function projectMore(project, path) {
    const vcs = VCS.normalize(project);
    const galaxy = String(A.projectGalaxyLabel(project) || '');
    const named = folders(path.toLowerCase()).includes(galaxy.toLowerCase());
    return [vcs.nameWithOwner, vcs.branch, !named && galaxy].filter(Boolean).join(' · ');
  }

  /**
   * Each project's line in a plain list (the IDEAS picker), by id: its galaxy, repository, branch
   * and path. Projects that share a name lead with the end of the path that tells them apart, in
   * place of the whole path: a list cuts a long line short at its end, where the path was.
   */
  A.projectSubtitles = function projectSubtitles(projects) {
    const lines = new Map();
    for (const group of grouped(projects, (project) => String(A.projectLabel(project)))) {
      const paths = group.map((project) => String(project.path || ''));
      const apart = group.length > 1 ? tailsApart(paths) : [];
      group.forEach((project, i) => {
        const vcs = VCS.normalize(project);
        const rest = [A.projectGalaxyLabel(project), vcs.nameWithOwner, vcs.branch];
        const cut = tailStart(paths[i], apart[i] || 0);
        const detail = group.length > 1 && paths[i]
          ? [(cut > 0 ? '…' : '') + paths[i].slice(cut), ...rest] : [...rest, paths[i]];
        lines.set(project.id, detail.filter(Boolean).map(String).join(' · '));
      });
    }
    return lines;
  };

  /** A fill for A.renderListbox over the palette's `entries`, with the characters their match found marked. */
  A.searchRowFiller = function searchRowFiller(entries) {
    const tails = tailCounts(entries);
    return function fillSearchRow(row, entry) {
      // Focus stays in the field; the field's arrows move the selection.
      row.tabIndex = -1;
      const live = entry.kind === 'project' && A.shipsInProject(entry.project.id).length > 0;
      const dot = AUR.el('span', 'search-result-dot' + (live ? ' live' : ''));
      if (entry.kind === 'agent') dot.style.background = AUR.providerMeta(entry.ship.provider).color;
      const name = rowName(entry);
      const path = rowPath(entry);
      const line = AUR.el('span', 'search-result-path');
      if (path) {
        const cut = tailStart(path, tails.get(entry.key));
        if (cut > 0) line.append(AUR.el('span', 'search-path-head', path.slice(0, cut)));
        line.append(AUR.el('span', 'search-path-tail', path.slice(cut)));
        row.title = path;
      }
      const more = entry.kind === 'agent' ? String(entry.ship.status || '')
        : entry.kind === 'project' ? projectMore(entry.project, path) : '';
      if (more) line.append(AUR.el('span', 'search-path-more', (path ? ' · ' : '') + more));
      const copy = AUR.el('span', 'search-result-copy');
      copy.append(marked('search-result-name', name, entry.positions), line);
      row.append(dot, copy, AUR.el('span', 'search-result-kind', KIND[entry.kind]));
    };
  };
})();

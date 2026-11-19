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
    return base + (base.includes('\\') ? '\\' : '/') + entry.planet;
  }

  const folders = (path) => path.split(/[\\/]/).filter(Boolean);
  const lastOf = (parts, count) => parts.slice(-count).join('/');

  /** Each row's tail, in folders: TAIL_MIN, or as many as part it from the rows of the same name. */
  function tailCounts(entries) {
    const groups = new Map();
    for (const entry of entries) {
      const key = entry.kind + '\n' + rowName(entry);
      groups.set(key, [...(groups.get(key) || []), entry]);
    }
    const counts = new Map();
    for (const group of groups.values()) {
      const parts = group.map((entry) => folders(rowPath(entry)));
      group.forEach((entry, i) => {
        const own = parts[i];
        let count = Math.min(TAIL_MIN, own.length);
        while (count < own.length && parts.some((other, j) => j !== i && lastOf(other, count) === lastOf(own, count))) count++;
        counts.set(entry.key, count);
      });
    }
    return counts;
  }

  /** Where the last `count` folders of `path` start: the separator before them, or 0 for all of it. */
  function tailStart(path, count) {
    let at = path.length;
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

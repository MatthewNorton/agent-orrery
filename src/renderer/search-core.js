// @ts-check
'use strict';

function searchProjects(projects, query, limit = 8) {
  if (!Array.isArray(projects) || typeof query !== 'string') return [];
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const matches = [];
  for (const project of projects) {
    if (!project || typeof project !== 'object') continue;
    const name = typeof project.name === 'string' ? project.name : '';
    const projectPath = typeof project.path === 'string' ? project.path : '';
    const foldedName = name.toLowerCase();
    const nameIndex = foldedName.indexOf(needle);
    let rank = -1;
    if (nameIndex === 0) rank = 0;
    else if (nameIndex > 0) rank = 1;
    else if (projectPath.toLowerCase().includes(needle)) rank = 2;
    if (rank >= 0) matches.push({ project, rank, name: foldedName });
  }

  matches.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name) ||
    String(a.project.id || '').localeCompare(String(b.project.id || '')) ||
    String(a.project.path || '').localeCompare(String(b.project.path || '')));
  const resultLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : 8;
  return matches.slice(0, resultLimit).map((match) => match.project);
}

if (typeof window !== 'undefined') {
  window.AUR = window.AUR || {};
  window.AUR.searchProjects = searchProjects;
}
if (typeof module !== 'undefined') module.exports = { searchProjects };

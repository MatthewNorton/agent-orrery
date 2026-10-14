// @ts-check
'use strict';

// Go to: pure ranking over projects, agents and planets (top-level folders). Prefix matches rank
// first, then substring matches, then (for projects) a path match; ties break alphabetically.

/**
 * @param {string} value
 * @param {string} needle
 * @returns {number} 0 prefix, 1 substring, -1 none
 */
function rankOf(value, needle) {
  const index = value.toLowerCase().indexOf(needle);
  return index === 0 ? 0 : index > 0 ? 1 : -1;
}

function needleOf(query) {
  return typeof query === 'string' ? query.trim().toLowerCase() : '';
}

function limitOf(limit, fallback) {
  return Number.isSafeInteger(limit) && limit > 0 ? limit : fallback;
}

function searchProjects(projects, query, limit = 8) {
  const needle = needleOf(query);
  if (!Array.isArray(projects) || !needle) return [];

  const matches = [];
  for (const project of projects) {
    if (!project || typeof project !== 'object') continue;
    const name = typeof project.name === 'string' ? project.name : '';
    const projectPath = typeof project.path === 'string' ? project.path : '';
    let rank = rankOf(name, needle);
    if (rank < 0 && projectPath.toLowerCase().includes(needle)) rank = 2;
    if (rank >= 0) matches.push({ project, rank, name: name.toLowerCase() });
  }

  matches.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name) ||
    String(a.project.id || '').localeCompare(String(b.project.id || '')) ||
    String(a.project.path || '').localeCompare(String(b.project.path || '')));
  return matches.slice(0, limitOf(limit, 8)).map((match) => match.project);
}

/** Agents by name, then by status; the ones that need you first within a rank. */
function searchAgents(ships, query, limit = 6) {
  const needle = needleOf(query);
  if (!Array.isArray(ships) || !needle) return [];
  const matches = [];
  for (const ship of ships) {
    if (!ship || typeof ship !== 'object') continue;
    const name = typeof ship.name === 'string' ? ship.name : '';
    let rank = rankOf(name, needle);
    if (rank < 0 && typeof ship.status === 'string' && ship.status.toLowerCase().includes(needle)) rank = 2;
    if (rank >= 0) matches.push({ ship, rank, attention: ship.attention ? 0 : 1, name: name.toLowerCase() });
  }
  matches.sort((a, b) => a.rank - b.rank || a.attention - b.attention || a.name.localeCompare(b.name) ||
    String(a.ship.id || '').localeCompare(String(b.ship.id || '')));
  return matches.slice(0, limitOf(limit, 6)).map((match) => match.ship);
}

/** Planets (top-level folders with builds) across every project that lists them. */
function searchPlanets(projects, query, limit = 6) {
  const needle = needleOf(query);
  if (!Array.isArray(projects) || !needle) return [];
  const matches = [];
  for (const project of projects) {
    if (!project || !Array.isArray(project.planets)) continue;
    for (const planet of project.planets) {
      if (typeof planet !== 'string') continue;
      const rank = rankOf(planet, needle);
      if (rank >= 0) matches.push({ project, planet, rank, name: planet.toLowerCase() });
    }
  }
  matches.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name) ||
    String(a.project.name || '').localeCompare(String(b.project.name || '')) ||
    String(a.project.id || '').localeCompare(String(b.project.id || '')));
  return matches.slice(0, limitOf(limit, 6)).map((match) => ({ project: match.project, planet: match.planet }));
}

if (typeof window !== 'undefined') {
  window.AUR = window.AUR || {};
  window.AUR.searchProjects = searchProjects;
  window.AUR.searchAgents = searchAgents;
  window.AUR.searchPlanets = searchPlanets;
}
if (typeof module !== 'undefined') module.exports = { searchProjects, searchAgents, searchPlanets };

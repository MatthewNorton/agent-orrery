// @ts-check
'use strict';

// Go to: pure ranking over projects, agents and planets (top-level folders). Prefix matches rank
// first, then substring matches, then (for projects) a path match, then fuzzy matches: the query's
// characters in order, scored by how closely they sit and whether they start words. Ties break
// alphabetically.

const PREFIX = 0, SUBSTRING = 1, FALLBACK = 2, FUZZY = 3;
// A fuzzy match scores a point a character, more where it starts a word or follows the last match,
// less for each character it skips. Shorter queries would match nearly every name, and a match
// under FLOOR points a character is letters strewn across a long name.
const WORD_START = 2, STRING_START = 1, RUN = 3, GAP = 0.1, LEAD = 0.05;
const FUZZY_MIN = 3, FLOOR = 1.75;
const BOUNDARY = /[\s\-_./\\:]/;

function needleOf(query) {
  return typeof query === 'string' ? query.trim().toLowerCase() : '';
}

function limitOf(limit, fallback) {
  return Number.isSafeInteger(limit) && limit > 0 ? limit : fallback;
}

/** @param {string} value @param {number} i */
function bonusAt(value, i) {
  if (i === 0) return WORD_START + STRING_START;
  const prev = value[i - 1], here = value[i];
  if (BOUNDARY.test(prev)) return WORD_START;
  if (prev === prev.toLowerCase() && here !== here.toLowerCase()) return WORD_START;
  return 0;
}

/**
 * The best placing of `needle`'s characters, in order, within `value`: the score and the indices.
 * @param {string} value @param {string} needle lower case
 * @returns {{ score: number, positions: number[] } | null}
 */
function fuzzy(value, needle) {
  const hay = value.toLowerCase();
  const n = hay.length, m = needle.length;
  if (m < FUZZY_MIN || m > n) return null;
  // best[j][i]: the best score with needle[j] at hay[i]; from[j][i]: where needle[j - 1] sat.
  const best = [], from = [];
  for (let j = 0; j < m; j++) {
    const row = new Array(n).fill(-Infinity), back = new Array(n).fill(-1);
    const prev = best[j - 1];
    // carry: the best prev[k] less GAP for each character skipped between k and i, over k < i - 1
    let carry = -Infinity, carryAt = -1;
    for (let i = 0; i < n; i++) {
      if (j > 0 && i >= 2) {
        carry -= GAP;
        if (prev[i - 2] - GAP > carry) { carry = prev[i - 2] - GAP; carryAt = i - 2; }
      }
      if (hay[i] !== needle[j]) continue;
      const gain = 1 + bonusAt(value, i);
      if (j === 0) { row[i] = gain - LEAD * i; continue; }
      const run = i > 0 ? prev[i - 1] + RUN : -Infinity;
      const [score, at] = run >= carry ? [run, i - 1] : [carry, carryAt];
      if (score === -Infinity) continue;
      row[i] = score + gain;
      back[i] = at;
    }
    best.push(row);
    from.push(back);
  }
  let end = -1;
  for (let i = 0; i < n; i++) if (best[m - 1][i] > -Infinity && (end < 0 || best[m - 1][i] > best[m - 1][end])) end = i;
  if (end < 0 || best[m - 1][end] < FLOOR * m) return null;
  const positions = [];
  for (let j = m - 1, i = end; j >= 0; i = from[j][i], j--) positions.unshift(i);
  return { score: best[m - 1][end], positions };
}

/**
 * How `value` matches `query`: rank 0 prefix, 1 substring, 3 fuzzy, with the matched indices
 * (a fuzzy match also has a score, higher is closer); null when it does not.
 * @param {unknown} value @param {unknown} query
 * @returns {{ rank: number, score: number, positions: number[] } | null}
 */
function matchText(value, query) {
  const needle = needleOf(query);
  const text = typeof value === 'string' ? value : '';
  if (!needle || !text) return null;
  const index = text.toLowerCase().indexOf(needle);
  if (index >= 0) {
    const positions = Array.from({ length: needle.length }, (_, k) => index + k);
    return { rank: index === 0 ? PREFIX : SUBSTRING, score: 0, positions };
  }
  const hit = fuzzy(text, needle);
  return hit && { rank: FUZZY, score: hit.score, positions: hit.positions };
}

/**
 * `name`'s match, unless that is only fuzzy and one of `others` holds the needle whole: then a
 * FALLBACK match, which marks nothing in the name.
 * @param {string} name @param {unknown[]} others @param {string} needle lower case
 */
function hitOf(name, others, needle) {
  const hit = matchText(name, needle);
  if (hit && hit.rank !== FUZZY) return hit;
  const whole = others.some((other) => typeof other === 'string' && other.toLowerCase().includes(needle));
  return whole ? { rank: FALLBACK, score: 0, positions: [] } : hit;
}

/** Rank, then (fuzzy) score, then `name`, then the given tie-breaks. */
function byRank(a, b) {
  return a.rank - b.rank || b.score - a.score || a.name.localeCompare(b.name);
}

function searchProjects(projects, query, limit = 8) {
  const needle = needleOf(query);
  if (!Array.isArray(projects) || !needle) return [];

  const matches = [];
  for (const project of projects) {
    if (!project || typeof project !== 'object') continue;
    const name = typeof project.name === 'string' ? project.name : '';
    const hit = hitOf(name, [project.path], needle);
    if (hit) matches.push({ project, rank: hit.rank, score: hit.score, name: name.toLowerCase() });
  }

  matches.sort((a, b) => byRank(a, b) ||
    String(a.project.id || '').localeCompare(String(b.project.id || '')) ||
    String(a.project.path || '').localeCompare(String(b.project.path || '')));
  return matches.slice(0, limitOf(limit, 8)).map((match) => match.project);
}

/**
 * Agents by name, then by status, as `{ ship, fuzzy }` (found only by a fuzzy match); the ones that
 * need you first within a rank.
 */
function searchAgents(ships, query, limit = 6) {
  const needle = needleOf(query);
  if (!Array.isArray(ships) || !needle) return [];
  const matches = [];
  for (const ship of ships) {
    if (!ship || typeof ship !== 'object') continue;
    const name = typeof ship.name === 'string' ? ship.name : '';
    const hit = hitOf(name, [ship.status], needle);
    if (hit) matches.push({ ship, rank: hit.rank, score: hit.score, attention: ship.attention ? 0 : 1, name: name.toLowerCase() });
  }
  matches.sort((a, b) => a.rank - b.rank || a.attention - b.attention || byRank(a, b) ||
    String(a.ship.id || '').localeCompare(String(b.ship.id || '')));
  return matches.slice(0, limitOf(limit, 6)).map((match) => ({ ship: match.ship, fuzzy: match.rank === FUZZY }));
}

/** Planets (top-level folders with builds) across every project that lists them, as `{ project, planet, fuzzy }`. */
function searchPlanets(projects, query, limit = 6) {
  const needle = needleOf(query);
  if (!Array.isArray(projects) || !needle) return [];
  const matches = [];
  for (const project of projects) {
    if (!project || !Array.isArray(project.planets)) continue;
    for (const planet of project.planets) {
      if (typeof planet !== 'string') continue;
      const hit = matchText(planet, needle);
      if (hit) matches.push({ project, planet, rank: hit.rank, score: hit.score, name: planet.toLowerCase() });
    }
  }
  matches.sort((a, b) => byRank(a, b) ||
    String(a.project.name || '').localeCompare(String(b.project.name || '')) ||
    String(a.project.id || '').localeCompare(String(b.project.id || '')));
  return matches.slice(0, limitOf(limit, 6))
    .map((match) => ({ project: match.project, planet: match.planet, fuzzy: match.rank === FUZZY }));
}

if (typeof window !== 'undefined') {
  window.AUR = window.AUR || {};
  window.AUR.searchProjects = searchProjects;
  window.AUR.searchAgents = searchAgents;
  window.AUR.searchPlanets = searchPlanets;
  window.AUR.matchText = matchText;
}
if (typeof module !== 'undefined') module.exports = { searchProjects, searchAgents, searchPlanets, matchText, FUZZY };

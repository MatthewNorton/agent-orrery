// @ts-check
'use strict';

// Go to: pure ranking over projects, agents and planets (top-level folders). Prefix matches rank
// first, then substring matches, then a match in other text (a project's path, and in Go to and
// PROJECTS its branch and repository; an agent's status), then fuzzy matches: the query's characters in
// order, scored by how closely they sit and whether they start words. Ties break alphabetically.
// A classic script and a Node module: nothing leaks past the IIFE but AUR and module.exports.

(function () {
  const PREFIX = 0, SUBSTRING = 1, FALLBACK = 2, FUZZY = 3;
  // A fuzzy match scores a point a character, more where it starts a word or follows the last match,
  // less for each character it skips, and FIRST more where the query's first character starts a
  // word, the way an abbreviation does. Shorter queries would match nearly every name, and a match
  // under FLOOR points a character is letters strewn across a long name. Where the match starts
  // does not count toward the floor: LEAD only ranks an earlier match above a later one.
  const WORD_START = 2, FIRST = 1, RUN = 3, GAP = 0.1, LEAD = 0.05;
  const FUZZY_MIN = 3, FLOOR = 1.75;
  const BOUNDARY = /[\s\-_./\\:]/;

  // Lower case that keeps each character's length, so an index in it is the same index in the
  // original. 'İ' lowers to 'i' and a combining dot; keeping only the 'i' keeps every index after it
  // and lets 'izmir' find 'İzmir'. Σ lowers to ς at a word's end and σ elsewhere, so every ς folds
  // to σ: 'ΟΔΥΣ' typed in capitals then finds 'Οδυσσέας'.
  /** @param {string} text */
  function lowerOf(text) {
    const low = text.toLowerCase();
    const kept = low.length === text.length ? low : Array.from(text, (ch) => {
      const one = ch.toLowerCase();
      return one.length === ch.length ? one : one.length > ch.length ? one.slice(0, ch.length) : ch;
    }).join('');
    return kept.replace(/ς/g, 'σ');
  }

  function needleOf(query) {
    return typeof query === 'string' ? lowerOf(query.trim()) : '';
  }

  function limitOf(limit, fallback) {
    return Number.isSafeInteger(limit) && limit > 0 ? limit : fallback;
  }

  /** WORD_START where `value[i]` starts a word: the string, after a separator, or a capital after a small letter. @param {string} value @param {number} i */
  function bonusAt(value, i) {
    if (i === 0) return WORD_START;
    const prev = value[i - 1], here = value[i];
    if (BOUNDARY.test(prev)) return WORD_START;
    if (prev === prev.toLowerCase() && here !== here.toLowerCase()) return WORD_START;
    return 0;
  }

  /**
   * The placing of `needle`'s characters, in order, within `value` that hangs together best: its
   * indices, and its score less LEAD for each character before it.
   * @param {string} value @param {string} needle lower case
   * @returns {{ score: number, positions: number[] } | null}
   */
  function fuzzy(value, needle) {
    const hay = lowerOf(value);
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
        const bonus = bonusAt(value, i);
        const gain = 1 + bonus;
        if (j === 0) { row[i] = gain + (bonus ? FIRST : 0); continue; }
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
    return { score: best[m - 1][end] - LEAD * positions[0], positions };
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
    return wholeHit(text, needle) || fuzzyHit(text, needle);
  }

  /** `needle` whole in `text`: a prefix or substring match. @param {string} text @param {string} needle lower case */
  function wholeHit(text, needle) {
    const index = lowerOf(text).indexOf(needle);
    if (index < 0) return null;
    const positions = Array.from({ length: needle.length }, (_, k) => index + k);
    return { rank: index === 0 ? PREFIX : SUBSTRING, score: 0, positions };
  }

  /** @param {string} text @param {string} needle lower case */
  function fuzzyHit(text, needle) {
    const hit = fuzzy(text, needle);
    return hit && { rank: FUZZY, score: hit.score, positions: hit.positions };
  }

  /**
   * `name` holding the needle whole; else a FALLBACK match where a text `othersOf` gives does (its
   * positions mark nothing); else, unless `withFuzzy` is false, `name`'s fuzzy match. `othersOf`
   * runs only when the name falls short.
   * @param {string} name @param {() => unknown[]} othersOf @param {string} needle lower case
   * @param {boolean} [withFuzzy]
   */
  function hitOf(name, othersOf, needle, withFuzzy = true) {
    const whole = wholeHit(name, needle);
    if (whole) return whole;
    if (othersOf().some((other) => typeof other === 'string' && lowerOf(other).includes(needle))) {
      return { rank: FALLBACK, score: 0, positions: [] };
    }
    return withFuzzy ? fuzzyHit(name, needle) : null;
  }

  /** Rank, then (fuzzy) score, then `name`, then the given tie-breaks. */
  function byRank(a, b) {
    return a.rank - b.rank || b.score - a.score || a.name.localeCompare(b.name);
  }

  // The palette's hits carry `fuzzy` (only a fuzzy match found it) and `positions` (the name's
  // characters to mark: none where something other than the name found it).
  const hitMarks = (match) => ({ fuzzy: match.rank === FUZZY, positions: match.positions });

  /**
   * @typedef {object} RankHow
   * @property {(project: any) => unknown} [nameOf] the name ranked and marked: the one the row shows
   * @property {(project: any) => unknown[]} [othersOf] the other texts, held whole: path by default
   * @property {boolean} [fuzzy] false for whole matches only
   */

  /**
   * Every matching project, as `{ project, fuzzy, positions }`: by name, then by any other text
   * `othersOf` gives (held whole), then, unless `fuzzy` is false, by a fuzzy match on the name.
   * @param {unknown} projects @param {unknown} query @param {RankHow} [how]
   */
  function rankProjects(projects, query, how = {}) {
    const { nameOf = (project) => project.name, othersOf = (project) => [project.path], fuzzy: withFuzzy = true } = how;
    const needle = needleOf(query);
    if (!Array.isArray(projects) || !needle) return [];
    const matches = [];
    for (const project of projects) {
      if (!project || typeof project !== 'object') continue;
      const name = String(nameOf(project) ?? '');
      const hit = hitOf(name, () => othersOf(project), needle, withFuzzy);
      if (hit) matches.push({ project, ...hit, name: name.toLowerCase() });
    }
    matches.sort((a, b) => byRank(a, b) ||
      String(a.project.id || '').localeCompare(String(b.project.id || '')) ||
      String(a.project.path || '').localeCompare(String(b.project.path || '')));
    return matches.map((match) => ({ project: match.project, ...hitMarks(match) }));
  }

  // The first projects by name and path. The app ranks with rankProjects; this stays for the
  // project-search kit's gate (kit/done/project-search/grade-search.mjs) and the tests.
  function searchProjects(projects, query, limit = 8) {
    return rankProjects(projects, query).slice(0, limitOf(limit, 8)).map((hit) => hit.project);
  }

  /** Agents by name, then by status, as `{ ship, fuzzy, positions }`; the ones that need you first within a rank. */
  function searchAgents(ships, query, limit = 6) {
    const needle = needleOf(query);
    if (!Array.isArray(ships) || !needle) return [];
    const matches = [];
    for (const ship of ships) {
      if (!ship || typeof ship !== 'object') continue;
      const name = typeof ship.name === 'string' ? ship.name : '';
      const hit = hitOf(name, () => [ship.status], needle);
      if (hit) matches.push({ ship, ...hit, attention: ship.attention ? 0 : 1, name: name.toLowerCase() });
    }
    matches.sort((a, b) => a.rank - b.rank || a.attention - b.attention || byRank(a, b) ||
      String(a.ship.id || '').localeCompare(String(b.ship.id || '')));
    return matches.slice(0, limitOf(limit, 6)).map((match) => ({ ship: match.ship, ...hitMarks(match) }));
  }

  /** Planets (top-level folders with builds) across every project that lists them, as `{ project, planet, fuzzy, positions }`. */
  function searchPlanets(projects, query, limit = 6) {
    const needle = needleOf(query);
    if (!Array.isArray(projects) || !needle) return [];
    const matches = [];
    for (const project of projects) {
      if (!project || !Array.isArray(project.planets)) continue;
      for (const planet of project.planets) {
        if (typeof planet !== 'string') continue;
        const hit = matchText(planet, needle);
        if (hit) matches.push({ project, planet, ...hit, name: planet.toLowerCase() });
      }
    }
    matches.sort((a, b) => byRank(a, b) ||
      String(a.project.name || '').localeCompare(String(b.project.name || '')) ||
      String(a.project.id || '').localeCompare(String(b.project.id || '')));
    return matches.slice(0, limitOf(limit, 6)).map((match) => ({ project: match.project, planet: match.planet, ...hitMarks(match) }));
  }

  if (typeof window !== 'undefined') {
    window.AUR = window.AUR || {};
    window.AUR.rankProjects = rankProjects;
    window.AUR.searchAgents = searchAgents;
    window.AUR.searchPlanets = searchPlanets;
  }
  if (typeof module !== 'undefined') module.exports = { searchProjects, rankProjects, searchAgents, searchPlanets, matchText, lowerOf, FUZZY };
})();

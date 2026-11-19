'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { searchProjects, rankProjects, searchAgents, searchPlanets, matchText, FUZZY } = require('../src/renderer/search-core');

const projects = [
  { id: 'a', name: 'orion-api', path: 'C:\\work\\orion-api', planets: ['src', 'docs', 'migrations'] },
  { id: 'b', name: 'nebula-dashboard', path: 'C:\\apps\\nebula-dashboard', planets: ['src', 'test'] },
  { id: 'c', name: 'vega-charts', path: 'C:\\oss\\vega-charts' },
];
const ships = [
  { id: 's1', name: 'Claude-4', status: 'Building', attention: 'question' },
  { id: 's2', name: 'Claude-1', status: 'Building', attention: null },
  { id: 's3', name: 'Codex-1', status: 'Exploring', attention: null },
];

test('projects: prefix before substring before path, alphabetical within a rank', () => {
  assert.deepEqual(searchProjects(projects, 'or').map((p) => p.id), ['a']);
  assert.deepEqual(searchProjects(projects, 'a').map((p) => p.id), ['b', 'a', 'c']);
  assert.deepEqual(searchProjects(projects, 'oss').map((p) => p.id), ['c']);
  assert.deepEqual(searchProjects(projects, '  '), []);
});

const agentIds = (hits) => hits.map((hit) => hit.ship.id);

test('agents: by name, then status; the one that needs you first', () => {
  assert.deepEqual(agentIds(searchAgents(ships, 'cl')), ['s1', 's2']);
  assert.deepEqual(agentIds(searchAgents(ships, 'build')), ['s1', 's2']);
  assert.deepEqual(agentIds(searchAgents(ships, 'explor')), ['s3']);
  assert.deepEqual(searchAgents(ships, 'zzz'), []);
  assert.deepEqual(agentIds(searchAgents(ships, 'c', 1)), ['s1']);
});

test('agent and planet hits say when only a fuzzy match found them, and which name characters to mark', () => {
  assert.deepEqual(searchAgents(ships, 'cd1').map((hit) => hit.fuzzy), [true, true]);
  assert.deepEqual(searchAgents(ships, 'build').map((hit) => [hit.fuzzy, hit.positions]), [[false, []], [false, []]],
    'a status match is not fuzzy and marks nothing in the name');
  assert.deepEqual(searchAgents(ships, 'cla').map((hit) => [hit.fuzzy, hit.positions]), [[false, [0, 1, 2]], [false, [0, 1, 2]]]);
  assert.deepEqual(searchPlanets(projects, 'mgr').map((hit) => [hit.fuzzy, hit.positions]), [[true, [0, 2, 3]]]);
  assert.deepEqual(searchPlanets(projects, 'mig').map((hit) => hit.fuzzy), [false]);
});

test('rankProjects: other text (the palette passes repository and branch) ranks with the path, before fuzzy', () => {
  const pool = [
    { id: 'p', name: 'wonky-orbit-kit', path: 'C:\\work\\wonky', branch: 'main' },
    { id: 'q', name: 'zeta', path: 'C:\\apps\\zeta', branch: 'feat/orbit' },
    { id: 'r', name: 'o-r-b-i-t-x', path: 'C:\\apps\\x', branch: 'feat/orbit' },
    { id: 's', name: 'orbital', path: 'C:\\apps\\orbital', branch: 'main' },
    { id: 't', name: 'other-rabbit', path: 'C:\\apps\\t', branch: 'main' },
  ];
  const hits = rankProjects(pool, 'orbit', (project) => [project.path, project.branch]);
  assert.deepEqual(hits.map((hit) => [hit.project.id, hit.fuzzy, hit.positions.length]), [
    ['s', false, 5], ['p', false, 5], ['r', false, 0], ['q', false, 0], ['t', true, 5],
  ], 'prefix, substring, then the branch matches by name (the fuzzy name of r marks nothing), then fuzzy');
  assert.deepEqual(rankProjects(pool, 'work').map((hit) => [hit.project.id, hit.positions]), [['p', []]],
    'found by its path, so nothing in the name is marked');
  assert.deepEqual(searchProjects(pool, 'orbit').map((project) => project.id), ['s', 'p', 'r', 't'],
    'searchProjects keeps the path as its only other text');
});

test('queries are plain text: regex characters and huge strings neither match wrongly nor throw', () => {
  for (const q of ['(', '[', '.*', '(?:', 'a'.repeat(10_000)]) {
    assert.deepEqual(searchProjects(projects, q), []);
    assert.deepEqual(searchAgents(ships, q), []);
    assert.deepEqual(searchPlanets(projects, q), []);
  }
  assert.equal(searchProjects(projects, '\\').length, 3, 'a backslash is a path character, not a regex escape');
});

test('fuzzy: the query in order ranks below prefix, substring and path matches, closest first', () => {
  const more = [...projects, { id: 'd', name: 'nocab', path: 'C:\\x\\nocab' }, { id: 'e', name: 'node-config-builder', path: 'C:\\y\\ncb' }];
  // 'ncb': the words of node-config-builder start n, c and b, so it beats the closer letters of nocab
  assert.deepEqual(searchProjects(more, 'ncb').map((p) => p.id), ['e', 'd']);
  // a path match outranks a fuzzy name match
  assert.deepEqual(searchProjects([...more, { id: 'f', name: 'misc', path: 'C:\\nadb\\misc' }], 'nadb').map((p) => p.id),
    ['f', 'b']);
  assert.deepEqual(searchProjects(more, 'ora').map((p) => p.id), ['a'], 'or-a: orion-api, not the path fallback');
  assert.deepEqual(searchProjects(more, 'zq'), [], 'two characters do not match fuzzily');
  assert.equal(matchText('there-is-a-folder-called-something-quite-long', 'orion'), null, 'letters strewn across a long name');
  assert.deepEqual(agentIds(searchAgents(ships, 'cd1')), ['s3', 's2'], 'Codex-1 holds c, d and 1 closer');
  assert.deepEqual(searchPlanets(projects, 'mgr').map((h) => h.planet), ['migrations']);
});

test('matchText: rank and the matched characters for marking', () => {
  assert.deepEqual(matchText('orion-api', 'ORI'), { rank: 0, score: 0, positions: [0, 1, 2] });
  assert.deepEqual(matchText('orion-api', 'api'), { rank: 1, score: 0, positions: [6, 7, 8] });
  assert.deepEqual(matchText('orion-api', 'oap').positions, [0, 6, 7]);
  assert.equal(matchText('orion-api', 'oap').rank, FUZZY);
  assert.deepEqual(matchText('cart-rack', 'crk').positions, [0, 5, 8], 'a word start wins over an earlier letter');
  // 'İ' lowers to two code units; the marks must still land on the name's own characters, and a
  // plain 'i' typed on any keyboard must still find it.
  assert.deepEqual(matchText('İstanbul-api', 'api').positions, [9, 10, 11]);
  assert.deepEqual(matchText('İstanbul-api', 'İST'), { rank: 0, score: 0, positions: [0, 1, 2] });
  assert.deepEqual(matchText('İstanbul-api', 'istanbul'), { rank: 0, score: 0, positions: [0, 1, 2, 3, 4, 5, 6, 7] });
  assert.deepEqual(matchText('İstanbul-api-gateway', 'apg').positions, [9, 10, 13]);
  assert.deepEqual(searchProjects([{ id: 'z', name: 'İzmir-tools', path: 'C:\\x' }], 'izmir').map((p) => p.id), ['z']);
  // Σ lowers to ς at a word's end; both fold to σ, whichever way the name is lowered.
  assert.deepEqual(matchText('Οδυσσέας', 'ΟΔΥΣ'), { rank: 0, score: 0, positions: [0, 1, 2, 3] });
  assert.deepEqual(matchText('İ-Οδυσσέας', 'ΟΔΥΣ').positions, [2, 3, 4, 5]);
  assert.deepEqual(matchText('λόγος', 'λόγος').positions, [0, 1, 2, 3, 4]);
  assert.equal(matchText('orion-api', 'xyz'), null);
  assert.equal(matchText('orion-api', ''), null);
  assert.equal(matchText(null, 'or'), null);
});

test('planets: across every project that lists them', () => {
  const hits = searchPlanets(projects, 'src').map((h) => h.project.id + '/' + h.planet);
  assert.deepEqual(hits, ['b/src', 'a/src']);
  assert.deepEqual(searchPlanets(projects, 'mig').map((h) => h.planet), ['migrations']);
  assert.deepEqual(searchPlanets(projects, 'vega'), []);
});

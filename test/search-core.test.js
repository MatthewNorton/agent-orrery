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

test('rankProjects: other text (Go to and PROJECTS pass the branch and repository) ranks with the path, before fuzzy', () => {
  const pool = [
    { id: 'p', name: 'wonky-orbit-kit', path: 'C:\\work\\wonky', branch: 'main' },
    { id: 'q', name: 'zeta', path: 'C:\\apps\\zeta', branch: 'feat/orbit' },
    { id: 'r', name: 'o-r-b-i-t-x', path: 'C:\\apps\\x', branch: 'feat/orbit' },
    { id: 's', name: 'orbital', path: 'C:\\apps\\orbital', branch: 'main' },
    { id: 't', name: 'other-rabbit', path: 'C:\\apps\\t', branch: 'main' },
  ];
  const hits = rankProjects(pool, 'orbit', { othersOf: (project) => [project.path, project.branch] });
  assert.deepEqual(hits.map((hit) => [hit.project.id, hit.fuzzy, hit.positions.length]), [
    ['s', false, 5], ['p', false, 5], ['r', false, 0], ['q', false, 0], ['t', true, 5],
  ], 'prefix, substring, then the branch matches by name (the fuzzy name of r marks nothing), then fuzzy');
  assert.deepEqual(rankProjects(pool, 'work').map((hit) => [hit.project.id, hit.positions]), [['p', []]],
    'found by its path, so nothing in the name is marked');
  assert.deepEqual(searchProjects(pool, 'orbit').map((project) => project.id), ['s', 'p', 'r', 't'],
    'searchProjects keeps the path as its only other text');
});

test('rankProjects: ranks and marks the name its caller shows, so a project without one is found by its id', () => {
  const pool = [
    { id: '-work-orion-api', name: '', path: 'C:\\work\\orion-api' },
    { id: 'z', name: 'orion-tools', path: 'C:\\work\\tools' },
    { id: 'y', name: 'atlas', path: 'C:\\work\\orion\\atlas' },
  ];
  const label = (project) => project.name || project.id;
  const hits = rankProjects(pool, 'orion', { nameOf: label });
  assert.deepEqual(hits.map((hit) => [hit.project.id, hit.positions]), [
    ['z', [0, 1, 2, 3, 4]], ['-work-orion-api', [6, 7, 8, 9, 10]], ['y', []],
  ], 'the id is marked where its row shows it, and it ranks as a name match, not first among the path matches');
  assert.deepEqual(rankProjects(pool, 'orion').map((hit) => [hit.project.id, hit.positions]), [
    ['z', [0, 1, 2, 3, 4]], ['-work-orion-api', []], ['y', []],
  ], 'without nameOf the name is project.name, and the nameless project is a path match');
  assert.deepEqual(rankProjects([{ id: 7, name: null, path: null }], '7', { nameOf: (project) => project.name || project.id })
    .map((hit) => hit.positions), [[0]], 'a name that is not a string is read as text');
});

test('rankProjects: fuzzy false keeps the whole matches only, as PROJECTS lists them', () => {
  const pool = [
    { id: 'a', name: 'node-config-builder', path: 'C:\\y\\tools' },
    { id: 'b', name: 'ncb-site', path: 'C:\\y\\site' },
    { id: 'c', name: 'misc', path: 'C:\\ncb\\misc' },
  ];
  assert.deepEqual(rankProjects(pool, 'ncb').map((hit) => [hit.project.id, hit.fuzzy]), [['b', false], ['c', false], ['a', true]]);
  assert.deepEqual(rankProjects(pool, 'ncb', { fuzzy: false }).map((hit) => [hit.project.id, hit.fuzzy]), [['b', false], ['c', false]]);
  assert.deepEqual(rankProjects(pool, 'nfg', { fuzzy: false }), [], 'a query only a fuzzy match finds lists nothing');
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

test('fuzzy: an abbreviation of a later word matches like one of the first word, and ranks after it', () => {
  for (const [name, query, positions] of [
    ['dashboard', 'dsb', [0, 2, 4]], ['web-dashboard', 'dsb', [4, 6, 8]], ['my-config', 'cfg', [3, 6, 8]],
    ['api-gateway', 'gtw', [4, 6, 8]], ['my-packages', 'pkg', [3, 6, 8]], ['webDashboard', 'dsb', [3, 5, 7]],
  ]) {
    const hit = matchText(name, query);
    assert.ok(hit, `${query} in ${name}`);
    assert.deepEqual([hit.rank, hit.positions], [FUZZY, positions], `${query} in ${name}`);
  }
  const far = 'there-is-a-folder-called-something-quite-long-' + 'x'.repeat(60) + '-dashboard';
  assert.ok(matchText(far, 'dsb'), 'however far along the name the word starts');
  assert.deepEqual(searchProjects([
    { id: 'late', name: 'web-dashboard', path: '' }, { id: 'first', name: 'dashboard', path: '' },
  ], 'dsb').map((p) => p.id), ['first', 'late'], 'the earlier match ranks first');
  assert.equal(matchText('undashboard', 'dsb'), null, 'letters that start no word are still strewn');
  assert.equal(matchText('web-madesobig', 'dsb'), null);
  assert.equal(matchText(far, 'orion'), null);
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

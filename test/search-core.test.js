'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { searchProjects, searchAgents, searchPlanets } = require('../src/renderer/search-core');

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

test('agents: by name, then status; the one that needs you first', () => {
  assert.deepEqual(searchAgents(ships, 'cl').map((s) => s.id), ['s1', 's2']);
  assert.deepEqual(searchAgents(ships, 'build').map((s) => s.id), ['s1', 's2']);
  assert.deepEqual(searchAgents(ships, 'explor').map((s) => s.id), ['s3']);
  assert.deepEqual(searchAgents(ships, 'zzz'), []);
  assert.deepEqual(searchAgents(ships, 'c', 1).map((s) => s.id), ['s1']);
});

test('planets: across every project that lists them', () => {
  const hits = searchPlanets(projects, 'src').map((h) => h.project.id + '/' + h.planet);
  assert.deepEqual(hits, ['b/src', 'a/src']);
  assert.deepEqual(searchPlanets(projects, 'mig').map((h) => h.planet), ['migrations']);
  assert.deepEqual(searchPlanets(projects, 'vega'), []);
});

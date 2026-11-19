'use strict';

// src/renderer/app/project/search-rows.js: a Go to palette row's path and the tail of it that stays.

const test = require('node:test');
const assert = require('node:assert/strict');
const { runRenderer } = require('./support/renderer-source');
const { fakeDocument, fakeElement, textOf, withClass } = require('./support/fake-dom');

function setup() {
  const document = fakeDocument();
  const window = {};
  runRenderer('util.js', { window, document });
  const { AUR } = window;
  AUR.ProjectVcsStatus = require('../src/renderer/components/project-vcs-status');
  AUR.app = {
    state: { store: { projects: new Map(), ships: new Map() } },
    projectLabel: (project) => project.name || project.id,
    projectGalaxyLabel: (project) => (project.galaxy ? project.galaxy.label : ''),
    shipsInProject: () => [],
  };
  runRenderer('app/project/search-rows.js', { window, document });
  return AUR.app;
}

// What the rows built for `entries` show of their paths: [head, tail] each, and the row's title.
function pathsOf(entries) {
  const fill = setup().searchRowFiller(entries);
  return entries.map((entry) => {
    const row = fakeElement('button');
    fill(row, entry);
    return [textOf(withClass(row, 'search-path-head')[0]), textOf(withClass(row, 'search-path-tail')[0]), row.title];
  });
}

const folder = (path, planet) => ({ kind: 'planet', key: path + '>' + planet, project: { id: path, name: 'demo', path }, planet, positions: [] });
const project = (path, name) => ({ kind: 'project', key: path, project: { id: path, name, path }, positions: [] });

test('search rows: a folder\'s path is its project\'s plus its name, in the project\'s own separators', () => {
  assert.deepEqual(pathsOf([
    folder('C:\\work\\demo', 'src'), folder('/home/coder/demo', 'lib'), folder('C:/work/demo', 'docs'),
    folder('/home/coder/demo', '(root)'),
  ]), [
    ['C:\\work', '\\demo\\src', 'C:\\work\\demo\\src'],
    ['/home/coder', '/demo/lib', '/home/coder/demo/lib'],
    ['C:/work', '/demo/docs', 'C:/work/demo/docs'],
    ['/home', '/coder/demo', '/home/coder/demo'],
  ]);
});

test('search rows: a project at a drive or filesystem root adds no second separator', () => {
  assert.deepEqual(pathsOf([folder('D:\\', 'src'), folder('/', 'src'), folder('D:/', 'docs')]), [
    ['', 'D:\\src', 'D:\\src'],
    ['', '/src', '/src'],
    ['', 'D:/docs', 'D:/docs'],
  ]);
  assert.deepEqual(pathsOf([project('D:\\', 'D:'), project('/', 'root'), project('C:\\work\\', 'work')]), [
    ['', 'D:\\', 'D:\\'],
    ['', '/', '/'],
    ['', 'C:\\work\\', 'C:\\work\\'],
  ], 'and its own separator ends no folder: the tail is never empty');
});

test('search rows: namesakes keep as many folders as tell them apart', () => {
  assert.deepEqual(pathsOf([
    project('C:\\work\\client-a\\apps\\web', 'web'), project('C:\\work\\client-b\\apps\\web', 'web'),
    project('C:\\oss\\tools\\cli', 'cli'),
  ]).map(([head, tail]) => [head, tail]), [
    ['C:\\work', '\\client-a\\apps\\web'],
    ['C:\\work', '\\client-b\\apps\\web'],
    ['C:\\oss', '\\tools\\cli'],
  ]);
});

test('project lines: namesakes lead with the end of the path that tells them apart', () => {
  const work = { key: 'work', label: 'Work' };
  const lines = setup().projectSubtitles([
    { id: 'a', name: 'orion-api', path: 'C:\\code\\work\\orion-api', galaxy: work,
      git: { branch: 'main' }, github: { url: 'https://github.com/acme-labs/orion-api.git' } },
    { id: 'b', name: 'orion-api', path: 'C:\\code\\old\\work\\orion-api', galaxy: work },
    { id: 'c', name: 'orion-api', path: 'C:\\orion-api' },
    { id: 'd', name: 'vega-charts', path: '/home/coder/oss/vega-charts', galaxy: { key: 'oss', label: 'Open source' } },
    { id: 'e', name: 'ghost', path: null },
    { id: 'f', name: 'ghost', path: null, galaxy: work },
  ]);
  assert.deepEqual([...lines], [
    ['a', '…\\code\\work\\orion-api · Work · acme-labs/orion-api · main'],
    ['b', '…\\old\\work\\orion-api · Work'],
    ['c', 'C:\\orion-api'],
    ['d', 'Open source · /home/coder/oss/vega-charts'],
    ['e', ''],
    ['f', 'Work'],
  ]);
});

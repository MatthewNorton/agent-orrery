'use strict';

// src/renderer/app/project/search-rows.js: a Go to palette row's path and the tail of it that stays.

const test = require('node:test');
const assert = require('node:assert/strict');
const { runApp } = require('./support/renderer-source');
const { fakeDocument, fakeElement, textOf, withClass } = require('./support/fake-dom');

function setup() {
  return runApp(['app/project/search-rows.js'], {
    state: { store: { projects: new Map(), ships: new Map() }, projectSubtitles: { facts: [], lines: new Map() } },
    projectLabel: (project) => project.name || project.id,
    projectGalaxyLabel: (project) => (project.galaxy ? project.galaxy.label : ''),
    shipsInProject: () => [],
  }, { document: fakeDocument(), aur: { ProjectVcsStatus: require('../src/renderer/components/project-vcs-status') } }).app;
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

test('project lines: worked out once for the same projects, again when a fact in them changes', () => {
  const app = setup();
  const projects = () => [
    { id: 'a', name: 'web', path: '/work/client-a/web', git: { branch: 'main' } },
    { id: 'b', name: 'web', path: '/work/client-b/web' },
  ];
  const first = app.projectSubtitles(projects());
  assert.deepEqual([...first], [['a', '…/client-a/web · main'], ['b', '…/client-b/web']]);
  assert.equal(app.projectSubtitles(projects()), first, 'the same facts in new objects: the same lines, not worked out again');

  const changes = [
    [(list) => { list[0].git.branch = 'next'; }, 'a', '…/client-a/web · next'],
    [(list) => { list[1].path = '/work/client-a/api/web'; }, 'b', '…/api/web'],
    [(list) => { list[1].name = 'api'; }, 'a', 'main · /work/client-a/web'],
    [(list) => { list[0].galaxy = { key: 'w', label: 'Work' }; }, 'a', '…/client-a/web · Work · main'],
    [(list) => { list.push({ id: 'c', name: 'web', path: '/old/client-a/web' }); }, 'a', '/work/client-a/web · main'],
    [(list) => { list.reverse(); }, 'a', '…/client-a/web · main'],
  ];
  for (const [change, id, line] of changes) {
    const list = projects();
    change(list);
    const lines = app.projectSubtitles(list);
    assert.notEqual(lines, first, line);
    assert.equal(lines.get(id), line);
    assert.equal(app.projectSubtitles(list), lines);
    app.projectSubtitles(projects());
  }
});

// The tails as the rule states them, worked out the long way: each path against every other.
function tailsTheLongWay(paths) {
  const parts = paths.map((path) => path.split('/').filter(Boolean));
  const last = (list, count) => list.slice(-count).join('/');
  return parts.map((own, i) => {
    let count = Math.min(2, own.length);
    while (count < own.length && parts.some((other, j) => j !== i && last(other, count) === last(own, count))) count++;
    return '/' + last(own, count);
  });
}

test('project lines: every namesake keeps the folders that part it from all the others', () => {
  const app = setup();
  let seed = 7;
  const pick = (list) => list[(seed = (seed * 1103515245 + 12345) % 2147483648) % list.length];
  for (let round = 0; round < 40; round++) {
    const paths = Array.from({ length: 2 + (round % 9) }, () =>
      '/' + Array.from({ length: 1 + (pick([0, 1, 2, 3, 4])) }, () => pick(['a', 'b', 'ab', 'c'])).join('/'));
    const lines = app.projectSubtitles(paths.map((path, id) => ({ id, name: 'web', path })));
    const tails = paths.map((path, id) => lines.get(id).replace(/^…/, ''));
    assert.deepEqual(tails, tailsTheLongWay(paths).map((tail, i) => (paths[i].endsWith(tail) && tail.length < paths[i].length ? tail : paths[i])), paths.join(' '));
  }
});

test('project lines: many long paths that differ only at their start cost no more than reading them', () => {
  const app = setup();
  const deep = '/x'.repeat(2000);
  const projects = Array.from({ length: 200 }, (_, id) => ({ id, name: 'web', path: '/p' + id + deep }));
  const started = process.hrtime.bigint();
  const lines = app.projectSubtitles(projects);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(lines.get(7), '/p7' + deep, 'only the whole path parts it from the rest');
  assert.ok(ms < 1000, `200 paths of 4,000 characters took ${ms.toFixed(0)} ms`);
});

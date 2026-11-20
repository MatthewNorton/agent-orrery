'use strict';

// src/renderer/app/project/search.js: what the palette wires, and what a pick leaves behind.

const test = require('node:test');
const assert = require('node:assert/strict');
const { runApp } = require('./support/renderer-source');
const { fakeDocument } = require('./support/fake-dom');

// The page holds only the elements named in `ids`.
function setup(ids) {
  const document = fakeDocument(ids);
  const calls = [];
  const state = {
    store: { projects: new Map(), ships: new Map() },
    projectSearch: { els: null, filterEls: null, opener: null, timer: null, query: '', results: [], selected: 0, filter: 'all' },
    projectSettings: { open: false },
  };
  const { app } = runApp(['app/project/search.js'], {
    state, const: { SEARCH_DEBOUNCE_MS: 10 },
    cancelListboxTimer() {},
    syncProjectMatches: () => calls.push('map'),
    refreshProjectDirectoryFromStore: () => calls.push('directory'),
  }, { document, aur: { ProjectVcsStatus: require('../src/renderer/components/project-vcs-status') } });
  return { app, state, filter: document.getElementById('project-vcs-filter'), calls };
}

test('palette wiring: the GitHub filter works on a page without the palette', () => {
  const { app, state, filter, calls } = setup(['project-vcs-filter', 'project-vcs-filter-count']);
  app.wireProjectSearch();
  assert.equal(state.projectSearch.els, null, 'no palette is wired');
  assert.equal(state.projectSearch.filterEls.filter, filter);

  filter.fire('click');
  assert.equal(state.projectSearch.filter, 'github');
  assert.ok(calls.includes('directory'), 'PROJECTS follows the filter');
  assert.equal(filter.getAttribute('aria-pressed'), 'true');
  filter.fire('click');
  assert.equal(state.projectSearch.filter, 'all');
  assert.equal(app.openProjectSearch(), false, 'and Go to has nothing to open');
});

test('palette rows: every entry has a key of its own, whatever its project and folder are called', () => {
  const document = fakeDocument(['search-button', 'search-dialog', 'search-input', 'search-results']);
  const state = {
    store: { projects: new Map(), ships: new Map() },
    projectSearch: { els: null, filterEls: null, opener: null, timer: null, query: '', results: [], selected: 0, filter: 'all' },
  };
  const drawn = [];
  const { app } = runApp(['search-core.js', 'app/project/listbox.js', 'app/project/search.js'], {
    state, const: { SEARCH_DEBOUNCE_MS: 10 },
    titleWithKey() {}, searchRowFiller: () => () => {},
    projectLabel: (project) => project.name,
  }, { document, aur: { ProjectVcsStatus: require('../src/renderer/components/project-vcs-status') } });
  app.renderListbox = (list, input, held, opts) => drawn.push(held.results.map(opts.keyOf));
  // A project id and a ship id that are the same text, and ids and folders that join to the same text.
  for (const [id, planets] of [['a/b', ['c']], ['a', ['b/c']], ['c', ['c']]]) {
    state.store.projects.set(id, { id, name: 'c-' + id, path: '/work/' + id, planets });
  }
  state.store.ships.set('c', { id: 'c', name: 'c', project: 'c' });
  app.wireProjectSearch();
  state.projectSearch.els.input.value = 'c';
  app.refreshProjectSearchFromStore();
  const rows = state.projectSearch.results;
  assert.deepEqual(rows.map((row) => row.kind).sort(), ['agent', 'planet', 'planet', 'planet', 'project', 'project', 'project']);
  assert.equal(new Set(drawn.at(-1)).size, rows.length, drawn.at(-1).join(' | '));
  const folderKey = (id, planet) => rows.find((row) => row.kind === 'planet' && row.project.id === id && row.planet === planet).key;
  assert.notEqual(folderKey('a/b', 'c'), folderKey('a', 'b/c'), 'a/b + c and a + b/c are two rows');

  // The selection stays on its entry through a refresh that puts a row above it.
  state.projectSearch.selected = rows.findIndex((row) => row.key === folderKey('a', 'b/c'));
  state.store.projects.set('first', { id: 'first', name: 'c', path: '/work/first', planets: [] });
  app.refreshProjectSearchFromStore();
  assert.equal(state.projectSearch.results[state.projectSearch.selected].key, folderKey('a', 'b/c'));
});

test('palette wiring: a page with neither wires nothing and does not throw', () => {
  const { app, state } = setup([]);
  app.wireProjectSearch();
  assert.deepEqual([state.projectSearch.els, state.projectSearch.filterEls], [null, null]);
  app.refreshProjectSearchFromStore();
  app.clearProjectSearch();
});

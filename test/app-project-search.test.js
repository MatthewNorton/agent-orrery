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

test('palette wiring: a page with neither wires nothing and does not throw', () => {
  const { app, state } = setup([]);
  app.wireProjectSearch();
  assert.deepEqual([state.projectSearch.els, state.projectSearch.filterEls], [null, null]);
  app.refreshProjectSearchFromStore();
  app.clearProjectSearch();
});

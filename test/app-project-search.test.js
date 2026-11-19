'use strict';

// src/renderer/app/project/search.js: what the palette wires, and what a pick leaves behind.

const test = require('node:test');
const assert = require('node:assert/strict');
const { runRenderer } = require('./support/renderer-source');
const { fakeElement } = require('./support/fake-dom');

// The page holds only the elements named in `ids`.
function setup(ids) {
  const elements = new Map(ids.map((id) => [id, fakeElement('div')]));
  const document = { createElement: fakeElement, getElementById: (id) => elements.get(id) || null, activeElement: null };
  const window = {};
  runRenderer('util.js', { window, document });
  const { AUR } = window;
  AUR.ProjectVcsStatus = require('../src/renderer/components/project-vcs-status');
  const calls = [];
  const state = {
    store: { projects: new Map(), ships: new Map() },
    projectSearch: { els: null, filterEls: null, opener: null, timer: null, query: '', results: [], selected: 0, filter: 'all' },
    projectSettings: { open: false },
  };
  AUR.app = {
    state, const: { SEARCH_DEBOUNCE_MS: 10 },
    cancelListboxTimer() {},
    syncProjectMatches: () => calls.push('map'),
    refreshProjectDirectoryFromStore: () => calls.push('directory'),
  };
  runRenderer('app/project/search.js', { window, document });
  return { app: AUR.app, state, elements, calls };
}

test('palette wiring: the GitHub filter works on a page without the palette', () => {
  const { app, state, elements, calls } = setup(['project-vcs-filter', 'project-vcs-filter-count']);
  app.wireProjectSearch();
  assert.equal(state.projectSearch.els, null, 'no palette is wired');
  assert.equal(state.projectSearch.filterEls.filter, elements.get('project-vcs-filter'));

  elements.get('project-vcs-filter').fire('click');
  assert.equal(state.projectSearch.filter, 'github');
  assert.ok(calls.includes('directory'), 'PROJECTS follows the filter');
  assert.equal(elements.get('project-vcs-filter').getAttribute('aria-pressed'), 'true');
  elements.get('project-vcs-filter').fire('click');
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

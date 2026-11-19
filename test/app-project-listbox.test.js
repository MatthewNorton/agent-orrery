'use strict';

// src/renderer/app/project/listbox.js: the keys and the selection of the Go to palette and the
// PROJECTS directory.

const test = require('node:test');
const assert = require('node:assert/strict');
const { runRenderer } = require('./support/renderer-source');
const { fakeDocument, fakeElement } = require('./support/fake-dom');

function setup(results = ['a', 'b', 'c']) {
  const document = fakeDocument();
  const window = {};
  runRenderer('util.js', { window, document });
  window.AUR.app = { state: {}, const: { SEARCH_DEBOUNCE_MS: 10 } };
  runRenderer('app/project/listbox.js', { window, document });
  const app = window.AUR.app;
  const input = fakeElement('input');
  const state = { timer: null, results, selected: 0 };
  const calls = [];
  app.wireListboxKeys(input, state, {
    escape: () => calls.push('escape'),
    update: () => calls.push('update'),
    activate: (index) => calls.push('activate ' + index),
    select: () => calls.push('select ' + state.selected),
  });
  return { app, input, state, calls };
}

test('listbox keys: arrows move the selection round the list and Enter activates it', (t) => {
  const { input, state, calls } = setup();
  const down = input.fire('keydown', { key: 'ArrowDown' });
  assert.deepEqual([state.selected, down.prevented, down.stopped], [1, 1, 1]);
  input.fire('keydown', { key: 'ArrowUp' });
  input.fire('keydown', { key: 'ArrowUp' });
  assert.equal(state.selected, 2, 'up from the first row is the last');
  input.fire('keydown', { key: 'Enter' });
  input.fire('keydown', { key: 'Escape' });
  assert.deepEqual(calls, ['select 1', 'select 0', 'select 2', 'activate 2', 'escape']);
  assert.equal(input.fire('keydown', { key: 'x' }).prevented, 0, 'text keys are the field\'s');

  // A query still waiting on its debounce runs before the key acts on its results.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  calls.length = 0;
  state.timer = setTimeout(() => calls.push('late'), 10);
  input.fire('keydown', { key: 'ArrowDown' });
  t.mock.timers.tick(10);
  assert.deepEqual([calls, state.timer], [['update', 'select 0'], null]);
});

test('listbox keys: while an input method composes text, its keys are its own', () => {
  const { input, state, calls } = setup();
  for (const composing of [{ isComposing: true }, { keyCode: 229 }]) {
    for (const key of ['Enter', 'Escape', 'ArrowDown', 'ArrowUp']) {
      const sent = input.fire('keydown', { key, ...composing });
      assert.deepEqual([sent.prevented, sent.stopped], [0, 0], key);
    }
  }
  assert.deepEqual([calls, state.selected], [[], 0], 'Enter commits the text and Escape cancels it; neither reaches the list');
  input.fire('keydown', { key: 'Enter', isComposing: false, keyCode: 13 });
  assert.deepEqual(calls, ['activate 0']);
});

test('listbox selection: an arrow key marks the rows as they stand and builds none', () => {
  const { app, input, state } = setup();
  const scrolled = [];
  const list = fakeElement('div');
  const rows = state.results.map((_, index) => {
    const row = fakeElement('button');
    row.id = 'row-' + index;
    row.scrollIntoView = () => scrolled.push(row.id);
    return list.appendChild(row);
  });
  state.selected = 2;
  app.selectListboxRow(list, input, state, 'row-');
  assert.deepEqual(list.children, rows, 'the same elements');
  assert.deepEqual(rows.map((row) => [row.classList.contains('selected'), row.getAttribute('aria-selected')]),
    [[false, 'false'], [false, 'false'], [true, 'true']]);
  assert.deepEqual([input.getAttribute('aria-activedescendant'), scrolled], ['row-2', ['row-2']]);
});

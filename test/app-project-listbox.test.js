'use strict';

// src/renderer/app/project/listbox.js: the keys, the clicks and the selection of the Go to palette
// and the PROJECTS directory.

const test = require('node:test');
const assert = require('node:assert/strict');
const { runApp } = require('./support/renderer-source');
const { fakeDocument, fakeElement } = require('./support/fake-dom');

function setup(results = ['a', 'b', 'c']) {
  const document = fakeDocument();
  const { app } = runApp(['app/project/listbox.js'], { state: {}, const: { SEARCH_DEBOUNCE_MS: 10 } }, { document });
  const input = fakeElement('input');
  const list = fakeElement('div');
  const state = { timer: null, results, selected: 0 };
  const calls = [];
  app.wireListbox(list, input, state, {
    escape: () => calls.push('escape'),
    update: () => calls.push('update'),
    activate: (index) => calls.push('activate ' + index),
    select: () => calls.push('select ' + state.selected),
    keyOf: (entry) => entry,
  });
  return { app, document, input, list, state, calls };
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

// A row of `list` for entry `key`, and an event target inside it.
function rowFor(list, key) {
  const row = fakeElement('button');
  row.dataset.key = key;
  row.parentNode = list;
  return { closest: (selector) => (selector === '[role="option"]' ? row : null) };
}

test('listbox clicks: a click opens the entry its row stands for, wherever a refresh has put it', () => {
  const { document, list, state, calls } = setup();
  const press = (target, x = 100, y = 50) => document.fire('mousedown', { target, clientX: x, clientY: y });
  const release = (target, x = 100, y = 50) => document.fire('click', { target, clientX: x, clientY: y });
  const onC = rowFor(list, 'c'), onB = rowFor(list, 'b');

  press(onC);
  release(onC);
  // A row came in above between the press and the release: the entry is one further down, and
  // the pointer, which stayed put, is over the row that took its place.
  press(onC);
  state.results = ['new', 'a', 'b', 'c'];
  release(onB);
  // A row above went: the release is past the end of the list.
  press(onC);
  state.results = ['b', 'c'];
  release({ closest: () => null });
  assert.deepEqual(calls, ['activate 2', 'activate 3', 'activate 1']);

  calls.length = 0;
  press(onC);
  // The page sends the click of a press that ended on another row to the list that holds both.
  release({ closest: () => null }, 100, 90);
  assert.deepEqual(calls, [], 'a press dragged to another row is a click on neither');
  press(onC);
  release(onC, 103, 52);
  assert.deepEqual(calls, ['activate 1'], 'a pointer that drifts a little has stayed put');
  release(onB);
  assert.deepEqual(calls, ['activate 1', 'activate 0'], 'a click without a press (a key on the row) opens its own row');

  calls.length = 0;
  press(onC);
  state.results = ['a', 'b'];
  release(onC);
  press({ closest: () => null });
  release({ closest: () => null });
  press(rowFor(fakeElement('div'), 'a'));
  release(rowFor(fakeElement('div'), 'a'), 300, 300);
  assert.deepEqual(calls, [], 'an entry that is gone, a click off the rows and a row of another list open nothing');
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

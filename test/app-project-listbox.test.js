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

// The list drawn from `state.results`: entries are { id, label }, and a row shows its entry's label.
function drawn(results) {
  const page = setup(results);
  const list = fakeElement('div');
  const render = (next = page.state.results) => {
    page.state.results = next;
    page.app.renderListbox(list, page.input, page.state, {
      rowClass: 'row', idPrefix: 'row-', emptyClass: 'empty', emptyText: 'None',
      keyOf: (entry) => entry.id, fill: (row, entry) => row.setAttribute('data-label', entry.label),
    });
    return list.children.map((row) => row.getAttribute('data-label'));
  };
  return { ...page, list, render };
}

test('listbox rows: a refresh keeps the row of every entry still listed, whatever came or went above it', () => {
  const [a, b, c, n] = ['a', 'b', 'c', 'n'].map((id) => ({ id, label: id.toUpperCase() }));
  const { list, render, state, input } = drawn([a, b, c]);
  assert.deepEqual(render(), ['A', 'B', 'C']);
  const [rowA, rowB, rowC] = list.children;
  assert.deepEqual(render([n, a, b, c]), ['N', 'A', 'B', 'C']);
  assert.deepEqual(list.children.slice(1), [rowA, rowB, rowC], 'a row came in above: the others are the same elements');
  assert.deepEqual(render([a, c]), ['A', 'C']);
  assert.deepEqual(list.children, [rowA, rowC], 'rows left: the others are the same elements');
  assert.deepEqual(render([c, { ...a, label: 'A2' }]), ['C', 'A2']);
  assert.deepEqual(list.children, [rowC, rowA], 'the order changed and a row reads anew: still the same elements');
  assert.deepEqual(render([]), [null], 'the note of an empty list');
  assert.deepEqual(render([b]), ['B']);

  // A selection past the end of the list (the results shrank under it) scrolls nothing and throws nothing.
  state.selected = 5;
  assert.deepEqual(render([a, b]), ['A', 'B']);
  assert.equal(input.getAttribute('aria-activedescendant'), 'row-5');
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

test('listbox rows: the entry pressed or selected stays the one meant through a refresh, by its key', () => {
  const entries = () => ['a', 'b', 'c', 'd'].map((id) => ({ id, label: id.toUpperCase() }));
  const [a, b, c, d] = entries();
  const { list, render, state, document, app, input } = drawn([a, b, c, d]);
  const keyOf = (entry) => entry.id;
  const calls = [];
  app.wireListbox(list, input, state, { escape() {}, update() {}, select() {}, activate: (index) => calls.push(state.results[index].label), keyOf });
  render();
  const onB = 'b';
  // A press on the row of `key` as the list holds it, `change`, and the click that completes the press.
  const click = (key, change) => {
    const row = list.children.find((held) => held.dataset.key === key);
    const target = { closest: (selector) => (selector === '[role="option"]' ? row : null) };
    document.fire('mousedown', { target, clientX: 10, clientY: 10 });
    change();
    document.fire('click', { target, clientX: 10, clientY: 10 });
    render([a, b, c, d]);
    return calls.splice(0);
  };
  // The row above leaves between the press and the click: the entry pressed is still the one opened.
  assert.deepEqual(click(onB, () => render([b, c, d])), ['B']);
  assert.deepEqual(click(onB, () => render([d, c, b])), ['B'], 'wherever it stands now');
  assert.deepEqual(click(onB, () => render([a, c, d])), [], 'gone: no other row is it');
  assert.deepEqual(click(onB, () => { state.results = entries(); }), ['B'], 'a refresh that builds the entries anew: the one with its key');

  // The selection through a re-query stays on the entry that had it.
  const requery = (selected, next, queryChanged = false) => {
    state.results = [a, b, c, d];
    state.selected = selected;
    const previous = state.results[state.selected];
    state.results = next;
    app.keepSelection(state, previous, queryChanged, keyOf);
    return state.results[state.selected].label;
  };
  assert.deepEqual([requery(1, entries()), requery(2, [d, ...entries().slice(0, 3)]), requery(3, [d, a])], ['B', 'C', 'D']);
  assert.equal(requery(3, entries().slice(0, 2)), 'B', 'gone: the nearest row');
  assert.equal(requery(2, entries(), true), 'A', 'a new query starts at the top');
  const none = { results: [], selected: 3 };
  app.keepSelection(none, undefined, false, keyOf);
  assert.equal(none.selected, 0, 'no rows: nothing was selected, and nothing is');
});

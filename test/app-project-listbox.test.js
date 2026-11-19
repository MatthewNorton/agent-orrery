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

test('listbox rows: entries that share a key each get a row of their own, and a click opens the one pressed', () => {
  const [a1, a2, a3, b, n] = [['a', 'A1'], ['a', 'A2'], ['a', 'A3'], ['b', 'B'], ['n', 'N']].map(([id, label]) => ({ id, label }));
  const { list, render, state, document, app, input } = drawn([a1, a2, b]);
  assert.deepEqual(render(), ['A1', 'A2', 'B']);
  const rows = [...list.children];
  assert.equal(new Set(rows.map((row) => row.dataset.key)).size, 3, 'three keys for three rows');
  // The same list again, as every refresh from the store draws it.
  assert.deepEqual(render(), ['A1', 'A2', 'B']);
  assert.deepEqual(list.children, rows, 'and the same elements');
  assert.deepEqual(render([n, a1, a2, a3, b]), ['N', 'A1', 'A2', 'A3', 'B']);
  assert.deepEqual([list.children[1], list.children[2], list.children[4]], rows);
  assert.deepEqual(render([a2, b]), ['A2', 'B'], 'the first of a key left: the one that stays reads as itself');
  assert.equal(list.children.length, 2);

  // Clicks go by the same keys: the second of two entries with one key opens the second.
  const calls = [];
  app.wireListbox(list, input, state, { escape() {}, update() {}, select() {}, activate: (index) => calls.push(index), keyOf: (entry) => entry.id });
  render([a1, a2, b]);
  for (const row of list.children) {
    const target = { closest: (selector) => (selector === '[role="option"]' ? row : null) };
    document.fire('mousedown', { target, clientX: 10, clientY: 10 });
    document.fire('click', { target, clientX: 10, clientY: 10 });
  }
  assert.deepEqual(calls, [0, 1, 2]);
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

test('listbox rows: of entries that share a key, the one pressed or selected stays the one meant', () => {
  const entries = () => [['a', 'A1'], ['a', 'A2'], ['a', 'A3'], ['b', 'B']].map(([id, label]) => ({ id, label }));
  const [a1, a2, a3, b] = entries();
  const { list, render, state, document, app, input } = drawn([a1, a2, a3, b]);
  const keyOf = (entry) => entry.id;
  const calls = [];
  app.wireListbox(list, input, state, { escape() {}, update() {}, select() {}, activate: (index) => calls.push(state.results[index].label), keyOf });
  render();
  const [, rowA2] = list.children;
  const onA2 = { closest: (selector) => (selector === '[role="option"]' ? rowA2 : null) };
  const click = (target, change) => {
    document.fire('mousedown', { target, clientX: 10, clientY: 10 });
    change();
    document.fire('click', { target, clientX: 10, clientY: 10 });
    render([a1, a2, a3, b]);
    return calls.splice(0);
  };
  // The first of the key leaves between the press and the click: the entry pressed is still the one opened.
  assert.deepEqual(click(onA2, () => render([a2, a3, b])), ['A2']);
  assert.deepEqual(click(onA2, () => render([b, a3, a2])), ['A2'], 'wherever it stands now');
  assert.deepEqual(click(onA2, () => render([a1, a3, b])), [], 'gone: the others with its key are not it');
  // A refresh that builds the entries anew: the one with the key, and none where several have it.
  assert.deepEqual(click(onA2, () => { state.results = entries().slice(1, 2); }), ['A2']);
  assert.deepEqual(click(onA2, () => { state.results = entries(); }), [], 'three with the key, and no telling which');

  // The selection through a re-query goes by row: the second of a key stays the second.
  state.results = [a1, a2, a3, b];
  const requery = (selected, next) => {
    state.selected = selected;
    const previous = app.selectedRowKey(state, keyOf);
    state.results = next;
    app.keepSelection(state, previous, false, keyOf);
    const label = state.results[state.selected].label;
    state.results = [a1, a2, a3, b];
    return label;
  };
  assert.deepEqual([requery(1, entries()), requery(2, entries()), requery(3, [b, ...entries().slice(0, 3)])], ['A2', 'A3', 'B']);
  assert.equal(requery(3, entries().slice(0, 2)), 'A2', 'gone: the nearest row');
  state.selected = 2;
  app.keepSelection(state, app.selectedRowKey(state, keyOf), true, keyOf);
  assert.equal(state.selected, 0, 'a new query starts at the top');
  assert.equal(app.selectedRowKey({ results: [], selected: 0 }, keyOf), null);
});

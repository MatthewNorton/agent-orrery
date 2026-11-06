'use strict';

// shortcuts.js is the table of keyboard shortcuts and the rules for when a key press is one.
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../src/renderer/shortcuts.js');
const L = require('../src/renderer/panel-layout.js');

const LIST = K.groups(L.PANELS);
const INDEX = K.index(LIST);
const FREE = { field: null, onButton: false, singleKeys: true };
/** A keydown with no modifiers unless given. */
const press = (key, mods = {}) => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });
const id = (p, where = FREE, mac = false) => K.route(p, where, INDEX, mac)?.id ?? null;

test('every key the canvas lists does what it says', () => {
  assert.equal(id(press('/')), 'search');
  assert.equal(id(press('k', { ctrlKey: true })), 'search');
  assert.equal(id(press('Backspace')), 'back');
  assert.equal(id(press('n')), 'needs-you');
  assert.equal(id(press(',', { ctrlKey: true })), 'settings');
  assert.equal(id(press('?', { shiftKey: true })), 'shortcuts');
  assert.equal(id(press('Escape')), 'escape');
  assert.equal(id(press(' ')), 'play');
  assert.equal(id(press('l')), 'live');
  assert.equal(id(press('[')), 'rail-left');
  assert.equal(id(press(']')), 'rail-right');
  assert.equal(id(press('\\')), 'rails');
  assert.equal(id(press('E', { shiftKey: true })), 'feed');
  for (const p of L.PANELS.filter((panel) => panel.letter)) {
    assert.equal(K.route(press(p.letter.toLowerCase()), FREE, INDEX, false)?.panel, p.key, p.name);
  }
});

test('no two shortcuts share a key', () => {
  const combos = LIST.flatMap((g) => g.rows).flatMap((r) => r.keys);
  assert.equal(INDEX.size, combos.length);
});

test('a letter with Caps Lock is the letter; Shift makes it another shortcut or none', () => {
  assert.equal(id(press('F')), 'panel-agents');
  assert.equal(id(press('F', { shiftKey: true })), null);
  assert.equal(id(press('e', { shiftKey: true })), 'feed');
});

test('single keys wait while typing and while they are off (or Settings is open)', () => {
  for (const where of [{ ...FREE, field: '' }, { ...FREE, singleKeys: false }]) {
    assert.equal(id(press('f'), where), null);
    assert.equal(id(press('/'), where), null);
    assert.equal(id(press('k', { ctrlKey: true }), where), 'search');
    assert.equal(id(press(',', { ctrlKey: true }), where), 'settings');
  }
});

test('Escape always works, except in a field with text, which it clears first', () => {
  assert.equal(id(press('Escape'), { ...FREE, singleKeys: false }), 'escape');
  assert.equal(id(press('Escape'), { ...FREE, field: '' }), 'escape');
  assert.equal(id(press('Escape'), { ...FREE, field: 'nebula' }), null);
});

test('Space on a button presses the button; Alt, held keys and composing text are never shortcuts', () => {
  assert.equal(id(press(' '), { ...FREE, onButton: true }), null);
  assert.equal(id(press('f'), { ...FREE, onButton: true }), 'panel-agents');
  assert.equal(id(press('f', { altKey: true })), null);
  assert.equal(id(press('k', { ctrlKey: true, altKey: true })), null);
  assert.equal(id(press('f', { repeat: true })), null);
  assert.equal(id(press('f', { isComposing: true })), null);
});

test('on macOS Cmd stands in for Ctrl, and Ctrl alone is not it', () => {
  assert.equal(id(press('k', { metaKey: true }), FREE, true), 'search');
  assert.equal(id(press('k', { ctrlKey: true }), FREE, true), null);
  assert.equal(id(press('k', { metaKey: true }), FREE, false), null);
  assert.deepEqual(K.display(['Mod', 'K'], true), ['⌘', 'K']);
  assert.deepEqual(K.display(['Mod', 'K'], false), ['Ctrl', 'K']);
});

test('only Ctrl shortcuts and Esc keep working with single keys off', () => {
  assert.equal(K.singleKey(['Mod', 'K']), false);
  assert.equal(K.singleKey(['Esc']), false);
  assert.equal(K.singleKey(['/']), true);
  assert.equal(K.singleKey(['Shift', 'E']), true);
});

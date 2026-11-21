'use strict';

// src/renderer/util.js: the page's shared helpers.

const test = require('node:test');
const assert = require('node:assert/strict');
const { runRenderer, settled } = require('./support/renderer-source');
const { fakeDocument, fakeElement } = require('./support/fake-dom');

test('AUR.listen logs what a listener throws or its promise rejects with, and leaves nothing unhandled', async () => {
  const window = {}, logged = [], seen = [];
  runRenderer('util.js', { window, document: fakeDocument() });
  const AUR = window.AUR;
  AUR.log = (...args) => logged.push(args.join(' '));
  const node = fakeElement('button');
  AUR.listen(node, 'click', (event) => { seen.push(event.detail); throw new Error('thrown'); });
  AUR.listen(node, 'click', async () => { throw new Error('rejected'); });
  AUR.listen(node, 'click', async () => 'answered');
  const unhandled = await settled(() => node.fire('click', { detail: 1 }));
  assert.deepEqual([unhandled, logged, seen], [[], [
    'click handler failed: Error: thrown', 'click handler failed: Error: rejected',
  ], [1]]);

  const button = AUR.button('b', 'Go', async () => { throw new Error('from a button'); });
  assert.deepEqual(await settled(() => button.fire('click')), []);
  assert.equal(logged.at(-1), 'click handler failed: Error: from a button');
});

test('AUR.listen names an error, writes any other thrown value as text, and never throws itself', async () => {
  const window = {}, logged = [];
  runRenderer('util.js', { window, document: fakeDocument() });
  window.AUR.log = (...args) => logged.push(args.join(' '));
  const unreadable = new Error('hidden');
  Object.defineProperty(unreadable, 'message', { get() { throw new Error('no message'); } });
  const failures = [
    [() => { throw new TypeError('nothing to read'); }, 'TypeError: nothing to read'],
    [async () => { throw new RangeError('too far'); }, 'RangeError: too far'],
    [() => { throw 'not an Error'; }, 'not an Error'],
    [async () => { throw Symbol('odd'); }, 'Symbol(odd)'],
    [() => { throw null; }, 'null'],
    [() => { throw Object.create(null); }, 'an error with no readable text'],
    [async () => { throw unreadable; }, 'an error with no readable text'],
  ];
  for (const [listener, text] of failures) {
    const node = fakeElement('button');
    window.AUR.listen(node, 'click', listener);
    assert.deepEqual(await settled(() => node.fire('click')), [], text);
    assert.equal(logged.pop(), `click handler failed: ${text}`);
  }
});

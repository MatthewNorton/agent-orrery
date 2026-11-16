'use strict';

// panel-layout.js is the table of the chrome's panels and the layout each run starts from.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const LAYOUT = require('../src/renderer/panel-layout.js');

test('the defaults are the approved launch layout', () => {
  assert.deepEqual(LAYOUT.defaults(), {
    'needs-you': 'open', summary: 'hidden', project: 'open', tasks: 'folded', planet: 'open',
    agents: 'open', galaxies: 'hidden', feed: 'open', ideas: 'folded', timeline: 'open',
  });
});

test('Needs you never hides and the timeline never folds', () => {
  assert.equal(LAYOUT.allowed('needs-you', 'hidden'), false);
  assert.equal(LAYOUT.allowed('needs-you', 'folded'), true);
  assert.equal(LAYOUT.allowed('timeline', 'folded'), false);
  assert.equal(LAYOUT.allowed('timeline', 'hidden'), true);
  assert.equal(LAYOUT.allowed('nowhere', 'open'), false);
  assert.equal(LAYOUT.allowed('summary', 'gone'), false);
});

test('a stored layout keeps what is allowed and takes the rest from the defaults', () => {
  const layout = LAYOUT.normalize({ summary: 'open', 'needs-you': 'hidden', timeline: 'folded', feed: 'nope', extra: 'open' });
  assert.equal(layout.summary, 'open');
  assert.equal(layout['needs-you'], 'open');
  assert.equal(layout.timeline, 'open');
  assert.equal(layout.feed, 'open');
  assert.equal('extra' in layout, false);
  assert.deepEqual(LAYOUT.normalize(null), LAYOUT.defaults());
  assert.deepEqual(LAYOUT.normalize('garbage'), LAYOUT.defaults());
});

test('the folds kept before launch layouts carry over once, rails and unknown keys aside', () => {
  const layout = LAYOUT.fromFolded(['agents', 'summary', 'rail-left', 'timeline', 'nowhere']);
  assert.equal(layout.agents, 'folded');
  assert.equal(layout.summary, 'folded');
  assert.equal(layout.timeline, 'open');
  assert.equal(layout.galaxies, 'hidden');
  assert.deepEqual(LAYOUT.fromFolded(undefined), LAYOUT.defaults());
});

test('every panel names an element in index.html, and every rail module is a panel', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  for (const panel of LAYOUT.PANELS) {
    assert.match(html, new RegExp(`id="${panel.id}"`), panel.id);
    if (panel.rail !== 'bottom') assert.match(html, new RegExp(`id="${panel.id}"[^>]*data-module="${panel.key}"`), panel.key);
  }
  const modules = [...html.matchAll(/<section[^>]*data-module="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(modules.filter((key) => !LAYOUT.panel(key)), []);
});

test('every panel sits on a listed rail, and a state it cannot take says why', () => {
  const sides = LAYOUT.RAILS.map((rail) => rail.side);
  for (const panel of LAYOUT.PANELS) {
    assert.ok(sides.includes(panel.rail), panel.key);
    assert.equal(Boolean(panel.never), Boolean(panel.neverWhy), panel.key);
  }
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  for (const rail of LAYOUT.RAILS) if (rail.module) assert.match(html, new RegExp(`data-module="${rail.module}"`), rail.module);
});

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

test('panelsOn lists the panels on a rail in order, and rail finds a rail by its side', () => {
  assert.deepEqual(LAYOUT.panelsOn('right').map((p) => p.key), ['agents', 'galaxies', 'feed', 'ideas']);
  assert.deepEqual(LAYOUT.panelsOn('bottom').map((p) => p.key), ['timeline']);
  assert.equal(LAYOUT.rail('right').module, 'rail-right');
  assert.equal(LAYOUT.rail('top'), null);
});

test('showsIn says which views show a panel', () => {
  assert.equal(LAYOUT.showsIn(LAYOUT.panel('agents'), 'universe'), true);
  assert.equal(LAYOUT.showsIn(LAYOUT.panel('tasks'), 'universe'), false);
  assert.equal(LAYOUT.showsIn(LAYOUT.panel('tasks'), 'system'), true);
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

test('a rail stops 24 px short of the other rail, and the side that yields gives way', () => {
  const open = { left: 'open', right: 'open' };
  const fit = (want, shown, yields) => LAYOUT.fitRails(1416, want, shown, 56, yields);
  assert.deepEqual(fit({ left: 296, right: 312 }, open, 'left'), { left: 296, right: 312 });
  // Dragging the right rail: it stops beside the left rail as it is.
  assert.deepEqual(fit({ left: 296, right: 2000 }, open, 'right'), { left: 296, right: 1096 });
  // The left rail gives way to a wide right rail, down to its least width.
  assert.deepEqual(fit({ left: 296, right: 2000 }, open, 'left'), { left: 240, right: 1152 });
  // A folded or empty other rail leaves more room.
  assert.deepEqual(fit({ left: 296, right: 2000 }, { left: 'compact', right: 'open' }, 'right'), { left: 296, right: 1336 });
  assert.deepEqual(fit({ left: 296, right: 2000 }, { left: 'none', right: 'open' }, 'right'), { left: 296, right: 1416 });
  // In a window too small for both, each keeps its least width.
  assert.deepEqual(LAYOUT.fitRails(400, { left: 296, right: 312 }, open, 56, 'left'), { left: 240, right: 240 });
});

test('stored sizes keep whole numbers at or above their floor', () => {
  const sizes = LAYOUT.normalizeSizes({
    rails: { left: 300.4, right: 100, rightExpanded: 700, other: 500 },
    panels: { feed: 200, agents: 100, project: 300, nowhere: 500, ideas: '400' },
  });
  assert.deepEqual(sizes, { rails: { left: 300, rightExpanded: 700 }, panels: { feed: 200 } });
  assert.deepEqual(LAYOUT.normalizeSizes(null), { rails: {}, panels: {} });
  assert.equal(LAYOUT.clamp(500, 240, 100), 240);
});

test('the expanded feed takes 46% of the window up to 640 px, or the width kept for it', () => {
  assert.equal(LAYOUT.expandedWidth(1440, 312), 640);
  assert.equal(LAYOUT.expandedWidth(1000, 312), 460);
  // Never narrower than the rail already is, unless the viewer sized it so.
  assert.equal(LAYOUT.expandedWidth(1440, 700), 700);
  assert.equal(LAYOUT.expandedWidth(1440, 700, 500), 500);
});

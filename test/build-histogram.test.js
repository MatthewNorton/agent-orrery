'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BINS, createHistogram, countBuild, snapshotHistogram, dayStart } = require('../src/main/shared/build-histogram');

const at = (h, m) => { const d = new Date(2026, 9, 14, h, m, 0, 0); return d.getTime(); };

test('a build lands in its half-hour bin of the current day', () => {
  const h = createHistogram(at(9, 0));
  assert.equal(h.bins.length, BINS);
  assert.equal(countBuild(h, at(14, 32)), true);
  assert.equal(countBuild(h, at(14, 59)), true);
  assert.equal(countBuild(h, at(0, 0)), true);
  assert.equal(h.bins[29], 2);
  assert.equal(h.bins[0], 1);
  assert.equal(h.bins.reduce((a, b) => a + b, 0), 3);
});

test('a build from an earlier day is ignored and a later day starts over', () => {
  const h = createHistogram(at(9, 0));
  countBuild(h, at(10, 15));
  assert.equal(countBuild(h, at(10, 15) - 24 * 60 * 60 * 1000), false);
  assert.equal(h.bins[20], 1);
  const tomorrow = at(1, 5) + 24 * 60 * 60 * 1000;
  assert.equal(countBuild(h, tomorrow), true);
  assert.equal(h.day, dayStart(tomorrow));
  assert.equal(h.bins.reduce((a, b) => a + b, 0), 1);
  assert.equal(h.bins[2], 1);
});

test('the snapshot copy rolls forward and does not share the bins', () => {
  const h = createHistogram(at(9, 0));
  countBuild(h, at(9, 10));
  const copy = snapshotHistogram(h, at(9, 20));
  copy.bins[18] = 99;
  assert.equal(h.bins[18], 1);
  const later = snapshotHistogram(h, at(9, 20) + 24 * 60 * 60 * 1000);
  assert.equal(later.bins.reduce((a, b) => a + b, 0), 0);
  assert.equal(h.bins.reduce((a, b) => a + b, 0), 0);
});

test('an invalid timestamp is not counted', () => {
  const h = createHistogram(at(9, 0));
  assert.equal(countBuild(h, NaN), false);
  assert.equal(countBuild(h, undefined), false);
});

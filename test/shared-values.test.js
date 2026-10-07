'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { boundedInteger } = require('../src/main/shared/values');

test('boundedInteger keeps safe integers inside the inclusive range', () => {
  assert.equal(boundedInteger(250, 4_000, 250, 30_000), 250);
  assert.equal(boundedInteger(30_000, 4_000, 250, 30_000), 30_000);
  assert.equal(boundedInteger(0, 400, 0, 5_000), 0);
});

test('boundedInteger falls back for anything else', () => {
  for (const value of [249, 30_001, 1.5, '300', null, undefined, Number.NaN, Infinity,
    300n, { valueOf: () => 300 }]) {
    assert.equal(boundedInteger(value, 4_000, 250, 30_000), 4_000, String(value));
  }
  assert.equal(boundedInteger(Number.MAX_SAFE_INTEGER + 1, 7, 0, Infinity), 7);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bareCopy, boundedInteger, ownString, bufferValue, wholeCount } = require('../src/main/shared/values');

test('wholeCount is a whole number from 0 to the largest safe one, and 0 for anything that is no count', () => {
  const MAX = Number.MAX_SAFE_INTEGER;
  assert.deepEqual([0, 1, 7, 2.9, 0.99, MAX, MAX + 2, 1e308, Number.MAX_VALUE].map(wholeCount), [0, 1, 7, 2, 0, MAX, MAX, MAX, MAX]);
  for (const value of ['5', '', null, undefined, NaN, Infinity, -Infinity, -1, -0.5, true, [3], { valueOf: () => 3 }, 3n]) {
    assert.equal(wholeCount(value), 0, String(value));
  }
  assert.equal(wholeCount(wholeCount(MAX) + wholeCount(MAX)), MAX, 'a sum of counts is a count');
});

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

test('ownString trims own string data properties and ignores everything else', () => {
  assert.equal(ownString({ id: '  one  ' }, 'id'), 'one');
  assert.equal(ownString({ id: 7 }, 'id'), '');
  assert.equal(ownString(Object.create({ id: 'inherited' }), 'id'), '');
  assert.equal(ownString(['zero'], '0'), '');
  for (const value of [null, undefined, 'id', 3]) assert.equal(ownString(value, 'id'), '');
  let reads = 0;
  const getter = Object.defineProperty({}, 'id', { enumerable: true, get() { reads++; return 'x'; } });
  assert.equal(ownString(getter, 'id'), '');
  assert.equal(reads, 0);
});

test('bareCopy is a copy with no prototype, where any name is an own key', () => {
  const from = JSON.parse('{ "__proto__": "a", "constructor": "b", "id": "c" }');
  const copy = bareCopy(from);
  assert.deepEqual([Object.getPrototypeOf(copy), Object.keys(copy), copy.__proto__, copy.constructor], [null, ['__proto__', 'constructor', 'id'], 'a', 'b']);
  copy.__proto__ = 'd';
  delete copy.constructor;
  assert.deepEqual([Object.keys(copy), copy.__proto__, from.constructor], [['__proto__', 'id'], 'd', 'b'], 'a write is an own key; the original is untouched');
  assert.deepEqual([Object.keys(bareCopy()), Object.getPrototypeOf(bareCopy())], [[], null]);
});

test('bufferValue turns chunks into buffers without copying existing ones', () => {
  const buffer = Buffer.from('raw');
  assert.equal(bufferValue(buffer), buffer);
  assert.deepEqual(bufferValue('héllo'), Buffer.from('héllo', 'utf8'));
  assert.equal(bufferValue(null).length, 0);
  assert.equal(bufferValue(undefined).length, 0);
  assert.equal(bufferValue(42).toString(), '42');
});

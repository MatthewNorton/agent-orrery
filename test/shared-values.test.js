'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { boundedInteger, ownString, bufferValue } = require('../src/main/shared/values');

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

test('bufferValue turns chunks into buffers without copying existing ones', () => {
  const buffer = Buffer.from('raw');
  assert.equal(bufferValue(buffer), buffer);
  assert.deepEqual(bufferValue('héllo'), Buffer.from('héllo', 'utf8'));
  assert.equal(bufferValue(null).length, 0);
  assert.equal(bufferValue(undefined).length, 0);
  assert.equal(bufferValue(42).toString(), '42');
});

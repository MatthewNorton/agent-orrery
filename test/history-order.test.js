'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  compareIndexEntries, compareRecords, heapPop, heapPush, providerRank,
} = require('../src/main/history/order');

function shuffled(items, seed) {
  const output = items.slice();
  let state = seed;
  for (let index = output.length - 1; index > 0; index--) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const other = state % (index + 1);
    [output[index], output[other]] = [output[other], output[index]];
  }
  return output;
}

const key = (record) => `${record.ts}|${record.provider}|${record.sourceKey}|${record.offset}|${record.ordinal}`;

test('history order: Claude ranks before Codex', () => {
  assert.equal(providerRank('claude'), 0);
  assert.equal(providerRank('codex'), 1);
  assert.equal(providerRank('anything-else'), 1);
});

test('history order: records tie-break on provider, source, byte offset, then ordinal', () => {
  const base = { ts: 10, provider: 'claude', sourceKey: 'b', offset: 5, ordinal: 1 };
  assert.ok(compareRecords({ ...base, ts: 9 }, base) < 0);
  assert.ok(compareRecords({ ...base, provider: 'codex' }, base) > 0);
  assert.ok(compareRecords({ ...base, sourceKey: 'a' }, base) < 0);
  assert.ok(compareRecords({ ...base, offset: 4 }, base) < 0);
  assert.ok(compareRecords({ ...base, ordinal: 0 }, base) < 0);
  assert.equal(compareRecords({ ...base }, base), 0);
});

test('history order: the heap pops records in exactly the sorted merge order', () => {
  const records = [];
  for (const ts of [3, 1, 2]) {
    for (const provider of ['codex', 'claude']) {
      for (const sourceKey of ['s2', 's1']) {
        for (const offset of [40, 0]) {
          for (const ordinal of [1, 0]) records.push({ ts, provider, sourceKey, offset, ordinal });
        }
      }
    }
  }
  const expected = records.slice().sort(compareRecords).map(key);
  for (const seed of [1, 7, 42, 99]) {
    const heap = [];
    for (const record of shuffled(records, seed)) heapPush(heap, record);
    const popped = [];
    while (heap.length) popped.push(key(heapPop(heap)));
    assert.deepEqual(popped, expected, `seed ${seed}`);
  }
});

test('history order: interleaved push and pop always yields the current minimum', () => {
  const heap = [];
  const live = [];
  const records = shuffled(Array.from({ length: 200 }, (_, index) => ({
    ts: index % 17, provider: index % 3 ? 'codex' : 'claude', sourceKey: `s${index % 5}`,
    offset: index * 3, ordinal: index % 2,
  })), 5);
  for (const [index, record] of records.entries()) {
    heapPush(heap, record);
    live.push(record);
    if (index % 3 === 2) {
      live.sort(compareRecords);
      assert.equal(key(heapPop(heap)), key(live.shift()));
    }
  }
  live.sort(compareRecords);
  while (heap.length) assert.equal(key(heapPop(heap)), key(live.shift()));
});

test('history order: index entries sort by start, provider, then source key', () => {
  const entries = [
    { startMs: 2, provider: 'claude', sourceKey: 'a' },
    { startMs: 1, provider: 'codex', sourceKey: 'a' },
    { startMs: 1, provider: 'claude', sourceKey: 'z' },
    { startMs: 1, provider: 'claude', sourceKey: 'b' },
  ];
  assert.deepEqual(entries.sort(compareIndexEntries).map((entry) => `${entry.startMs}:${entry.provider}:${entry.sourceKey}`),
    ['1:claude:b', '1:claude:z', '1:codex:a', '2:claude:a']);
});

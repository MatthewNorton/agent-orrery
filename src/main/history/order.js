// @ts-check
'use strict';

// The deterministic order of history. Sources sort by start time; records by time, then
// provider (Claude first), source, byte offset and position within their line.

/**
 * @import { IndexEntry } from './index-builder'
 * @import { HistoryRecord } from './record-reader'
 */

/** @param {string} provider */
function providerRank(provider) {
  return provider === 'claude' ? 0 : 1;
}

/**
 * @param {IndexEntry} a
 * @param {IndexEntry} b
 */
function compareIndexEntries(a, b) {
  return a.startMs - b.startMs || providerRank(a.provider) - providerRank(b.provider) ||
    a.sourceKey.localeCompare(b.sourceKey);
}

/**
 * @param {HistoryRecord} a
 * @param {HistoryRecord} b
 */
function compareRecords(a, b) {
  return a.ts - b.ts || providerRank(a.provider) - providerRank(b.provider) ||
    a.sourceKey.localeCompare(b.sourceKey) || a.offset - b.offset || a.ordinal - b.ordinal;
}

/**
 * @param {HistoryRecord[]} heap
 * @param {HistoryRecord} record
 */
function heapPush(heap, record) {
  let index = heap.length;
  heap.push(record);
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compareRecords(heap[parent], record) <= 0) break;
    heap[index] = heap[parent];
    index = parent;
  }
  heap[index] = record;
}

/**
 * @param {HistoryRecord[]} heap
 * @returns {HistoryRecord} the earliest record
 */
function heapPop(heap) {
  const first = heap[0];
  const tail = heap.pop();
  if (heap.length === 0) return first;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    if (left >= heap.length) break;
    const right = left + 1;
    const child = right < heap.length && compareRecords(heap[right], heap[left]) < 0
      ? right : left;
    if (compareRecords(heap[child], tail) >= 0) break;
    heap[index] = heap[child];
    index = child;
  }
  heap[index] = tail;
  return first;
}

module.exports = { providerRank, compareIndexEntries, compareRecords, heapPush, heapPop };

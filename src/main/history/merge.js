// @ts-check
'use strict';

const { heapPop, heapPush } = require('./order');
const { closeStreamHandles, readNextRecord } = require('./record-reader');

/**
 * @import { IndexEntry } from './index-builder'
 * @import { HistoryRecord, ReaderContext, SourceCursor } from './record-reader'
 */

/**
 * @typedef {ReaderContext & {
 *   entries: IndexEntry[],
 *   partial: boolean,
 *   cursorFor: (entry: IndexEntry) => SourceCursor,
 *   cursorOf: (sourceKey: string) => SourceCursor | undefined,
 *   apply: (record: HistoryRecord) => void,
 *   onHeapSize: (size: number) => void,
 * }} MergeContext
 */

/**
 * Merge one next record per source and reduce it immediately. The heap is
 * bounded by source count, rather than by every record through the target.
 * @param {MergeContext} ctx
 * @param {number} target
 * @returns {Promise<boolean>} the partial flag: `ctx.partial` or any source read in part
 */
async function mergeThrough(ctx, target) {
  /** @type {HistoryRecord[]} */
  const heap = [];
  const handles = new Map();
  let partial = ctx.partial;
  let visited = 0;
  let processed = 0;
  try {
    for (const entry of ctx.entries) {
      ctx.assertCurrent();
      if (entry.startMs > target) break;
      const cursor = ctx.cursorFor(entry);
      const record = await readNextRecord(ctx, entry, cursor, target, handles);
      partial ||= cursor.partial;
      if (record) {
        heapPush(heap, record);
        ctx.onHeapSize(heap.length);
      }
      visited++;
      if (visited % 128 === 0) {
        await new Promise((resolve) => setImmediate(resolve));
        ctx.assertCurrent();
      }
    }

    while (heap.length) {
      ctx.assertCurrent();
      const record = heapPop(heap);
      ctx.apply(record);
      processed++;
      const cursor = ctx.cursorOf(record.sourceKey);
      const next = await readNextRecord(ctx, record.entry, cursor, target, handles);
      partial ||= cursor.partial;
      if (next) {
        heapPush(heap, next);
        ctx.onHeapSize(heap.length);
      }
      if (processed % 2048 === 0) {
        await new Promise((resolve) => setImmediate(resolve));
        ctx.assertCurrent();
      }
    }
  } finally {
    await closeStreamHandles(handles);
  }
  return partial;
}

module.exports = { mergeThrough };

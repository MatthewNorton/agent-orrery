// @ts-check
'use strict';

// Per-source cursors over each indexed byte range. A cursor hands the merge one record at a
// time, read through a small pool of open handles shared by one advance.

const fs = require('fs');
const { createAdapterState } = require('../provider-adapters');
const { MAX_LINE_BYTES } = require('./jsonl');
const { parseHistoricalLine } = require('./historical-line');

/**
 * @import { FileHandle } from 'fs/promises'
 * @import { IndexEntry } from './index-builder'
 * @import { TimestampGuard } from './jsonl'
 */

const STREAM_READ_CHUNK_BYTES = 16 * 1024;
const MAX_OPEN_STREAM_HANDLES = 64;

/**
 * @typedef {object} SourceCursor
 * @property {number} readOffset file offset of the next read
 * @property {Buffer} buffer bytes read; lines before bufferStart are already consumed
 * @property {number} bufferStart index of the first unread byte in buffer
 * @property {number} bufferOffset file offset of buffer[bufferStart]
 * @property {boolean} discardingOversized skipping the rest of an oversized line
 * @property {Record<string, any> | null} adapterState Codex adapter cursor
 * @property {boolean} claudeSessionEmitted
 * @property {number | null} lastEffectiveTs keeps a source's record times monotonic
 * @property {HistoryRecord[]} pendingRecords parsed, not yet merged
 * @property {number | null} blockedUntil the next record time past the last target
 * @property {boolean} done
 * @property {boolean} partial a line was skipped or the range could not be read
 */

/**
 * @typedef {object} HistoryRecord
 * @property {number} ts
 * @property {string} provider
 * @property {string} sourceKey
 * @property {number} offset byte offset of the line
 * @property {number} ordinal position of the signal within its line
 * @property {IndexEntry} entry
 * @property {Record<string, any>} signal
 */

/** @typedef {Map<string, { handle: FileHandle, cursor: SourceCursor }>} HandlePool */

/**
 * @typedef {object} ReaderContext
 * @property {() => void} assertCurrent throws ERR_REPLAY_CANCELLED once superseded
 * @property {TimestampGuard} safeTimestamp
 * @property {(entry: IndexEntry, cursor: SourceCursor, handles: HandlePool) => Promise<FileHandle>} openStreamHandle
 * @property {number} [chunkBytes] read size; tests shrink it to cross chunk boundaries
 */

/**
 * @param {Map<string, SourceCursor>} cursors
 * @param {IndexEntry} entry
 * @returns {SourceCursor}
 */
function sourceCursor(cursors, entry) {
  let cursor = cursors.get(entry.sourceKey);
  if (cursor) return cursor;
  cursor = {
    readOffset: 0,
    buffer: Buffer.alloc(0),
    bufferStart: 0,
    bufferOffset: 0,
    discardingOversized: false,
    adapterState: entry.provider === 'codex'
      ? createAdapterState('codex', { filename: entry.filePath, sessionId: entry.sessionId })
      : null,
    claudeSessionEmitted: false,
    lastEffectiveTs: null,
    pendingRecords: [],
    blockedUntil: null,
    done: false,
    partial: false,
  };
  cursors.set(entry.sourceKey, cursor);
  return cursor;
}

/**
 * The source's next record at or before `target`, or null when it has none yet.
 * @param {ReaderContext} ctx
 * @param {IndexEntry} entry
 * @param {SourceCursor | undefined} cursor
 * @param {number} target
 * @param {HandlePool} handles
 * @returns {Promise<HistoryRecord | null>}
 */
async function readNextRecord(ctx, entry, cursor, target, handles) {
  if (!cursor || (cursor.done && cursor.pendingRecords.length === 0)) return null;
  let sliceBytes = 0;
  try {
    while (true) {
      ctx.assertCurrent();

      if (cursor.pendingRecords.length) {
        if (cursor.pendingRecords[0].ts > target) {
          return null;
        }
        const record = cursor.pendingRecords.shift();
        return record;
      }

      if (Number.isFinite(cursor.blockedUntil) && cursor.blockedUntil > target) return null;
      cursor.blockedUntil = null;

      if (cursor.discardingOversized) {
        const newline = cursor.buffer.indexOf(0x0a, cursor.bufferStart);
        if (newline >= 0) {
          cursor.bufferOffset += newline + 1 - cursor.bufferStart;
          cursor.bufferStart = newline + 1;
          cursor.discardingOversized = false;
        } else if (cursor.buffer.length > cursor.bufferStart) {
          cursor.bufferOffset += cursor.buffer.length - cursor.bufferStart;
          dropBuffer(cursor);
        }
      }

      const start = cursor.bufferStart;
      const newline = cursor.discardingOversized ? -1 : cursor.buffer.indexOf(0x0a, start);
      if (newline >= 0) {
        let end = newline;
        if (end > start && cursor.buffer[end - 1] === 0x0d) end--;
        const line = cursor.buffer.subarray(start, end);
        const lineOffset = cursor.bufferOffset;
        cursor.bufferStart = newline + 1;
        cursor.bufferOffset += newline + 1 - start;
        if (line.length === 0) continue;
        if (line.length > MAX_LINE_BYTES) {
          cursor.partial = true;
          continue;
        }
        const parsed = parseHistoricalLine(
          entry, line, lineOffset, cursor.adapterState, cursor.claudeSessionEmitted, ctx.safeTimestamp
        );
        if (parsed.adapterState) cursor.adapterState = parsed.adapterState;
        if (parsed.claudeSessionEmitted) cursor.claudeSessionEmitted = true;
        for (let ordinal = 0; ordinal < parsed.signals.length; ordinal++) {
          const parsedSignal = parsed.signals[ordinal];
          const effectiveTs = cursor.lastEffectiveTs === null
            ? parsedSignal.ts : Math.max(cursor.lastEffectiveTs, parsedSignal.ts);
          cursor.lastEffectiveTs = effectiveTs;
          const signal = effectiveTs === parsedSignal.ts
            ? parsedSignal : { ...parsedSignal, ts: effectiveTs };
          cursor.pendingRecords.push({
            ts: signal.ts,
            provider: entry.provider,
            sourceKey: entry.sourceKey,
            offset: lineOffset,
            ordinal,
            entry,
            signal,
          });
        }
        if (parsed.signals.length === 0 && Number.isFinite(parsed.recordTs) &&
            parsed.recordTs > target) {
          cursor.blockedUntil = parsed.recordTs;
          return null;
        }
        continue;
      }

      if (cursor.buffer.length - cursor.bufferStart > MAX_LINE_BYTES) {
        cursor.bufferOffset += cursor.buffer.length - cursor.bufferStart;
        dropBuffer(cursor);
        cursor.discardingOversized = true;
        cursor.partial = true;
      }
      if (cursor.readOffset >= entry.size) {
        // The captured immutable range ended without another complete line.
        dropBuffer(cursor);
        cursor.done = true;
        return null;
      }
      const handle = await ctx.openStreamHandle(entry, cursor, handles);
      ctx.assertCurrent();
      const length = Math.min(ctx.chunkBytes || STREAM_READ_CHUNK_BYTES, entry.size - cursor.readOffset);
      const readAt = cursor.readOffset;
      // Compact only here: the unread tail moves to the front of the next buffer.
      const unread = cursor.buffer.subarray(cursor.bufferStart);
      const next = Buffer.allocUnsafe(unread.length + length);
      unread.copy(next, 0);
      const { bytesRead } = await handle.read(next, unread.length, length, readAt);
      ctx.assertCurrent();
      if (bytesRead <= 0) {
        cursor.partial = true;
        cursor.done = true;
        return null;
      }
      cursor.buffer = next.subarray(0, unread.length + bytesRead);
      cursor.bufferStart = 0;
      cursor.bufferOffset = readAt - unread.length;
      cursor.readOffset = readAt + bytesRead;
      sliceBytes += bytesRead;
      if (sliceBytes >= 8 * 1024 * 1024) {
        sliceBytes = 0;
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  } catch (error) {
    if (error && error.code === 'ERR_REPLAY_CANCELLED') throw error;
    cursor.partial = true;
    cursor.done = true;
    return null;
  }
}

/**
 * Drop a cursor's unread bytes; its next read starts again at the first of them.
 * @param {SourceCursor | undefined} cursor
 */
function releaseCursorBuffer(cursor) {
  if (!cursor) return;
  if (cursor.buffer.length > cursor.bufferStart) cursor.readOffset = cursor.bufferOffset;
  dropBuffer(cursor);
}

/** @param {SourceCursor} cursor */
function dropBuffer(cursor) {
  cursor.buffer = Buffer.alloc(0);
  cursor.bufferStart = 0;
}

/**
 * Reuse the source's open handle or open one, closing the least recently used past the cap.
 * @param {IndexEntry} entry
 * @param {SourceCursor} cursor
 * @param {HandlePool} handles
 */
async function openStreamHandle(entry, cursor, handles) {
  let stream = handles.get(entry.sourceKey);
  if (stream) {
    handles.delete(entry.sourceKey);
    handles.set(entry.sourceKey, stream);
    return stream.handle;
  }
  if (handles.size >= MAX_OPEN_STREAM_HANDLES) {
    const oldestKey = handles.keys().next().value;
    const oldest = handles.get(oldestKey);
    handles.delete(oldestKey);
    releaseCursorBuffer(oldest.cursor);
    try { await oldest.handle.close(); } catch { /* best-effort bounded handle pool */ }
  }
  const handle = await fs.promises.open(entry.filePath, 'r');
  stream = { handle, cursor };
  handles.set(entry.sourceKey, stream);
  return handle;
}

/** @param {HandlePool} handles */
async function closeStreamHandles(handles) {
  const closing = [];
  for (const { handle, cursor } of handles.values()) {
    releaseCursorBuffer(cursor);
    closing.push(handle.close().catch(() => undefined));
  }
  handles.clear();
  await Promise.all(closing);
}

module.exports = { sourceCursor, readNextRecord, openStreamHandle, closeStreamHandles };

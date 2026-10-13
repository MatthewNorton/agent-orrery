// @ts-check
'use strict';

// Transcript line helpers shared by the history index and the record reader.

const MAX_LINE_BYTES = 1024 * 1024;
const MIN_TIMESTAMP_MS = Date.UTC(2000, 0, 1);
const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

/** @typedef {(value: unknown) => number | null} TimestampGuard */

/**
 * The complete lines of a block, without LF or a CR before it. Empty and oversized lines are
 * dropped; `dropFirst` skips the partial line a mid-file block starts with.
 * @param {Buffer} buffer
 * @param {boolean} dropFirst
 * @returns {Buffer[]}
 */
function completeLines(buffer, dropFirst) {
  const output = [];
  let start = 0;
  if (dropFirst) {
    const newline = buffer.indexOf(0x0a);
    if (newline < 0) return output;
    start = newline + 1;
  }
  for (let index = start; index < buffer.length; index++) {
    if (buffer[index] !== 0x0a) continue;
    let end = index;
    if (end > start && buffer[end - 1] === 0x0d) end--;
    if (end > start && end - start <= MAX_LINE_BYTES) output.push(buffer.subarray(start, end));
    start = index + 1;
  }
  return output;
}

/**
 * @param {Buffer | string} line
 * @returns {Record<string, any> | null} the record when the line is a JSON object
 */
function parseJsonLine(line) {
  try {
    const value = JSON.parse(Buffer.isBuffer(line) ? line.toString('utf8') : String(line));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function parseTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A record timestamp, or null when it is before 2000 or more than a day past the index clock.
 * @param {unknown} value
 * @param {number} indexNow
 * @returns {number | null}
 */
function safeTimestamp(value, indexNow) {
  const ts = parseTimestamp(value);
  const upper = indexNow + MAX_CLOCK_SKEW_MS;
  return ts !== null && ts >= MIN_TIMESTAMP_MS && ts <= upper ? ts : null;
}

module.exports = { MAX_LINE_BYTES, completeLines, parseJsonLine, parseTimestamp, safeTimestamp };

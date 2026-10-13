'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_LINE_BYTES, completeLines, parseJsonLine, parseTimestamp, safeTimestamp,
} = require('../src/main/history/jsonl');

const text = (lines) => lines.map((line) => line.toString('utf8'));

test('completeLines: strips LF and CRLF, skips empty lines and the unterminated tail', () => {
  const block = Buffer.from('{"a":1}\r\n\n{"b":2}\n\r\n{"c":3}');
  assert.deepEqual(text(completeLines(block, false)), ['{"a":1}', '{"b":2}']);
});

test('completeLines: dropFirst skips the partial line a mid-file block starts with', () => {
  assert.deepEqual(text(completeLines(Buffer.from('tail of a line\n{"a":1}\n'), true)), ['{"a":1}']);
  assert.deepEqual(completeLines(Buffer.from('no newline at all'), true), []);
});

test('completeLines: lines over MAX_LINE_BYTES are dropped, a line at the cap is kept', () => {
  const atCap = Buffer.alloc(MAX_LINE_BYTES, 0x61);
  const over = Buffer.alloc(MAX_LINE_BYTES + 1, 0x62);
  const block = Buffer.concat([atCap, Buffer.from('\n'), over, Buffer.from('\nok\n')]);
  const lines = completeLines(block, false);
  assert.deepEqual(lines.map((line) => line.length), [MAX_LINE_BYTES, 2]);
});

test('parseJsonLine: only JSON objects count as records', () => {
  assert.deepEqual(parseJsonLine(Buffer.from('{"type":"user"}')), { type: 'user' });
  assert.deepEqual(parseJsonLine('{"n":1}'), { n: 1 });
  for (const value of ['[1,2]', '"text"', '42', 'null', '{broken']) {
    assert.equal(parseJsonLine(Buffer.from(value)), null, value);
  }
});

test('parseTimestamp and safeTimestamp: numbers and ISO strings inside the trusted window', () => {
  const now = Date.UTC(2026, 6, 1);
  const iso = '2026-06-30T12:00:00.000Z';
  assert.equal(parseTimestamp(iso), Date.parse(iso));
  assert.equal(parseTimestamp(1234), 1234);
  assert.equal(parseTimestamp(''), null);
  assert.equal(parseTimestamp(Number.NaN), null);
  assert.equal(parseTimestamp('not a date'), null);

  assert.equal(safeTimestamp(iso, now), Date.parse(iso));
  assert.equal(safeTimestamp(Date.UTC(1999, 11, 31), now), null, 'before 2000');
  assert.equal(safeTimestamp(now + 24 * 60 * 60 * 1000, now), now + 24 * 60 * 60 * 1000, 'one day of skew');
  assert.equal(safeTimestamp(now + 24 * 60 * 60 * 1000 + 1, now), null, 'past the skew window');
});

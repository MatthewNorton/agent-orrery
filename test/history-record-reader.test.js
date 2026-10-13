'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MAX_LINE_BYTES, safeTimestamp } = require('../src/main/history/jsonl');
const { parseHistoricalLine } = require('../src/main/history/historical-line');
const {
  closeStreamHandles, openStreamHandle, readNextRecord, sourceCursor,
} = require('../src/main/history/record-reader');

const T0 = Date.UTC(2026, 6, 21, 12, 0, 0);
const NOW = T0 + 24 * 60 * 60 * 1000;
const guard = (value) => safeTimestamp(value, NOW);

const iso = (ms) => new Date(ms).toISOString();
const prompt = (cwd, ts, content = 'private prompt') =>
  ({ type: 'user', timestamp: iso(ts), cwd, message: { role: 'user', content } });
const tool = (cwd, ts, id, name, input = {}) => ({
  type: 'assistant', timestamp: iso(ts), cwd,
  message: { role: 'assistant', content: [{ type: 'tool_use', ...(id ? { id } : {}), name, input }] },
});
const result = (cwd, ts, id) => ({
  type: 'user', timestamp: iso(ts), cwd,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'private' }] },
});

function writeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'au-history-reader-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'workspace', 'demo');
  const json = (record) => JSON.stringify(record);
  const lines = [
    json(prompt(dir, T0)),
    json(tool(dir, T0 + 1000, 'toolu_a', 'Edit', { file_path: path.join(dir, 'src', 'a.js') })),
    json(tool(dir, T0 + 2000, null, 'Read', {})),
    json(prompt(dir, T0 + 3000, 'x'.repeat(40_000))),
    '',
    '{not json',
    `${json(result(dir, T0 + 4000, 'toolu_a'))}\r`,
    json(prompt(dir, T0 + 3500, 'héllo wörld ✓ '.repeat(3000))),
    json(prompt(dir, T0 + 5000, 'y'.repeat(MAX_LINE_BYTES + 10))),
    json(tool(dir, T0 + 6000, 'toolu_b', 'Write', { file_path: path.join(dir, 'docs', 'b.md') })),
  ];
  const content = `${lines.join('\n')}\n${json(prompt(dir, T0 + 7000))}`;
  const file = path.join(root, 'session.jsonl');
  fs.writeFileSync(file, content);
  const entry = {
    provider: 'claude', sourceKey: `claude:test:session`, filePath: file, sessionId: 'session',
    projectPath: dir, projectName: 'demo', projectIdHint: 'demo', kind: 'main',
    parentSessionId: null, startMs: T0, endMs: T0 + 7000, size: Buffer.byteLength(content), priority: 0,
  };
  return { entry, content: Buffer.from(content) };
}

// The reader's framing, rebuilt naively: split the whole file at LF.
function expectedRecords(entry, content) {
  const output = [];
  let start = 0;
  let adapterState = null;
  let claudeSessionEmitted = false;
  let lastTs = null;
  for (let newline = content.indexOf(0x0a); newline >= 0; newline = content.indexOf(0x0a, start)) {
    let end = newline;
    if (end > start && content[end - 1] === 0x0d) end--;
    const line = content.subarray(start, end);
    const offset = start;
    start = newline + 1;
    if (line.length === 0 || line.length > MAX_LINE_BYTES) continue;
    const parsed = parseHistoricalLine(entry, line, offset, adapterState, claudeSessionEmitted, guard);
    adapterState = parsed.adapterState;
    claudeSessionEmitted = parsed.claudeSessionEmitted;
    parsed.signals.forEach((signal, ordinal) => {
      lastTs = lastTs === null ? signal.ts : Math.max(lastTs, signal.ts);
      output.push({ offset, ordinal, ts: lastTs, type: signal.type, callId: signal.callId });
    });
  }
  return output;
}

const ctx = { assertCurrent() {}, safeTimestamp: guard, openStreamHandle };
const shape = (record) => ({
  offset: record.offset, ordinal: record.ordinal, ts: record.ts,
  type: record.signal.type, callId: record.signal.callId,
});

async function readAll(entry, { releaseEvery = 0, context = ctx } = {}) {
  const cursor = sourceCursor(new Map(), entry);
  let handles = new Map();
  const records = [];
  for (let record; (record = await readNextRecord(context, entry, cursor, Infinity, handles));) {
    records.push(record);
    if (releaseEvery && records.length % releaseEvery === 0) {
      await closeStreamHandles(handles);
      handles = new Map();
    }
  }
  await closeStreamHandles(handles);
  return { records, cursor };
}

test('record reader: offsets and signals match a whole-file split, across chunk boundaries', async (t) => {
  const { entry, content } = writeFixture(t);
  const { records, cursor } = await readAll(entry);
  const expected = expectedRecords(entry, content);
  assert.deepEqual(records.map(shape), expected);
  assert.deepEqual(records.map((record) => record.signal.type), [
    'session', 'turn-start', 'turn-start', 'tool-start', 'build', 'turn-start', 'tool-start',
    'turn-start', 'tool-end', 'turn-start', 'turn-start', 'tool-start', 'build',
  ]);
  const anonymous = records.find((record) => record.signal.type === 'tool-start' && record.signal.tool === 'Read');
  assert.equal(anonymous.signal.callId, `line-${anonymous.offset.toString(16)}`);
  assert.equal(content.subarray(anonymous.offset, anonymous.offset + 1).toString(), '{');
  assert.equal(content[anonymous.offset - 1], 0x0a);
  const late = records.find((record) => record.signal.type === 'tool-end');
  const earlier = records[records.indexOf(late) + 1];
  assert.equal(earlier.ts, T0 + 4000, 'an earlier record time is held at the source high-water mark');
  assert.equal(cursor.partial, true, 'the oversized line marks the source partial');
  assert.equal(cursor.done, true);
  assert.equal(cursor.buffer.length, 0);
});

test('record reader: releasing the buffer between records resumes at the same lines', async (t) => {
  const { entry } = writeFixture(t);
  const straight = (await readAll(entry)).records.map(shape);
  for (const releaseEvery of [1, 2, 5]) {
    assert.deepEqual((await readAll(entry, { releaseEvery })).records.map(shape), straight, `every ${releaseEvery}`);
  }
});

test('record reader: a record past the target waits in the cursor for the next advance', async (t) => {
  const { entry } = writeFixture(t);
  const cursor = sourceCursor(new Map(), entry);
  const handles = new Map();
  const first = [];
  for (let record; (record = await readNextRecord(ctx, entry, cursor, T0 + 1500, handles));) first.push(record);
  await closeStreamHandles(handles);
  assert.deepEqual(first.map((record) => record.signal.type), ['session', 'turn-start', 'turn-start', 'tool-start', 'build']);
  assert.deepEqual(cursor.pendingRecords.map((record) => record.ts), [T0 + 2000, T0 + 2000]);
  assert.equal(cursor.buffer.length, 0, 'unread bytes are released with the handles');
  const rest = [];
  for (let record; (record = await readNextRecord(ctx, entry, cursor, Infinity, handles));) rest.push(record);
  await closeStreamHandles(handles);
  assert.deepEqual([...first, ...rest].map(shape), (await readAll(entry)).records.map(shape));
});

test('record reader: a read failure ends only that source; cancellation propagates', async (t) => {
  const { entry } = writeFixture(t);
  const failing = { ...ctx, openStreamHandle: async () => { throw new Error('EIO'); } };
  const { records, cursor } = await readAll(entry, { context: failing });
  assert.deepEqual(records, []);
  assert.equal(cursor.partial, true);
  assert.equal(cursor.done, true);

  const cancelled = Object.assign(new Error('replay operation cancelled'), { code: 'ERR_REPLAY_CANCELLED' });
  const cancelling = { ...ctx, assertCurrent() { throw cancelled; } };
  const fresh = sourceCursor(new Map(), entry);
  await assert.rejects(readNextRecord(cancelling, entry, fresh, Infinity, new Map()), (error) => error === cancelled);
  assert.equal(fresh.done, false);
});

test('handle pool: past 64 open sources the least recently used is closed and rewound', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'au-history-pool-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const handles = new Map();
  const cursors = [];
  for (let index = 0; index < 65; index++) {
    const filePath = path.join(root, `${index}.jsonl`);
    fs.writeFileSync(filePath, 'x\n');
    const entry = { sourceKey: `source-${index}`, filePath };
    const cursor = { buffer: Buffer.from('unread'), bufferOffset: 10, readOffset: 16 };
    cursors.push(cursor);
    await openStreamHandle(entry, cursor, handles);
    if (index === 1) await openStreamHandle({ sourceKey: 'source-0', filePath }, cursors[0], handles);
  }
  assert.equal(handles.size, 64);
  assert.equal(handles.has('source-0'), true, 'reuse refreshes a source');
  assert.equal(handles.has('source-1'), false, 'the least recently used source was evicted');
  assert.deepEqual({ readOffset: cursors[1].readOffset, buffered: cursors[1].buffer.length }, { readOffset: 10, buffered: 0 });
  assert.equal(cursors[0].buffer.length, 6);
  await closeStreamHandles(handles);
  assert.equal(handles.size, 0);
  assert.ok(cursors.every((cursor) => cursor.buffer.length === 0 && cursor.readOffset === 10));
});

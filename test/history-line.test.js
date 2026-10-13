'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { adaptLine, createAdapterState } = require('../src/main/provider-adapters');
const { parseJsonLine, safeTimestamp } = require('../src/main/history/jsonl');
const { parseHistoricalLine } = require('../src/main/history/historical-line');
const { T0, SEC, codex, iso } = require('./support/transcripts');

const NOW = T0 + 24 * 60 * 60 * 1000;
const guard = (value) => safeTimestamp(value, NOW);
const OWN = '019f0000-0000-7000-8000-000000000301';
const PARENT = '019f0000-0000-7000-8000-000000000302';
const CWD = path.resolve('/workspace/demo');
const FILE = `/sessions/rollout-2026-07-21T12-00-00-${OWN}.jsonl`;
const entry = {
  provider: 'codex', sourceKey: `codex:${OWN}`, filePath: FILE, sessionId: OWN,
  projectPath: CWD, projectName: 'demo', projectIdHint: null, kind: 'main',
  parentSessionId: null, startMs: T0, endMs: T0, size: 0, priority: 0,
};

// History's Codex path before it reused the parsed record: adaptLine parses the line again.
function viaAdaptLine(line, lineOffset, adapterState) {
  const record = parseJsonLine(line);
  const ts = record ? guard(record.timestamp) : null;
  if (!record || ts === null) return { signals: [], adapterState, claudeSessionEmitted: false, recordTs: ts };
  const adapted = adaptLine('codex', line.toString('utf8'), adapterState, { lineOffset, now: ts });
  const signals = (adapted && Array.isArray(adapted.signals) ? adapted.signals : [])
    .filter((signal) => signal && Number.isFinite(signal.ts))
    .map((signal) => ({ ...signal, ts }));
  return {
    signals,
    adapterState: adapted && adapted.state ? adapted.state : adapterState,
    claudeSessionEmitted: false,
    recordTs: ts,
  };
}

const lines = [
  codex.meta(T0, PARENT, CWD),
  codex.call(T0 + 1 * SEC, 'call-parent', 'shell'),
  codex.meta(T0 + 2 * SEC, OWN, CWD, { model_provider: 'ollama' }),
  codex.event(T0 + 3 * SEC, 'task_started'),
  codex.call(T0 + 4 * SEC, 'call-1', 'shell'),
  codex.output(T0 + 5 * SEC, 'call-1'),
  codex.patchCall(T0 + 6 * SEC, 'call-patch'),
  codex.patched(T0 + 7 * SEC, 'call-patch', [path.join(CWD, 'src', 'a.js')]),
  { ...codex.patched(T0 + 8 * SEC, 'call-bad', [path.join(CWD, 'b.js')]), payload: { type: 'patch_apply_end', success: false } },
  codex.patchOutput(T0 + 9 * SEC, 'call-patch'),
  codex.userText(T0 + 10 * SEC, 'plain text'),
  { type: 'event_msg', payload: { type: 'task_started', timestamp: iso(T0 + 11 * SEC) } },
  { timestamp: iso(T0 + 12 * SEC), type: 'event_msg', payload: { type: 'turn_aborted' } },
  codex.meta(T0 + 13 * SEC, PARENT, CWD),
  codex.event(T0 + 14 * SEC, 'task_complete'),
  codex.event('1999-01-01T00:00:00.000Z', 'task_started'),
].map((record) => JSON.stringify(record)).concat(['{malformed', '[1,2]', '"text"']);

test('historical line: Codex records adapt exactly as adaptLine does, from one parse', () => {
  for (const initial of [
    createAdapterState('codex', { filename: FILE, sessionId: OWN }),
    createAdapterState('codex', { filename: FILE }),
    null,
    createAdapterState('claude'),
    { provider: 'codex', sessionId: null },
  ]) {
    let expectedState = initial;
    let actualState = initial;
    let offset = 0;
    let signals = 0;
    for (const text of lines) {
      const line = Buffer.from(text);
      const expected = viaAdaptLine(line, offset, expectedState);
      const before = JSON.stringify(actualState);
      const actual = parseHistoricalLine(entry, line, offset, actualState, false, guard);
      assert.equal(JSON.stringify(actualState), before, 'the adapter state passed in is copied, never mutated');
      assert.deepEqual(actual, expected, `${JSON.stringify(initial)} at ${offset}`);
      expectedState = expected.adapterState;
      actualState = actual.adapterState;
      signals += actual.signals.length;
      offset += line.length + 1;
    }
    assert.ok(signals > 0);
  }
});

test('historical line: a forked rollout ignores its parent until its own session_meta', () => {
  let state = createAdapterState('codex', { filename: FILE, sessionId: OWN });
  const types = [];
  for (const text of lines.slice(0, 5)) {
    const parsed = parseHistoricalLine(entry, Buffer.from(text), 0, state, false, guard);
    state = parsed.adapterState;
    types.push(parsed.signals.map((signal) => `${signal.type}:${signal.sessionId}`));
  }
  assert.deepEqual(types, [[], [], [`session:${OWN}`], [`turn-start:${OWN}`], [`tool-start:${OWN}`]]);
});

'use strict';

// src/main/live/drift.js: a transcript this version no longer understands warns once, where the
// viewer sees it, instead of emptying the universe quietly.

const test = require('node:test');
const assert = require('node:assert/strict');
const { DRIFT_LINES, noteLine, noteVersion, checkDrift, warnOnce } = require('../src/main/live/drift');
const { claudeRecordFacts } = require('../src/main/transcripts/claude');
const { codexRecordFacts } = require('../src/main/transcripts/codex');
const {
  SEC, T0, CODEX_SESSION, iso, appendJsonl, createWorld, ofType, claude, codex,
} = require('./support/transcripts');

const CLAUDE_UNKNOWN = 'Claude Code writes records this version does not recognise (Claude Code 9.9.9); ' +
  'its sessions will not show until Agent Orrery is updated.';
const CODEX_UNKNOWN = 'Codex writes records this version does not recognise (Codex 9.9.9); ' +
  'its sessions will not show until Agent Orrery is updated.';

function quietModel(t) {
  t.mock.method(console, 'warn', () => {});
  return { providerWarnings: new Set(), pending: [], feed: [], eventSequence: 0, publish: () => {} };
}

const warnings = (events) => ofType(events, 'feed')
  .filter((event) => event.entry.kind === 'warning')
  .map((event) => event.entry);

test('drift: forty lines read and none recognised warn once per provider, naming its version', (t) => {
  const model = quietModel(t);
  const tail = { provider: 'claude' };
  for (let index = 0; index < DRIFT_LINES - 1; index++) noteLine(tail, false);
  noteVersion(tail, '9.9.9');
  checkDrift(model, tail);
  assert.equal(model.feed.length, 0, 'one line short says nothing');

  noteLine(tail, false);
  checkDrift(model, tail);
  assert.deepEqual(model.feed.map((entry) => [entry.kind, entry.text, entry.project]), [['warning', CLAUDE_UNKNOWN, '']]);
  assert.equal(console.warn.mock.callCount(), 1);
  assert.deepEqual(model.pending.map((event) => event.type), ['feed']);

  // Another transcript of the same provider, and later polls of this one, repeat nothing.
  const other = { provider: 'claude' };
  for (let index = 0; index < DRIFT_LINES; index++) noteLine(other, false);
  noteVersion(other, '9.9.9');
  checkDrift(model, other);
  checkDrift(model, tail);
  assert.equal(model.feed.length, 1);
  assert.deepEqual([...model.providerWarnings], [CLAUDE_UNKNOWN]);
});

test('drift: one recognised record among forty is a transcript this version reads; a malformed version is dropped', (t) => {
  const model = quietModel(t);
  const tail = { provider: 'codex' };
  for (let index = 0; index < DRIFT_LINES; index++) noteLine(tail, index === 7);
  noteVersion(tail, 'not a version!');
  checkDrift(model, tail);
  assert.equal(model.feed.length, 0);
  assert.deepEqual(tail.drift, { lines: DRIFT_LINES, recognised: 1, version: null });
  noteVersion(tail, '0.167.0');
  assert.equal(tail.drift.version, '0.167.0');
});

test('drift: without a version seen, the warning names the provider alone', (t) => {
  const model = quietModel(t);
  const tail = { provider: 'codex' };
  for (let index = 0; index < DRIFT_LINES; index++) noteLine(tail, false);
  checkDrift(model, tail);
  assert.equal(model.feed[0].text,
    'Codex writes records this version does not recognise; its sessions will not show until Agent Orrery is updated.');
});

test('drift: warnOnce reaches the console and the feed once per text, with no system to jump to', (t) => {
  const model = quietModel(t);
  warnOnce(model, 'provider config must contain a watch array');
  warnOnce(model, 'provider config must contain a watch array');
  assert.deepEqual(model.feed.map((entry) => [entry.kind, entry.text, entry.project]),
    [['warning', 'provider config must contain a watch array', '']]);
  assert.equal(console.warn.mock.calls[0].arguments[0], '[providers] provider config must contain a watch array');
});

test('drift: each adapter says which records are of a kind it reads, and the version they name', (t) => {
  const { projectDir } = createWorld(t);
  assert.deepEqual(claudeRecordFacts({ ...claude.prompt(projectDir, T0), version: '2.1.0' }), { known: true, version: '2.1.0' });
  assert.deepEqual(claudeRecordFacts(claude.turnDone(projectDir, T0)), { known: true, version: null });
  assert.deepEqual(claudeRecordFacts({ type: 'attachment', version: '2.1.0', attachment: {} }), { known: false, version: '2.1.0' });
  assert.deepEqual(claudeRecordFacts(null), { known: false, version: null });

  assert.deepEqual(codexRecordFacts(codex.meta(T0, CODEX_SESSION, projectDir, { cli_version: ' 0.167.0 ' })),
    { known: true, version: '0.167.0' });
  assert.deepEqual(codexRecordFacts(codex.event(T0, 'agent_message')), { known: true, version: null });
  assert.deepEqual(codexRecordFacts({ timestamp: iso(T0), type: 'thread_event', payload: {} }), { known: false, version: null });
  assert.deepEqual(codexRecordFacts('not a record'), { known: false, version: null });
});

test('drift: through the Tracker, a Claude transcript of unknown records warns once and the snapshot keeps it', (t) => {
  t.mock.method(console, 'warn', () => {});
  const world = createWorld(t);
  const file = world.claudeFile();
  // On disk at startup, so the tail starts at its end: only what Claude Code writes next is read.
  appendJsonl(file, [claude.prompt(world.projectDir, T0)], T0);
  const live = world.live();
  live.tracker.scan(true);
  live.take();

  const unknown = Array.from({ length: DRIFT_LINES }, (_, index) => ({
    type: 'future-record', version: '9.9.9', cwd: world.projectDir, timestamp: iso(T0 + SEC), index,
  }));
  world.clock.set(T0 + 2 * SEC);
  appendJsonl(file, unknown, T0 + 2 * SEC);
  live.tracker.pollFiles();
  assert.deepEqual(warnings(live.take()).map((entry) => [entry.text, entry.project]), [[CLAUDE_UNKNOWN, '']]);
  assert.deepEqual(live.tracker.snapshot().warnings, [CLAUDE_UNKNOWN]);

  // More of the same adds nothing.
  world.clock.set(T0 + 4 * SEC);
  appendJsonl(file, unknown, T0 + 4 * SEC);
  live.tracker.pollFiles();
  assert.equal(warnings(live.take()).length, 0);
});

test('drift: through the Tracker, a transcript this version reads says nothing however it grows', (t) => {
  t.mock.method(console, 'warn', () => {});
  const world = createWorld(t);
  const file = world.claudeFile();
  appendJsonl(file, [claude.prompt(world.projectDir, T0)], T0);
  const live = world.live();
  live.tracker.scan(true);
  live.take();

  const records = [];
  for (let index = 0; index < DRIFT_LINES + 5; index++) {
    records.push(claude.tool(world.projectDir, T0 + SEC + index, `toolu_${index}`, 'Read', { pattern: 'src' }));
  }
  // Claude Code writes records beside each turn that the adapter has no use for. That is normal.
  for (let index = 0; index < DRIFT_LINES; index++) records.push({ type: 'attachment', version: '2.1.0', attachment: { index } });
  world.clock.set(T0 + 2 * SEC);
  appendJsonl(file, records, T0 + 2 * SEC);
  live.tracker.pollFiles();
  assert.equal(warnings(live.take()).length, 0);
  assert.deepEqual(live.tracker.snapshot().warnings, []);
});

test('drift: through the Tracker, a fresh Codex rollout of unknown records is never tailed, so its head warns at discovery', (t) => {
  t.mock.method(console, 'warn', () => {});
  const world = createWorld(t);
  const unknown = (index) => ({ timestamp: iso(T0 + index), type: 'thread_event', payload: { cli_version: '9.9.9', index } });
  appendJsonl(world.codexFile(), Array.from({ length: DRIFT_LINES - 1 }, (_, index) => unknown(index)), T0);
  const live = world.live();
  world.clock.set(T0 + SEC);
  live.tracker.scan(true);
  assert.equal(warnings(live.take()).length, 0, 'one line short says nothing');

  world.clock.set(T0 + 2 * SEC);
  appendJsonl(world.codexFile(), [unknown(DRIFT_LINES)], T0 + 2 * SEC);
  live.tracker.scan(false);
  assert.deepEqual(warnings(live.take()).map((entry) => [entry.text, entry.project]), [[CODEX_UNKNOWN, '']]);
  assert.deepEqual(live.tracker.snapshot().warnings, [CODEX_UNKNOWN]);
  live.tracker.scan(false);
  assert.equal(warnings(live.take()).length, 0, 'once per run');
});

test('drift: a Codex rollout whose metadata the adapter rejects, but whose records it knows, is not drift', (t) => {
  t.mock.method(console, 'warn', () => {});
  const world = createWorld(t);
  const records = [codex.meta(T0, 'not a session id', world.projectDir)];
  for (let index = 0; index < DRIFT_LINES; index++) records.push(codex.event(T0 + index, 'agent_message'));
  appendJsonl(world.codexFile(), records, T0);
  const live = world.live();
  world.clock.set(T0 + SEC);
  live.tracker.scan(true);
  assert.equal(warnings(live.take()).length, 0);
  assert.equal(live.tracker.ships.size, 0, 'and it is not tracked either');
});

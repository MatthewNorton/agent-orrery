'use strict';

// src/main/live/drift.js: a transcript this version no longer understands warns once, where the
// viewer sees it, instead of emptying the universe quietly.

const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { DRIFT_LINES, noteLine, noteVersion, checkDrift, warnOnce } = require('../src/main/live/drift');
const { claudeRecordFacts } = require('../src/main/transcripts/claude');
const { codexRecordFacts } = require('../src/main/transcripts/codex');
const {
  SEC, MIN, T0, CODEX_SESSION, iso, appendJsonl, createWorld, ofType, claude, codex,
} = require('./support/transcripts');
const { startClaude } = require('./support/live-session');

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

/** `count` records of a kind this version has never seen, written at `at` in the world's project. */
const unseen = (world, type, version, at, count) => Array.from({ length: count }, (_, index) => ({
  type, version, cwd: world.projectDir, timestamp: iso(at), index,
}));

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
  assert.deepEqual(claudeRecordFacts({ type: 'attachment', version: '2.1.0', attachment: {} }), { known: true, version: '2.1.0' },
    'bookkeeping Claude Code writes beside the messages is recognised, and skipped');
  assert.deepEqual(claudeRecordFacts({ type: 'queue-operation', operation: 'enqueue' }), { known: true, version: null });
  assert.deepEqual(claudeRecordFacts({ type: 'future-record', version: '2.1.0' }), { known: false, version: '2.1.0' });
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
  // On disk at startup: the head is counted, then only what Claude Code writes next is read, and
  // nothing in either is a kind this version knows.
  appendJsonl(file, [{ type: 'future-record', version: '9.9.9', cwd: world.projectDir, timestamp: iso(T0) }], T0);
  const live = world.live();
  live.tracker.scan(true);
  live.take();

  const unknown = unseen(world, 'future-record', '9.9.9', T0 + SEC, DRIFT_LINES);
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

test('drift: through the Tracker, a startup transcript whose head is all unknown warns at the first poll, before it grows', (t) => {
  t.mock.method(console, 'warn', () => {});
  const world = createWorld(t);
  const file = world.claudeFile();
  // The real-drift case: a hot transcript on disk at startup, and nothing in its head is a kind this
  // version knows. The head count alone must warn; Claude Code need not write another line first.
  appendJsonl(file, unseen(world, 'future-record', '9.9.9', T0, DRIFT_LINES), T0);
  const live = world.live();
  live.tracker.scan(true);
  live.tracker.pollFiles();
  assert.deepEqual(warnings(live.take()).map((entry) => [entry.text, entry.project]), [[CLAUDE_UNKNOWN, '']]);
  assert.deepEqual(live.tracker.snapshot().warnings, [CLAUDE_UNKNOWN]);
});

test('drift: through the Tracker, a transcript this version reads says nothing however it grows', (t) => {
  t.mock.method(console, 'warn', () => {});
  const live = startClaude(t);
  const { world, file } = live;

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

// A session that opened at `openedAt` with a readable first message; the app starts at T0, then
// Claude Code writes a long run of records of a kind this version has never seen. What the canary
// said, what it pinned, and how many lines it counted for the file.
function judgedByHead(t, openedAt, startup = (live, file) => live.tracker.scan(true)) {
  t.mock.method(console, 'warn', () => {});
  const world = createWorld(t);
  const file = world.claudeFile();
  appendJsonl(file, [claude.prompt(world.projectDir, openedAt), claude.turnDone(world.projectDir, openedAt + SEC)], openedAt + SEC);
  const live = world.live();
  startup(live, file);
  live.take();

  world.clock.set(T0 + 2 * SEC);
  appendJsonl(file, unseen(world, 'future-bookkeeping', '2.1.0', T0 + 2 * SEC, 3 * DRIFT_LINES), T0 + 2 * SEC);
  live.tracker.scan(false);
  live.tracker.pollFiles();
  return {
    warnings: warnings(live.take()),
    pinned: live.tracker.snapshot().warnings,
    lines: live.tracker.model.claudeTails.get(file).drift.lines,
  };
}

test('drift: through the Tracker, a transcript on disk at startup is judged by its head before its tail', (t) => {
  // The tail starts at the end of the file, so the two records of its head are counted first, and the
  // unfamiliar run after them is normal bookkeeping, not drift. Each line is counted once.
  assert.deepEqual(judgedByHead(t, T0), { warnings: [], pinned: [], lines: 2 + 3 * DRIFT_LINES });
});

test('drift: through the Tracker, a transcript cold at startup is judged by its head when it resumes', (t) => {
  // The same session, quiet for twenty minutes when the app started: too cold to tail, so its tail
  // waits at the end of the file and the head is counted when the session resumes.
  assert.deepEqual(judgedByHead(t, T0 - 20 * MIN), { warnings: [], pinned: [], lines: 2 + 3 * DRIFT_LINES });
});

test('drift: through the Tracker, a head unreadable at the first poll is read at the next one, before the tail is judged', (t) => {
  assert.deepEqual(judgedByHead(t, T0, (live, file) => {
    live.tracker.scan(true);
    assert.equal(live.tracker.snapshot().ships.length, 1, 'the active session has its ship before its head is read');
    // The transcript is locked for the length of the first poll, as a provider rotating it would have it.
    const open = fs.openSync;
    const lock = t.mock.method(fs, 'openSync', (...args) => {
      if (args[0] === file) throw new Error('EBUSY');
      return open(...args);
    });
    live.tracker.pollFiles();
    lock.mock.restore();
  }), { warnings: [], pinned: [], lines: 2 + 3 * DRIFT_LINES });
});

test('drift: through the Tracker, a transcript cold at startup whose head is all unknown warns when it resumes', (t) => {
  t.mock.method(console, 'warn', () => {});
  const world = createWorld(t);
  const file = world.claudeFile();
  appendJsonl(file, unseen(world, 'future-record', '9.9.9', T0 - 20 * MIN, DRIFT_LINES), T0 - 20 * MIN);
  const live = world.live();
  live.tracker.scan(true);
  live.tracker.pollFiles();
  assert.equal(warnings(live.take()).length, 0, 'too cold to tail, so nothing of it is judged yet');

  // Touched, the session is back; its head alone is what the canary reads.
  world.clock.set(T0 + 2 * SEC);
  appendJsonl(file, [], T0 + 2 * SEC);
  live.tracker.scan(false);
  live.tracker.pollFiles();
  assert.deepEqual(warnings(live.take()).map((entry) => [entry.text, entry.project]), [[CLAUDE_UNKNOWN, '']]);
});

test('drift: through the Tracker, a transcript read from zero counts its own head, also when it goes cold and resumes', (t) => {
  t.mock.method(console, 'warn', () => {});
  const world = createWorld(t);
  const file = world.claudeFile();
  const live = world.live();
  live.tracker.scan(true);
  // Found mid-run and read from zero, so its head is counted as it is read. It goes cold, which
  // drops it from the file map, and resumes: nothing of it is counted twice.
  world.clock.set(T0 + SEC);
  appendJsonl(file, [claude.prompt(world.projectDir, T0), claude.turnDone(world.projectDir, T0 + SEC)], T0 + SEC);
  live.tracker.scan(false);
  live.tracker.pollFiles();
  world.clock.set(T0 + SEC + 16 * MIN);
  live.tracker.pollFiles();
  const resumedAt = T0 + 17 * MIN;
  world.clock.set(resumedAt);
  appendJsonl(file, unseen(world, 'future-bookkeeping', '2.1.0', resumedAt, 3 * DRIFT_LINES), resumedAt);
  live.tracker.scan(false);
  live.tracker.pollFiles();
  assert.equal(warnings(live.take()).length, 0);
  assert.equal(live.tracker.model.claudeTails.get(file).drift.lines, 2 + 3 * DRIFT_LINES);
});

test('drift: through the Tracker, a Codex rollout on disk at startup is judged by its head before its tail', (t) => {
  t.mock.method(console, 'warn', () => {});
  const world = createWorld(t);
  const file = world.codexFile();
  // Tailed from its end at startup. The head's session_meta says this version reads the format, so
  // the unfamiliar run Codex writes next is bookkeeping, not drift.
  appendJsonl(file, [codex.meta(T0, CODEX_SESSION, world.projectDir)], T0);
  const live = world.live();
  live.tracker.scan(true);
  live.take();

  world.clock.set(T0 + 2 * SEC);
  appendJsonl(file, Array.from({ length: 3 * DRIFT_LINES }, (_, index) => ({
    timestamp: iso(T0 + 2 * SEC), type: 'future-bookkeeping', payload: { cli_version: '2.1.0', index },
  })), T0 + 2 * SEC);
  live.tracker.pollFiles();
  assert.equal(warnings(live.take()).length, 0);
  assert.deepEqual(live.tracker.snapshot().warnings, []);
  // The head's one line and the run after it, each counted once.
  assert.deepEqual(live.tracker.model.codexTailsBySession.get(CODEX_SESSION).drift,
    { lines: 1 + 3 * DRIFT_LINES, recognised: 1, version: '2.1.0' });
});

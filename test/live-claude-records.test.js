'use strict';

// src/main/live/claude-records.js, through the Tracker: what a Claude transcript's records do to
// its ships: drones, attention, sweeps and sessions that resume. Part of the characterization of
// the live model in tracker.test.js: it pins behaviour as it is.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { classifyAttention } = require('../src/main/tracker');
const {
  SEC, MIN, T0, SLUG, SHIP_ID, appendJsonl, createWorld, ofType, pick, claude,
} = require('./support/transcripts');
const { startClaude, appendAndPoll, pollAt, sweepAt, shipOf } = require('./support/live-session');

test('claude: Task and Agent tool_use launch drones that dock again on tool_result', (t) => {
  const session = startClaude(t);
  const { dir, tracker } = session;
  const events = appendAndPoll(session, [
    claude.tool(dir, T0 + 1 * SEC, 'toolu_task1', 'Task', { description: 'Survey', prompt: 'private' }),
    claude.tool(dir, T0 + 2 * SEC, 'toolu_agent1', 'Agent', { description: 'Audit', prompt: 'private' }),
    claude.result(dir, T0 + 3 * SEC, 'toolu_task1'),
  ], T0 + 3 * SEC);

  assert.deepEqual(events.map((event) => event.type), [
    'ship-updated', 'activity', 'ship-spawned', 'feed',
    'ship-updated', 'activity', 'ship-spawned', 'feed',
    'ship-departed', 'feed',
  ]);
  assert.deepEqual(ofType(events, 'activity').map(pick(['tool', 'status', 'detail'])), [
    { tool: 'Task', status: 'Delegating', detail: 'Survey' },
    { tool: 'Agent', status: 'Delegating', detail: 'Audit' },
  ]);
  assert.deepEqual(ofType(events, 'ship-spawned')[0].ship, {
    id: 'drone:toolu_task1', name: 'Claude-2', project: SLUG, kind: 'drone', provider: 'claude',
    status: 'Working', detail: null, lastEvent: T0 + 1 * SEC, attention: null, attentionSince: null,
    builds: 0, local: false, model: null, taskId: null, turnOutcome: null,
  });
  assert.equal(ofType(events, 'ship-spawned')[1].ship.id, 'drone:toolu_agent1');
  assert.deepEqual(ofType(events, 'ship-departed').map(pick(['shipId', 'ts'])),
    [{ shipId: 'drone:toolu_task1', ts: T0 + 3 * SEC }]);
  assert.deepEqual(ofType(events, 'feed').map((event) => event.entry.text), [
    'Claude-1 launched Claude-2 in demo',
    'Claude-1 launched Claude-3 in demo',
    'Claude-2 returned to Claude-1',
  ]);
  assert.deepEqual(tracker.snapshot().ships.map((ship) => ship.id), [SHIP_ID, 'drone:toolu_agent1']);
});

test('claude: turn_duration completes the turn silently; done attention follows 10 s of quiet', (t) => {
  const session = startClaude(t);
  const { dir } = session;
  const finished = appendAndPoll(session, [
    claude.tool(dir, T0 + 1 * SEC, 'toolu_r1', 'Read', { file_path: path.join(dir, 'src', 'a.js') }),
    claude.result(dir, T0 + 2 * SEC, 'toolu_r1'),
    claude.turnDone(dir, T0 + 3 * SEC),
  ], T0 + 3 * SEC);
  assert.deepEqual(finished.map((event) => event.type), ['ship-updated', 'activity'],
    'neither tool_result nor turn_duration queues an event');

  assert.deepEqual(pollAt(session, T0 + 3 * SEC + 9_999), []);
  const done = pollAt(session, T0 + 13 * SEC);
  assert.deepEqual(done.map((event) => event.type), ['ship-updated', 'feed']);
  assert.deepEqual(pick(['attention', 'attentionSince', 'turnOutcome'])(done[0].ship),
    { attention: 'done', attentionSince: T0 + 13 * SEC, turnOutcome: null });
  assert.deepEqual(done[1].entry,
    { kind: 'done', text: 'Claude-1 finished its task in demo', project: SLUG, ts: T0 + 13 * SEC });

  const resumed = appendAndPoll(session, [claude.prompt(dir, T0 + 20 * SEC)], T0 + 20 * SEC);
  assert.deepEqual(resumed.map((event) => [event.type, event.ship.attention, event.ship.status]),
    [['ship-updated', null, 'Exploring']], 'a new prompt clears done but keeps the last tool status');
});

test('classifyAttention: question 2 s, permission 10 s, stalled 180 s, done after 10 s quiet; never for drones', () => {
  const ship = (pending, extra = {}) => ({
    kind: 'main', turnDone: false, lastEvent: 0, ...extra,
    pending: new Map(pending.map(([tool, ts], index) => [`call-${index}`, { tool, ts }])),
  });
  const cases = [
    [ship([['AskUserQuestion', 0]]), 1_999, null],
    [ship([['AskUserQuestion', 0]]), 2_000, 'question'],
    [ship([['ExitPlanMode', 0]]), 2_000, 'question'],
    [ship([['Edit', 0]]), 9_999, null],
    [ship([['Edit', 0]]), 10_000, 'permission'],
    [ship([['Read', 0]]), 10_000, 'permission'],
    [ship([['Bash', 0]]), 10_000, null],
    [ship([['Bash', 0]]), 179_999, null],
    [ship([['Bash', 0]]), 180_000, 'stalled'],
    [ship([['Task', 0]]), 180_000, 'stalled'],
    [ship([['Edit', 0], ['AskUserQuestion', 0]]), 10_000, 'question'],
    [ship([['Bash', 0], ['Read', 0]]), 180_000, 'permission'],
    [ship([], { turnDone: true }), 9_999, null],
    [ship([], { turnDone: true }), 10_000, 'done'],
    [ship([['Bash', 0]], { turnDone: true }), 10_000, null],
    [ship([], { turnDone: false }), 60_000, null],
    [ship([['AskUserQuestion', 0]], { kind: 'drone' }), 60_000, null],
  ];
  for (const [input, now, expected] of cases) {
    const label = `${[...input.pending.values()].map((p) => p.tool).join('+') || 'idle'} ${input.kind} @${now}`;
    assert.equal(classifyAttention(input, now), expected, label);
  }
});

test('claude: pending tools raise question, permission and stalled attention; tool_result clears it', (t) => {
  const session = startClaude(t);
  const { dir } = session;

  appendAndPoll(session, [claude.tool(dir, T0 + 1 * SEC, 'toolu_q', 'AskUserQuestion', {})], T0 + 1 * SEC);
  const question = pollAt(session, T0 + 3 * SEC);
  assert.deepEqual(question.map((event) => event.type), ['ship-updated', 'feed']);
  assert.deepEqual(pick(['attention', 'attentionSince'])(question[0].ship),
    { attention: 'question', attentionSince: T0 + 3 * SEC });
  assert.deepEqual([question[1].entry.kind, question[1].entry.text],
    ['attention', 'Claude-1 is asking you something in demo']);
  const answered = appendAndPoll(session, [claude.result(dir, T0 + 4 * SEC, 'toolu_q')], T0 + 4 * SEC);
  assert.deepEqual(answered.map((event) => [event.type, event.ship.attention]), [['ship-updated', null]]);

  appendAndPoll(session, [claude.tool(dir, T0 + 5 * SEC, 'toolu_e', 'Edit', {
    file_path: path.join(session.world.root, 'elsewhere', 'x.js'),
  })], T0 + 5 * SEC);
  const permission = pollAt(session, T0 + 15 * SEC);
  assert.deepEqual(permission.map((event) => event.type), ['ship-updated', 'feed']);
  assert.equal(permission[0].ship.attention, 'permission');
  assert.deepEqual([permission[1].entry.kind, permission[1].entry.text],
    ['attention', 'Claude-1 needs permission in demo']);
  appendAndPoll(session, [claude.result(dir, T0 + 16 * SEC, 'toolu_e')], T0 + 16 * SEC);

  appendAndPoll(session, [claude.tool(dir, T0 + 20 * SEC, 'toolu_b', 'Bash', { command: 'private' })], T0 + 20 * SEC);
  assert.deepEqual(pollAt(session, T0 + 20 * SEC + 179_999), []);
  const stalled = pollAt(session, T0 + 200 * SEC);
  assert.equal(stalled[0].ship.attention, 'stalled');
  assert.deepEqual([stalled[1].entry.kind, stalled[1].entry.text], ['info', 'Claude-1 may be stuck in demo']);
});

test('claude: sweepShips warps out a main ship after 5 min idle and a drone after 15 min', (t) => {
  const session = startClaude(t);
  const { dir } = session;
  const last = T0 + 1 * SEC;
  appendAndPoll(session, [claude.tool(dir, last, 'toolu_t', 'Task', { description: 'Survey' })], last);

  const stalled = sweepAt(session, last + 3 * MIN);
  assert.deepEqual(stalled.map((event) => event.type), ['ship-updated', 'feed'], 'the open Task stalls the parent');
  assert.deepEqual(sweepAt(session, last + 5 * MIN), [], 'departure needs strictly more than 5 min');

  const mainGone = sweepAt(session, last + 5 * MIN + 1);
  assert.deepEqual(mainGone.map((event) => event.type), ['ship-departed', 'feed']);
  assert.deepEqual(pick(['shipId', 'ts'])(mainGone[0]), { shipId: SHIP_ID, ts: last + 5 * MIN + 1 });
  assert.equal(mainGone[1].entry.text, 'Claude-1 warped out');
  assert.deepEqual(session.tracker.snapshot().ships.map((ship) => ship.id), ['drone:toolu_t']);

  assert.deepEqual(sweepAt(session, last + 15 * MIN), []);
  const droneGone = sweepAt(session, last + 15 * MIN + 1);
  assert.deepEqual(droneGone.map((event) => [event.type, event.shipId || event.entry.text]),
    [['ship-departed', 'drone:toolu_t'], ['feed', 'Claude-2 warped out']]);
});

test('claude: question or permission attention keeps a ship docked for up to an hour', (t) => {
  const session = startClaude(t);
  const last = T0 + 1 * SEC;
  appendAndPoll(session, [claude.tool(session.dir, last, 'toolu_q', 'AskUserQuestion', {})], last);

  assert.deepEqual(sweepAt(session, last + 10 * MIN).map((event) => event.type), ['ship-updated', 'feed']);
  assert.equal(shipOf(session.tracker, SHIP_ID).attention, 'question');
  assert.deepEqual(sweepAt(session, last + 60 * MIN), []);
  assert.deepEqual(sweepAt(session, last + 60 * MIN + 1).map((event) => event.type), ['ship-departed', 'feed']);
});

// Edits src/a.js, lets the transcript go cold (> 15 min), then resumes it at T0 + 20 min with
// an edit to src/b.js; also writes `alongside` with that time, then scans and polls once.
function resumeAfterIdle(t, alongside = () => {}) {
  const session = startClaude(t);
  const { dir, tracker } = session;
  appendAndPoll(session, [
    claude.tool(dir, T0 + 1 * SEC, 'toolu_e1', 'Edit', { file_path: path.join(dir, 'src', 'a.js') }),
  ], T0 + 1 * SEC);
  assert.equal(tracker.snapshot().projects[0].totalBuilds, 1);

  pollAt(session, T0 + 1 * SEC + 15 * MIN + 1);
  const resumedAt = T0 + 20 * MIN;
  session.world.clock.set(resumedAt);
  appendJsonl(session.file, [
    claude.tool(dir, resumedAt, 'toolu_e2', 'Edit', { file_path: path.join(dir, 'src', 'b.js') }),
  ], resumedAt);
  alongside(session, resumedAt);
  tracker.scan(false);
  tracker.pollFiles();
  return { ...session, events: session.take() };
}

test('claude: a session resumed after 15 min idle continues from its previous offset (no re-count)', (t) => {
  const { tracker, events } = resumeAfterIdle(t);
  assert.deepEqual(ofType(events, 'build').map(pick(['shipId', 'file', 'isNew'])),
    [{ shipId: SHIP_ID, file: path.join('src', 'b.js'), isNew: false }]);
  assert.equal(tracker.snapshot().projects[0].totalBuilds, 2);
});

test('claude: a transcript that first appears while running is still replayed from zero and counts its edits', (t) => {
  const newSession = '7c0d5f8e-1111-4222-8333-777788889999';
  const { tracker, events } = resumeAfterIdle(t, ({ world, dir }, at) => {
    appendJsonl(world.claudeFile(SLUG, newSession), [
      claude.prompt(dir, at - 2 * SEC),
      claude.tool(dir, at - 1 * SEC, 'toolu_n1', 'Edit', { file_path: path.join(dir, 'src', 'c.js') }),
      claude.tool(dir, at, 'toolu_n2', 'Write', { file_path: path.join(dir, 'notes.md') }),
    ], at);
  });
  assert.deepEqual(ofType(events, 'build').map(pick(['shipId', 'file'])),
    [{ shipId: SHIP_ID, file: path.join('src', 'b.js') }], 'the new transcript is caught up silently');
  assert.deepEqual(ofType(events, 'ship-spawned').map((event) => event.ship.id), [`ship:${SLUG}:${newSession}`]);
  assert.equal(tracker.snapshot().projects[0].totalBuilds, 4, 'a.js and b.js once each, plus both new-transcript edits');
});

test('claude: a transcript already idle over 15 min at startup resumes from its end (no re-count)', (t) => {
  const world = createWorld(t);
  const dir = world.projectDir;
  const file = world.claudeFile();
  appendJsonl(file, [
    claude.prompt(dir, T0 - 60 * MIN),
    claude.tool(dir, T0 - 59 * MIN, 'toolu_old', 'Edit', { file_path: path.join(dir, 'src', 'a.js') }),
  ], T0 - 59 * MIN);
  const { tracker, take } = world.live();
  tracker.scan(true);
  assert.deepEqual(take().map((event) => event.type), ['project-added']);

  world.clock.set(T0 + 1 * MIN);
  appendJsonl(file, [
    claude.tool(dir, T0 + 1 * MIN, 'toolu_new', 'Edit', { file_path: path.join(dir, 'src', 'b.js') }),
  ], T0 + 1 * MIN);
  tracker.scan(false);
  tracker.pollFiles();
  const events = take();
  assert.deepEqual(ofType(events, 'ship-spawned').map((event) => event.ship.id), [SHIP_ID]);
  assert.deepEqual(ofType(events, 'build').map(pick(['file', 'isNew'])), [{ file: path.join('src', 'b.js'), isNew: true }]);
  assert.equal(tracker.snapshot().projects[0].totalBuilds, 1);
});

test('claude: an edit whose path holds a NUL, CR or LF, or is too long, counts no build and names no folder', (t) => {
  const session = startClaude(t);
  const { dir, tracker } = session;
  const unsafe = ['bad\0dir', 'bad\rdir', 'bad\ndir'].map((folder) => path.join(dir, folder, 'a.js'));
  unsafe.push(path.join(dir, 'long', 'a'.repeat(5000)), path.join(dir, 'a\0b.js'));
  const events = appendAndPoll(session, [
    ...unsafe.map((file_path, index) => claude.tool(dir, T0 + (1 + index) * SEC, `toolu_u${index}`, 'Edit', { file_path })),
    claude.tool(dir, T0 + 9 * SEC, 'toolu_ok', 'Write', { file_path: path.join(dir, 'src', 'a.js') }),
  ], T0 + 9 * SEC);
  // As history reads the same lines: the tool still shows on its ship, and only the path that is one builds.
  assert.deepEqual(ofType(events, 'build').map(pick(['bucket', 'file'])), [{ bucket: 'src', file: path.join('src', 'a.js') }]);
  assert.deepEqual(ofType(events, 'activity').map(pick(['tool', 'status', 'detail'])),
    unsafe.map(() => ({ tool: 'Edit', status: 'Building', detail: null })));
  const project = tracker.model.projects.get(SLUG);
  assert.deepEqual([Object.keys(project.buckets), project.totalBuilds, tracker.snapshot().projects[0].planets], [['src'], 1, ['src']]);
});

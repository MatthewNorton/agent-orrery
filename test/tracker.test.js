'use strict';

// Characterization of the live model (src/main/tracker.js) as of the Phase 3
// cleanup. These pin current behaviour so the parser merge can prove it
// changes nothing; tests marked `todo` encode suspected bugs, not intent.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { classifyAttention } = require('../src/main/tracker');
const {
  adaptLine, createAdapterState, classifyTool, canonicalProjectPath,
} = require('../src/main/provider-adapters');
const {
  SEC, MIN, T0, SLUG, CLAUDE_SESSION, CODEX_SESSION, TASK_ID,
  fnv1a, hex8, appendJsonl, setMtime, createWorld, ofType, claude, codex,
} = require('./support/transcripts');

const SHIP_ID = `ship:${SLUG}:${CLAUDE_SESSION}`;
const CODEX_SHIP_ID = `ship:codex:${CODEX_SESSION}`;
const PROJECT_KEYS = [
  'exists', 'firstSeen', 'galaxy', 'id', 'lastActivity', 'name', 'path', 'seed',
  'totalBuilds', 'totalBytes',
];
const SHIP_KEYS = [
  'attention', 'attentionSince', 'detail', 'id', 'kind', 'lastEvent', 'name', 'project',
  'provider', 'status', 'taskId', 'turnOutcome',
];

// A Claude session whose first line was on disk at startup (so it is tailed
// from EOF and its ship is docked), with startup events already drained.
function startClaude(t, { mtime = T0 } = {}) {
  const world = createWorld(t);
  const file = world.claudeFile();
  appendJsonl(file, [claude.prompt(world.projectDir, mtime)], mtime);
  const live = world.live();
  live.tracker.scan(true);
  const startup = live.take();
  return { world, file, dir: world.projectDir, ...live, startup };
}

function startCodex(t) {
  const world = createWorld(t);
  const file = world.codexFile();
  appendJsonl(file, [codex.meta(T0, CODEX_SESSION, world.projectDir)], T0);
  const live = world.live();
  live.tracker.scan(true);
  const startup = live.take();
  return { world, file, dir: world.projectDir, ...live, startup };
}

// Moves the clock to `at`, appends records with that mtime, and polls once.
function appendAndPoll(session, records, at) {
  session.world.clock.set(at);
  appendJsonl(session.file, records, at);
  session.tracker.pollFiles();
  return session.take();
}

function pollAt(session, at) {
  session.world.clock.set(at);
  session.tracker.pollFiles();
  return session.take();
}

function sweepAt(session, at) {
  session.world.clock.set(at);
  session.tracker.sweepShips();
  return session.take();
}

function shipOf(tracker, id) {
  return tracker.snapshot().ships.find((ship) => ship.id === id);
}

const pick = (keys) => (event) => Object.fromEntries(keys.map((key) => [key, event[key]]));

// ---------- Claude ----------

test('claude: startup discovers the project from slug dir + cwd and docks a ship without replaying history', (t) => {
  const { world, file, tracker, take, startup } = startClaude(t);

  assert.deepEqual(startup.map((event) => event.type), ['project-added', 'ship-spawned', 'feed']);
  assert.deepEqual(startup.map((event) => event.seq), [1, 2, 3]);
  assert.deepEqual(Object.keys(startup[0].project).sort(), PROJECT_KEYS);
  assert.deepEqual(startup[0].project, {
    id: SLUG, path: world.projectDir, name: 'demo', exists: true,
    firstSeen: T0, lastActivity: T0, totalBytes: fs.statSync(file).size, totalBuilds: 0,
    seed: fnv1a(SLUG), galaxy: { key: 'workspace:demo', label: 'Demo' },
  });
  assert.deepEqual(Object.keys(startup[1].ship).sort(), SHIP_KEYS);
  assert.deepEqual(startup[1].ship, {
    id: SHIP_ID, name: 'Claude-1', project: SLUG, kind: 'main', provider: 'claude',
    status: 'Working', detail: null, lastEvent: T0, attention: null, attentionSince: null,
    taskId: null, turnOutcome: null,
  });
  // Startup scans never announce discoveries in the feed.
  assert.deepEqual(startup[2].entry, { kind: 'spawn', text: 'Claude-1 entered demo', project: SLUG, ts: T0 });

  tracker.pollFiles();
  assert.deepEqual(take(), [], 'the line already on disk at startup is never parsed');
  assert.equal(tracker.snapshot().eventSequence, 3);
});

test('claude: a project without a cwd in its head uses the slug, then adopts the first parsed cwd', (t) => {
  const world = createWorld(t);
  const file = world.claudeFile();
  appendJsonl(file, [{ type: 'summary', summary: 'private', leafUuid: 'x' }], T0);
  const session = { world, file, ...world.live() };
  session.tracker.scan(true);
  const [added] = session.take();
  assert.deepEqual(
    pick(['id', 'path', 'name', 'exists', 'galaxy'])(added.project),
    { id: SLUG, path: null, name: SLUG, exists: false, galaxy: { key: 'workspace:demo', label: 'Demo' } },
    'a pathless project derives its galaxy from the slug'
  );

  const events = appendAndPoll(session, [claude.prompt(world.projectDir, T0 + SEC)], T0 + SEC);
  assert.deepEqual(events.map((event) => event.type), ['project-updated']);
  assert.deepEqual(pick(['id', 'path', 'name', 'exists'])(events[0].project),
    { id: SLUG, path: world.projectDir, name: 'demo', exists: true });
});

test('claude: a transcript idle 5-15 min at startup is tailed without a ship; new activity spawns one', (t) => {
  const session = startClaude(t, { mtime: T0 - 10 * MIN });
  assert.deepEqual(session.startup.map((event) => event.type), ['project-added']);

  const events = appendAndPoll(session, [
    claude.tool(session.dir, T0, 'toolu_read', 'Read', { file_path: path.join(session.dir, 'src', 'a.js') }),
  ], T0);
  assert.deepEqual(events.map((event) => event.type), ['ship-spawned', 'feed', 'ship-updated', 'activity']);
  assert.equal(events[0].ship.id, SHIP_ID);
  assert.equal(events[0].ship.lastEvent, T0);
});

test('claude: a transcript first seen after startup is read from offset 0 in catchup mode', (t) => {
  const world = createWorld(t);
  const dir = world.projectDir;
  const session = { world, file: world.claudeFile(), dir, ...world.live() };
  session.tracker.scan(true);
  assert.deepEqual(session.take(), []);

  world.clock.set(T0 + 3 * SEC);
  appendJsonl(session.file, [
    claude.prompt(dir, T0),
    claude.tool(dir, T0 + SEC, 'toolu_edit', 'Edit', { file_path: path.join(dir, 'src', 'a.js') }),
    claude.result(dir, T0 + 2 * SEC, 'toolu_edit'),
    claude.tool(dir, T0 + 3 * SEC, 'toolu_task', 'Task', { description: 'Survey' }),
  ], T0 + 3 * SEC);
  session.tracker.scan(false);
  const discovered = session.take();
  assert.deepEqual(discovered.map((event) => event.type), ['project-added', 'feed']);
  assert.deepEqual(discovered[1].entry,
    { kind: 'discover', text: 'New system discovered: demo', project: SLUG, ts: T0 + 3 * SEC });

  session.tracker.pollFiles();
  const caughtUp = session.take();
  assert.deepEqual(caughtUp.map((event) => event.type), ['ship-spawned', 'feed', 'ship-updated', 'ship-updated'],
    'catchup counts builds but emits no build/activity events and launches no drones');
  const snapshot = session.tracker.snapshot();
  assert.equal(snapshot.projects[0].totalBuilds, 1);
  assert.deepEqual(snapshot.ships.map((ship) => [ship.id, ship.status, ship.detail]),
    [[SHIP_ID, 'Delegating', 'Survey']]);

  const after = appendAndPoll(session, [
    claude.tool(dir, T0 + 4 * SEC, 'toolu_edit2', 'Edit', { file_path: path.join(dir, 'src', 'b.js') }),
  ], T0 + 4 * SEC);
  assert.deepEqual(ofType(after, 'build').map(pick(['bucket', 'isNew'])), [{ bucket: 'src', isNew: false }],
    'catchup ends once the tail reaches EOF');
});

test('claude: tool_use maps to ship status, detail and activity events', (t) => {
  const session = startClaude(t);
  const { dir } = session;
  const tools = [
    ['Read', { file_path: path.join(dir, 'src', 'a.js') }, 'Exploring', path.join('src', 'a.js')],
    ['Grep', { pattern: 'x'.repeat(70), path: dir }, 'Exploring', 'x'.repeat(60)],
    ['Glob', { pattern: '**/*.js' }, 'Exploring', '**/*.js'],
    ['LSP', { operation: 'hover' }, 'Exploring', null],
    ['Bash', { command: 'private', description: 'Run unit tests' }, 'Gathering Resources', 'Run unit tests'],
    ['PowerShell', { command: 'private' }, 'Gathering Resources', null],
    ['WebSearch', { query: 'private' }, 'Scanning', null],
    ['WebFetch', { url: 'https://example.invalid' }, 'Scanning', null],
    ['TodoWrite', { todos: [] }, 'Planning', null],
    ['ExitPlanMode', { plan: 'private' }, 'Planning', null],
    ['AskUserQuestion', { questions: [] }, 'Working', null],
    ['mcp__probe__lookup', {}, 'Working', null],
    ['Read', { file_path: path.join(session.world.root, 'outside', 'notes.txt') }, 'Exploring', 'notes.txt'],
  ];
  const records = tools.map(([name, input], index) =>
    claude.tool(dir, T0 + (index + 1) * 100, `toolu_${index}`, name, input));
  // 100 ms apart, so no pending call is old enough to raise attention.
  const events = appendAndPoll(session, records, T0 + tools.length * 100);

  assert.deepEqual(ofType(events, 'activity').map(pick(['tool', 'status', 'detail'])),
    tools.map(([tool, , status, detail]) => ({ tool, status, detail })),
    'live keeps raw tool names (including unknown MCP names)');
  for (const [index, event] of ofType(events, 'activity').entries()) {
    assert.equal(event.project, SLUG);
    assert.equal(event.shipId, SHIP_ID);
    assert.equal(event.ts, T0 + (index + 1) * 100);
  }
  assert.deepEqual(ofType(events, 'ship-updated').map((event) => [event.ship.status, event.ship.detail]),
    tools.map(([, , status, detail]) => [status, detail]));
});

test('claude: in-project edits emit build events and grow buckets; out-of-project edits emit activity only', (t) => {
  const session = startClaude(t);
  const { dir, tracker } = session;
  const outside = path.join(session.world.root, 'elsewhere', 'x.js');
  const events = appendAndPoll(session, [
    claude.tool(dir, T0 + 1 * SEC, 'toolu_e1', 'Edit', { file_path: path.join(dir, 'src', 'a.js') }),
    claude.tool(dir, T0 + 2 * SEC, 'toolu_w1', 'Write', { file_path: path.join(dir, 'src', 'b.js') }),
    claude.tool(dir, T0 + 3 * SEC, 'toolu_m1', 'MultiEdit', { file_path: path.join(dir, 'notes.md') }),
    claude.tool(dir, T0 + 4 * SEC, 'toolu_o1', 'Edit', { file_path: outside }),
  ], T0 + 4 * SEC);

  assert.deepEqual(Object.keys(ofType(events, 'build')[0]).sort(),
    ['bucket', 'file', 'isNew', 'project', 'seq', 'shipId', 'ts', 'type']);
  assert.deepEqual(ofType(events, 'build').map(pick(['project', 'bucket', 'file', 'shipId', 'isNew', 'ts'])), [
    { project: SLUG, bucket: 'src', file: path.join('src', 'a.js'), shipId: SHIP_ID, isNew: true, ts: T0 + 1 * SEC },
    { project: SLUG, bucket: 'src', file: path.join('src', 'b.js'), shipId: SHIP_ID, isNew: false, ts: T0 + 2 * SEC },
    { project: SLUG, bucket: '(root)', file: 'notes.md', shipId: SHIP_ID, isNew: true, ts: T0 + 3 * SEC },
  ]);
  assert.deepEqual(ofType(events, 'activity').map(pick(['tool', 'status', 'detail'])),
    [{ tool: 'Edit', status: 'Building', detail: 'x.js' }]);
  assert.deepEqual(ofType(events, 'feed').map((event) => [event.entry.kind, event.entry.text]), [
    ['form', 'Planet formation started: src in demo'],
    ['build', `Claude-1 building ${path.join('src', 'a.js')} in demo`],
    ['build', `Claude-1 building ${path.join('src', 'b.js')} in demo`],
    ['form', 'Planet formation started: (root) in demo'],
    ['build', 'Claude-1 building notes.md in demo'],
  ]);
  assert.equal(tracker.snapshot().projects[0].totalBuilds, 3);
  assert.deepEqual(tracker.getSystem(SLUG).planets, [
    { name: 'src', files: 0, builds: 2 },
    { name: '(root)', files: 0, builds: 1 },
  ]);
});

// Builds for a Windows-style project root (missing on disk, so any host works).
function windowsRootBuilds(t) {
  const root = 'C:\\Orrery-Fixture-Missing\\Demo';
  const session = startClaude(t);
  const file = session.world.claudeFile('C--Orrery-Fixture-Missing-Demo');
  appendJsonl(file, [claude.prompt(root, T0)], T0);
  session.tracker.scan(false);
  session.tracker.pollFiles(); // catch up, so the appended edits are live
  session.take();
  return ofType(appendAndPoll({ ...session, file }, [
    claude.tool(root, T0 + 1 * SEC, 'toolu_w1', 'Edit', { file_path: `${root}\\Docs\\Guide.md` }),
    claude.tool(root, T0 + 2 * SEC, 'toolu_w2', 'Edit', { file_path: 'c:/orrery-fixture-missing/demo/Src/A.js' }),
  ], T0 + 2 * SEC), 'build');
}

test('claude: build buckets under a Windows-style root are case-folded on any host (see the Windows planet todo)', (t) => {
  assert.deepEqual(windowsRootBuilds(t).map((event) => event.bucket), ['docs', 'src']);
});

test('claude: build file paths under a Windows-style root are lower-cased for display', {
  todo: 'suspected bug: relativeInside returns the lower-cased relative path (same root cause as the Windows planet todo)',
}, (t) => {
  assert.deepEqual(windowsRootBuilds(t).map((event) => event.file),
    [path.join('docs', 'guide.md'), path.join('src', 'a.js')]);
});

test('claude: a mixed-case top-level folder never shows its builds on its planet (Windows host)', {
  skip: process.platform !== 'win32' && 'needs a Windows-rooted project on disk',
  todo: 'suspected bug: relativeInside returns the lower-cased relative path, so bucket "docs" never matches planet "Docs"',
}, (t) => {
  const session = startClaude(t);
  fs.mkdirSync(path.join(session.dir, 'Docs'));
  appendAndPoll(session, [
    claude.tool(session.dir, T0 + 1 * SEC, 'toolu_d', 'Write', { file_path: path.join(session.dir, 'Docs', 'guide.md') }),
  ], T0 + 1 * SEC);
  assert.equal(session.tracker.snapshot().projects[0].totalBuilds, 1);
  assert.deepEqual(session.tracker.getSystem(SLUG).planets.find((planet) => planet.name === 'Docs'),
    { name: 'Docs', files: 0, builds: 0 });
});

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
    taskId: null, turnOutcome: null,
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

test('claude: a session resumed after 15 min idle is re-read from offset 0 and re-counts its old edits',
  { todo: 'suspected bug (.docs/architecture.md §10 #29): old edits are counted into persisted totals again, and the resumed session\'s new edit emits no build event' },
  (t) => {
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
    tracker.scan(false);
    tracker.pollFiles();
    const events = session.take();

    assert.equal(tracker.snapshot().projects[0].totalBuilds, 3, 'one old edit counted twice plus the new one');
    assert.deepEqual(ofType(events, 'build'), [], 'the whole file is replayed in catchup mode');
  });

// ---------- Codex ----------

test('codex: session_meta at startup creates a project keyed by canonical cwd and a codex ship', (t) => {
  const { world, file, tracker, startup } = startCodex(t);
  const projectId = `project:${hex8(canonicalProjectPath(world.projectDir))}`;

  assert.deepEqual(startup.map((event) => event.type), ['project-added', 'ship-spawned', 'feed']);
  assert.deepEqual(startup[0].project, {
    id: projectId, path: world.projectDir, name: 'demo', exists: true,
    firstSeen: T0, lastActivity: T0, totalBytes: 0, totalBuilds: 0,
    seed: fnv1a(projectId), galaxy: { key: 'workspace:demo', label: 'Demo' },
  });
  assert.deepEqual(startup[1].ship, {
    id: CODEX_SHIP_ID, name: 'Codex-1', project: projectId, kind: 'main', provider: 'codex',
    status: 'Working', detail: null, lastEvent: T0, attention: null, attentionSince: null,
    taskId: null, turnOutcome: null,
  });
  assert.equal(startup[2].entry.text, 'Codex-1 entered demo');
  assert.equal(tracker.snapshot().projects[0].totalBytes, fs.statSync(file).size,
    'codex bytes are folded in after the project-added event');
});

test('codex: a Claude project with the same cwd keeps its slug id and absorbs codex ships and bytes', (t) => {
  const world = createWorld(t);
  appendJsonl(world.claudeFile(), [claude.prompt(world.projectDir, T0)], T0);
  appendJsonl(world.codexFile(), [codex.meta(T0, CODEX_SESSION, world.projectDir)], T0);
  const { tracker, take } = world.live();
  tracker.scan(true);

  assert.deepEqual(ofType(take(), 'project-added').map((event) => event.project.id), [SLUG]);
  const snapshot = tracker.snapshot();
  assert.deepEqual(snapshot.ships.map((ship) => [ship.id, ship.project, ship.name]),
    [[SHIP_ID, SLUG, 'Claude-1'], [CODEX_SHIP_ID, SLUG, 'Codex-1']]);
  assert.equal(snapshot.projects[0].totalBytes,
    fs.statSync(world.claudeFile()).size + fs.statSync(world.codexFile()).size);
});

test('codex: function calls, patch builds (deduped by call id), turn lifecycle and the task marker', (t) => {
  const session = startCodex(t);
  const { dir, tracker } = session;
  const projectId = `project:${hex8(canonicalProjectPath(dir))}`;
  const events = appendAndPoll(session, [
    codex.event(T0 + 1 * SEC, 'task_started'),
    codex.userText(T0 + 2 * SEC, `Please do this.\nagent-universe:${TASK_ID.toUpperCase()}`),
    codex.call(T0 + 3 * SEC, 'call-exec', 'exec_command'),
    codex.output(T0 + 4 * SEC, 'call-exec'),
    codex.patchCall(T0 + 5 * SEC, 'call-patch'),
    codex.patched(T0 + 6 * SEC, 'call-patch', [
      path.join(dir, 'src', 'x.js'), path.join(dir, 'notes.md'), path.join(session.world.root, 'outside.js'),
    ]),
    codex.patched(T0 + 7 * SEC, 'call-patch', [path.join(dir, 'src', 'x.js')]),
    codex.patchOutput(T0 + 8 * SEC, 'call-patch'),
    codex.event(T0 + 9 * SEC, 'task_complete'),
  ], T0 + 9 * SEC);

  assert.deepEqual(events.map((event) => event.type), [
    'ship-updated', 'ship-updated',
    'ship-updated', 'activity', 'ship-updated',
    'ship-updated', 'activity',
    'build', 'feed', 'feed', 'build', 'feed', 'feed',
    'ship-updated', 'ship-updated',
  ]);
  assert.deepEqual(ofType(events, 'ship-updated').map((event) => pick(['status', 'taskId', 'turnOutcome'])(event.ship)), [
    { status: 'Working', taskId: null, turnOutcome: 'running' },
    { status: 'Working', taskId: TASK_ID, turnOutcome: 'running' },
    { status: 'Gathering Resources', taskId: TASK_ID, turnOutcome: 'running' },
    { status: 'Gathering Resources', taskId: TASK_ID, turnOutcome: 'running' },
    { status: 'Building', taskId: TASK_ID, turnOutcome: 'running' },
    { status: 'Building', taskId: TASK_ID, turnOutcome: 'running' },
    { status: 'Building', taskId: TASK_ID, turnOutcome: 'completed' },
  ]);
  assert.deepEqual(ofType(events, 'activity').map(pick(['project', 'shipId', 'tool', 'status', 'detail', 'ts'])), [
    { project: projectId, shipId: CODEX_SHIP_ID, tool: 'Bash', status: 'Gathering Resources', detail: null, ts: T0 + 3 * SEC },
    { project: projectId, shipId: CODEX_SHIP_ID, tool: 'Edit', status: 'Building', detail: null, ts: T0 + 5 * SEC },
  ]);
  assert.deepEqual(ofType(events, 'build').map(pick(['project', 'bucket', 'file', 'shipId', 'isNew', 'ts'])), [
    { project: projectId, bucket: 'src', file: path.join('src', 'x.js'), shipId: CODEX_SHIP_ID, isNew: true, ts: T0 + 6 * SEC },
    { project: projectId, bucket: '(root)', file: 'notes.md', shipId: CODEX_SHIP_ID, isNew: true, ts: T0 + 6 * SEC },
  ]);
  assert.equal(tracker.snapshot().projects[0].totalBuilds, 2);

  const done = pollAt(session, T0 + 19 * SEC);
  assert.deepEqual(done.map((event) => [event.type, event.ship && event.ship.attention]),
    [['ship-updated', 'done'], ['feed', undefined]]);
});

test('codex: turn_aborted marks the outcome aborted; malformed task markers are ignored', (t) => {
  const session = startCodex(t);
  appendAndPoll(session, [
    codex.userText(T0 + 1 * SEC, 'agent-universe:not-a-uuid'),
    codex.userText(T0 + 2 * SEC, `xagent-universe:${TASK_ID}`),
    codex.userText(T0 + 3 * SEC, `agent-universe:${TASK_ID.replace(/-4/, '-0')}`),
    codex.event(T0 + 4 * SEC, 'task_started'),
    codex.event(T0 + 5 * SEC, 'turn_aborted'),
  ], T0 + 5 * SEC);
  assert.deepEqual(pick(['status', 'taskId', 'turnOutcome'])(shipOf(session.tracker, CODEX_SHIP_ID)),
    { status: 'Working', taskId: null, turnOutcome: 'aborted' });
});

test('codex: a rollout resumed after 15 min idle continues from its previous offset (no re-count)', (t) => {
  const session = startCodex(t);
  const { dir, tracker } = session;
  appendAndPoll(session, [codex.patched(T0 + 1 * SEC, 'p1', [path.join(dir, 'src', 'a.js')])], T0 + 1 * SEC);
  pollAt(session, T0 + 1 * SEC + 15 * MIN + 1);

  const resumedAt = T0 + 20 * MIN;
  session.world.clock.set(resumedAt);
  appendJsonl(session.file, [codex.patched(resumedAt, 'p2', [path.join(dir, 'src', 'b.js')])], resumedAt);
  tracker.scan(false);
  tracker.pollFiles();
  assert.deepEqual(ofType(session.take(), 'build').map((event) => event.file), [path.join('src', 'b.js')]);
  assert.equal(tracker.snapshot().projects[0].totalBuilds, 2);
});

// Ported from kit/done/multi-provider/edge-validation.mjs.
test('codex adapter: records copied from a parent before the child session_meta are ignored', () => {
  const childId = '019f0000-0000-7000-8000-000000000055';
  const parentId = '019f0000-0000-7000-8000-000000000044';
  let state = createAdapterState('codex', { sessionId: childId });
  const adapt = (record) => {
    const result = adaptLine('codex', JSON.stringify(record), state, { now: T0 });
    state = result.state;
    return result.signals;
  };
  assert.deepEqual(adapt({ type: 'session_meta', payload: {
    id: parentId, session_id: parentId, cwd: 'C:\\parent', thread_source: 'user',
  } }), []);
  assert.deepEqual(adapt({ type: 'event_msg', payload: {
    type: 'patch_apply_end', success: true, call_id: 'parent-call',
    changes: { 'C:\\parent\\secret.js': { type: 'update' } },
  } }), []);
  const [session] = adapt({ type: 'session_meta', payload: {
    id: childId, session_id: parentId, cwd: 'C:\\child',
    source: { subagent: {} }, parent_thread_id: parentId,
  } });
  assert.deepEqual(session, { type: 'session', sessionId: childId, cwd: 'C:\\child', kind: 'drone', provider: 'codex', ts: T0 });
  assert.equal(state.parentSessionId, parentId);
});

test('codex: a forked child rollout found mid-run is a drone and skips its copied parent prefix', (t) => {
  const world = createWorld(t);
  const dir = world.projectDir;
  const parentId = '019f0000-0000-7000-8000-000000000044';
  const childId = '019f0000-0000-7000-8000-000000000055';
  appendJsonl(world.codexFile(parentId), [codex.meta(T0, parentId, dir)], T0);
  const { tracker, take } = world.live();
  tracker.scan(true);
  take();

  world.clock.set(T0 + 5 * SEC);
  appendJsonl(world.codexFile(childId), [
    codex.meta(T0 + 1 * SEC, parentId, dir),
    codex.patched(T0 + 2 * SEC, 'parent-call', [path.join(dir, 'src', 'parent.js')]),
    codex.meta(T0 + 3 * SEC, childId, dir, {
      session_id: parentId, thread_source: 'subagent', parent_thread_id: parentId,
    }),
    codex.patched(T0 + 4 * SEC, 'child-call', [path.join(dir, 'src', 'child.js')]),
  ], T0 + 5 * SEC);
  tracker.scan(false);
  tracker.pollFiles();

  const events = take();
  assert.deepEqual(ofType(events, 'ship-spawned').map((event) => pick(['id', 'kind', 'name'])(event.ship)),
    [{ id: `ship:codex:${childId}`, kind: 'drone', name: 'Codex-2' }]);
  assert.deepEqual(ofType(events, 'build'), [], 'a rollout found mid-run is read in catchup mode');
  assert.equal(tracker.snapshot().projects[0].totalBuilds, 1, 'only the child\'s own patch counts');
});

// Ported from kit/done/multi-provider/edge-validation.mjs.
test('codex: moving a rollout from sessions to archived_sessions keeps one ship and dedupes builds by call id', (t) => {
  const world = createWorld(t);
  const dir = world.projectDir;
  const activeFile = world.codexFile();
  const archiveFile = path.join(world.codexArchive, path.basename(activeFile));
  appendJsonl(activeFile, [codex.meta(T0, CODEX_SESSION, dir, { thread_source: undefined, source: 'cli' })], T0);
  const { tracker } = world.live({ codexSessionDirs: [world.codexRoot, world.codexArchive] });
  tracker.scan(true);
  const build = (callId, file, at) => [
    codex.patchCall(at, callId),
    codex.patched(at, callId, [path.join(dir, 'src', file)]),
    codex.patchOutput(at, callId),
  ];

  world.clock.set(T0 + 1 * SEC);
  appendJsonl(activeFile, build('build-one', 'one.js', T0 + 1 * SEC));
  tracker.pollFiles();
  assert.equal(tracker.snapshot().projects[0].totalBuilds, 1);

  fs.mkdirSync(world.codexArchive, { recursive: true });
  fs.renameSync(activeFile, archiveFile);
  tracker.scan(false);
  world.clock.set(T0 + 2 * SEC);
  appendJsonl(archiveFile, [
    ...build('build-one', 'one.js', T0 + 2 * SEC),
    ...build('build-two', 'two.js', T0 + 2 * SEC),
  ]);
  tracker.pollFiles();
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.projects[0].totalBuilds, 2);
  assert.deepEqual(snapshot.ships.map((ship) => ship.id), [CODEX_SHIP_ID]);
});

// Ported from kit/done/multi-provider/edge-validation.mjs.
test('classifyTool maps Codex tool names onto the shared status vocabulary', () => {
  const expected = [
    ['exec', 'Bash', 'Gathering Resources'],
    ['wait', 'Bash', 'Gathering Resources'],
    ['browser', 'WebSearch', 'Scanning'],
    ['create_goal', 'TodoWrite', 'Planning'],
    ['list_files', 'Read', 'Exploring'],
    ['request_user_input', 'AskUserQuestion', 'Working'],
  ];
  for (const [name, tool, status] of expected) {
    assert.deepEqual(classifyTool(name), { tool, status, build: false }, name);
  }
});

// ---------- Signal ----------

function signalWorld(t, { mtime = T0 } = {}) {
  const world = createWorld(t);
  const signalDir = path.join(world.root, 'signals');
  const signalFile = path.join(signalDir, 'private.log');
  fs.mkdirSync(signalDir, { recursive: true });
  fs.writeFileSync(signalFile, 'PRIVATE_GENERIC_BYTES');
  setMtime(signalFile, mtime);
  fs.mkdirSync(path.dirname(world.providerConfigPath), { recursive: true });
  fs.writeFileSync(world.providerConfigPath, JSON.stringify({
    watch: [{ directory: signalDir, projectPath: world.projectDir, label: 'Fixture' }],
  }));
  const sourceId = `watch-${hex8(canonicalProjectPath(signalDir))}`;
  const shipId = `ship:generic:${sourceId}:${hex8(canonicalProjectPath(signalFile))}`;
  return { world, signalDir, signalFile, shipId };
}

// Records (rather than throws, which the tracker would swallow) any read of watched files.
function recordSignalReads(t, signalDir) {
  const reads = [];
  const inside = (file) => typeof file === 'string' && path.resolve(file).startsWith(signalDir + path.sep);
  const readFileSync = fs.readFileSync;
  const openSync = fs.openSync;
  const createReadStream = fs.createReadStream;
  t.mock.method(fs, 'readFileSync', function (file, ...args) {
    if (inside(file)) reads.push(['readFileSync', file]);
    return readFileSync.call(this, file, ...args);
  });
  t.mock.method(fs, 'openSync', function (file, flags, ...args) {
    if (inside(file) && (flags === undefined || /^r/.test(String(flags)))) reads.push(['openSync', file]);
    return openSync.call(this, file, flags, ...args);
  });
  t.mock.method(fs, 'createReadStream', function (file, ...args) {
    if (inside(file)) reads.push(['createReadStream', file]);
    return createReadStream.call(this, file, ...args);
  });
  return reads;
}

// Ported from kit/done/multi-provider/edge-validation.mjs.
test('signal: a watched file docks a generic ship from stat alone; its contents are never read', (t) => {
  const { world, signalDir, signalFile, shipId } = signalWorld(t);
  const reads = recordSignalReads(t, signalDir);
  fs.closeSync(fs.openSync(signalFile, 'r'));
  assert.equal(reads.length, 1, 'the read guard sees a direct read');
  reads.length = 0;
  const { tracker, take } = world.live();
  const projectId = `project:${hex8(canonicalProjectPath(world.projectDir))}`;

  tracker.scan(true);
  const startup = take();
  assert.deepEqual(startup.map((event) => event.type), ['project-added', 'ship-spawned', 'feed']);
  assert.deepEqual(startup[1].ship, {
    id: shipId, name: 'Signal-1', project: projectId, kind: 'main', provider: 'generic',
    status: 'Working', detail: null, lastEvent: T0, attention: null, attentionSince: null,
    taskId: null, turnOutcome: null,
  });

  world.clock.set(T0 + 5 * SEC);
  fs.appendFileSync(signalFile, 'MORE_PRIVATE_BYTES');
  setMtime(signalFile, T0 + 5 * SEC);
  tracker.scan(false);
  const changed = take();
  assert.deepEqual(changed.map((event) => event.type), ['ship-updated', 'activity']);
  assert.deepEqual(pick(['project', 'shipId', 'tool', 'status', 'detail', 'ts'])(changed[1]),
    { project: projectId, shipId, tool: 'signal', status: 'Working', detail: null, ts: T0 + 5 * SEC });

  tracker.scan(false);
  assert.deepEqual(take(), [], 'an unchanged file emits nothing');

  fs.rmSync(signalFile);
  world.clock.set(T0 + 6 * SEC);
  tracker.scan(false);
  const gone = take();
  assert.deepEqual(gone.map((event) => event.type), ['ship-departed', 'feed']);
  assert.deepEqual(pick(['shipId', 'ts'])(gone[0]), { shipId, ts: T0 + 6 * SEC });
  assert.equal(gone[1].entry.text, 'Signal-1 signal disappeared');

  assert.deepEqual(reads, []);
});

test('signal: ships for files idle 5-15 min are swept every sweep and respawned every scan',
  { todo: 'suspected bug (.docs/architecture.md §10 #30): Signal ships flap and are renamed on every scan' },
  (t) => {
    const { world } = signalWorld(t, { mtime: T0 - 7 * MIN });
    const session = { world, ...world.live() };
    const spawned = [];
    for (let round = 0; round < 2; round++) {
      session.tracker.scan(false);
      const events = session.take();
      spawned.push(...ofType(events, 'ship-spawned').map((event) => event.ship.name));
      assert.deepEqual(ofType(sweepAt(session, T0), 'ship-departed').length, 1, `round ${round}`);
    }
    assert.deepEqual(spawned, ['Signal-1', 'Signal-2']);
  });

// ---------- Derived views and persistence ----------

test('snapshot(), getSystem() and getPlanet() public shapes for a project on disk', (t) => {
  const world = createWorld(t);
  const dir = world.projectDir;
  for (const [rel, text] of [
    ['src/a.js', 'a'], ['src/b.js', 'b'], ['src/nested/c.js', 'c'], ['docs/guide.md', 'g'],
    ['README.md', 'r'], ['NOTES.md', 'n'], ['package.json', '{}'],
    ['node_modules/pkg/index.js', 'x'], ['.git/HEAD', 'x'],
  ]) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  appendJsonl(world.claudeFile(), [claude.prompt(dir, T0)], T0);
  const session = { world, file: world.claudeFile(), ...world.live() };
  session.tracker.scan(true);
  const events = [...session.take(), ...appendAndPoll(session, [
    claude.tool(dir, T0 + 1 * SEC, 'toolu_e1', 'Edit', { file_path: path.join(dir, 'src', 'a.js') }),
    claude.tool(dir, T0 + 2 * SEC, 'toolu_e2', 'Edit', { file_path: path.join(dir, 'src', 'a.js') }),
    claude.tool(dir, T0 + 3 * SEC, 'toolu_e3', 'Edit', { file_path: path.join(dir, 'README.md') }),
  ], T0 + 3 * SEC)];
  const { tracker } = session;

  const snapshot = tracker.snapshot();
  assert.deepEqual(Object.keys(snapshot).sort(), ['eventSequence', 'feed', 'projects', 'ships']);
  assert.equal(snapshot.eventSequence, events.at(-1).seq);
  assert.deepEqual(Object.keys(snapshot.projects[0]).sort(), PROJECT_KEYS);
  assert.deepEqual(Object.keys(snapshot.ships[0]).sort(), SHIP_KEYS);
  assert.deepEqual(snapshot.feed, ofType(events, 'feed').map((event) => event.entry));

  const system = tracker.getSystem(SLUG);
  assert.deepEqual(system, {
    project: snapshot.projects[0],
    planets: [
      { name: 'src', files: 3, builds: 2 },
      { name: '(root)', files: 3, builds: 1 },
      { name: 'docs', files: 1, builds: 0 },
    ],
    beltDensity: 3,
  });
  assert.equal(tracker.getSystem('missing'), null);

  assert.deepEqual(tracker.getPlanet(SLUG, 'src'), {
    name: 'src', project: snapshot.projects[0], builds: 2, files: 3, sizeKb: 0, subdirs: 1, resources: ['JS'],
  });
  assert.deepEqual(tracker.getPlanet(SLUG, '(root)'), {
    name: '(root)', project: snapshot.projects[0], builds: 1, files: 3, sizeKb: 0, subdirs: 2, resources: ['MD', 'JSON'],
  });
  const sector = tracker.getPlanet(SLUG, 'Sector-1');
  assert.equal(sector.procedural, true);
  assert.deepEqual(sector.resources, ['Unknown']);
  assert.equal(tracker.getPlanet('missing', 'src'), null);
});

test('getSystem() and getPlanet() fall back to deterministic procedural planets for a missing path', (t) => {
  const world = createWorld(t);
  const gone = path.join(world.root, 'workspace', 'gone');
  appendJsonl(world.claudeFile(), [claude.prompt(gone, T0)], T0);
  const first = world.live().tracker;
  const second = world.live().tracker;
  first.scan(true);
  second.scan(true);

  const project = first.snapshot().projects[0];
  assert.deepEqual(pick(['path', 'name', 'exists', 'galaxy'])(project),
    { path: gone, name: 'gone', exists: false, galaxy: { key: 'graveyard', label: 'Graveyard' } });
  const system = first.getSystem(SLUG);
  assert.ok(system.planets.length >= 3 && system.planets.length <= 6, String(system.planets.length));
  system.planets.forEach((planet, index) => {
    assert.deepEqual(Object.keys(planet).sort(), ['builds', 'files', 'name', 'procedural']);
    assert.equal(planet.name, `Sector-${index + 1}`);
    assert.equal(planet.builds, 0);
    assert.equal(planet.procedural, true);
  });
  assert.deepEqual(second.getSystem(SLUG), system, 'seeded only by the project id');

  const planet = first.getPlanet(SLUG, 'src');
  assert.deepEqual(Object.keys(planet).sort(),
    ['builds', 'files', 'name', 'procedural', 'project', 'resources', 'sizeKb', 'subdirs']);
  assert.deepEqual(second.getPlanet(SLUG, 'src'), planet);
});

test('saveState()/loadState() round-trip buckets, totals, firstSeen and path ids', (t) => {
  const world = createWorld(t);
  const dir = world.projectDir;
  appendJsonl(world.claudeFile(), [claude.prompt(dir, T0)], T0);
  const session = { world, file: world.claudeFile(), ...world.live() };
  session.tracker.scan(true);
  appendAndPoll(session, [
    claude.tool(dir, T0 + 1 * SEC, 'toolu_e1', 'Edit', { file_path: path.join(dir, 'src', 'a.js') }),
    claude.tool(dir, T0 + 2 * SEC, 'toolu_e2', 'Write', { file_path: path.join(dir, 'src', 'b.js') }),
  ], T0 + 2 * SEC);
  assert.equal(session.tracker.saveState(), true);

  assert.deepEqual(JSON.parse(fs.readFileSync(world.statePath, 'utf8')), {
    projects: { [SLUG]: { buckets: { src: 2 }, totalBuilds: 2, firstSeen: T0 } },
    pathIds: { [canonicalProjectPath(dir)]: SLUG },
    pathOverrides: {},
  });
  assert.deepEqual(fs.readdirSync(path.dirname(world.statePath)), ['universe-state.json'],
    'the temp file is renamed into place');

  // A later run that only sees a Codex rollout for the same cwd reuses the saved id and totals.
  world.clock.set(T0 + 10 * MIN);
  appendJsonl(world.codexFile(), [codex.meta(T0 + 10 * MIN, CODEX_SESSION, dir)], T0 + 10 * MIN);
  const restored = world.live({ claudeProjectsDir: path.join(world.root, 'no-claude') }).tracker;
  restored.scan(true);
  const project = restored.snapshot().projects[0];
  assert.deepEqual(pick(['id', 'totalBuilds', 'firstSeen'])(project), { id: SLUG, totalBuilds: 2, firstSeen: T0 });
  assert.deepEqual(restored.getSystem(SLUG).planets.find((planet) => planet.name === 'src').builds, 2);
});

test('loadState() treats an unreadable state file as empty', (t) => {
  const world = createWorld(t);
  fs.mkdirSync(path.dirname(world.statePath), { recursive: true });
  fs.writeFileSync(world.statePath, 'not json');
  const { tracker } = world.live();
  assert.deepEqual(tracker.persisted, { projects: {} });
});

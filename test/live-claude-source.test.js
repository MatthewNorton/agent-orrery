'use strict';

// src/main/live/claude-source.js, through the Tracker: a Claude transcript's discovery, tools and
// builds. Part of the characterization of the live model in tracker.test.js: it pins behaviour as
// it is.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  SEC, MIN, T0, SLUG, SHIP_ID, fnv1a, appendJsonl, createWorld, ofType, pick, claude,
} = require('./support/transcripts');
const { PROJECT_KEYS, SHIP_KEYS, startClaude, appendAndPoll } = require('./support/live-session');

test('claude: startup discovers the project from slug dir + cwd and docks a ship without replaying history', (t) => {
  const { world, file, tracker, take, startup } = startClaude(t);

  assert.deepEqual(startup.map((event) => event.type), ['project-added', 'ship-spawned', 'feed']);
  assert.deepEqual(startup.map((event) => event.seq), [1, 2, 3]);
  assert.deepEqual(Object.keys(startup[0].project).sort(), PROJECT_KEYS);
  assert.deepEqual(startup[0].project, {
    id: SLUG, path: world.projectDir, name: 'demo', exists: true,
    firstSeen: T0, lastActivity: T0, totalBytes: fs.statSync(file).size, totalBuilds: 0,
    seed: fnv1a(SLUG), galaxy: { key: 'workspace:demo', label: 'Demo' }, planets: [],
  });
  assert.deepEqual(Object.keys(startup[1].ship).sort(), SHIP_KEYS);
  assert.deepEqual(startup[1].ship, {
    id: SHIP_ID, name: 'Claude-1', project: SLUG, kind: 'main', provider: 'claude',
    status: 'Working', detail: null, lastEvent: T0, attention: null, attentionSince: null,
    builds: 0, local: false, model: null, taskId: null, turnOutcome: null,
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
  assert.deepEqual(snapshot.ships.map((ship) => [ship.id, ship.status, ship.detail, ship.builds]),
    [[SHIP_ID, 'Delegating', 'Survey', 1]], 'catchup builds count toward the ship too');

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
    ['bucket', 'file', 'isNew', 'key', 'project', 'seq', 'shipId', 'ts', 'type']);
  assert.deepEqual(ofType(events, 'build').map(pick(['project', 'bucket', 'key', 'file', 'shipId', 'isNew', 'ts'])), [
    { project: SLUG, bucket: 'src', key: 'src', file: path.join('src', 'a.js'), shipId: SHIP_ID, isNew: true, ts: T0 + 1 * SEC },
    { project: SLUG, bucket: 'src', key: 'src', file: path.join('src', 'b.js'), shipId: SHIP_ID, isNew: false, ts: T0 + 2 * SEC },
    { project: SLUG, bucket: '(root)', key: '(root)', file: 'notes.md', shipId: SHIP_ID, isNew: true, ts: T0 + 3 * SEC },
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
  assert.equal(tracker.snapshot().ships[0].builds, 3, 'the out-of-project edit is not a build');
  // ship-updated is queued before the build it announces, so it carries the
  // previous count; the renderer counts build events itself.
  assert.deepEqual(ofType(events, 'ship-updated').map((event) => event.ship.builds), [0, 1, 2, 3]);
  assert.deepEqual(tracker.getSystem(SLUG).planets, [
    { name: 'src', key: 'src', files: 0, builds: 2 },
    { name: '(root)', key: '(root)', files: 0, builds: 1 },
  ]);
});

const WINDOWS_ROOT = 'C:\\Orrery-Fixture-Missing\\Demo';
const WINDOWS_SLUG = 'C--Orrery-Fixture-Missing-Demo';

// Builds for a Windows-style project root (missing on disk, so any host works).
function windowsRootBuilds(t, saved) {
  const session = startClaude(t, { saved });
  const file = session.world.claudeFile(WINDOWS_SLUG);
  appendJsonl(file, [claude.prompt(WINDOWS_ROOT, T0)], T0);
  session.tracker.scan(false);
  session.tracker.pollFiles(); // catch up, so the appended edits are live
  session.take();
  const builds = ofType(appendAndPoll({ ...session, file }, [
    claude.tool(WINDOWS_ROOT, T0 + 1 * SEC, 'toolu_w1', 'Edit', { file_path: `${WINDOWS_ROOT}\\Docs\\Guide.md` }),
    claude.tool(WINDOWS_ROOT, T0 + 2 * SEC, 'toolu_w2', 'Edit', { file_path: 'c:/orrery-fixture-missing/demo/Src/A.js' }),
  ], T0 + 2 * SEC), 'build');
  return { ...session, builds };
}

test('claude: build buckets under a Windows-style root keep the folder\'s own casing on any host', (t) => {
  assert.deepEqual(windowsRootBuilds(t).builds.map((event) => event.bucket), ['Docs', 'Src']);
});

test('claude: build file paths under a Windows-style root keep their own casing', (t) => {
  assert.deepEqual(windowsRootBuilds(t).builds.map((event) => event.file),
    [path.join('Docs', 'Guide.md'), path.join('Src', 'A.js')]);
});

test('claude: under a Windows-style root, builds merge into the lower-cased buckets earlier versions saved', async (t) => {
  const { world, tracker, builds } = windowsRootBuilds(t, {
    [WINDOWS_SLUG]: { buckets: { docs: 2 }, totalBuilds: 2, firstSeen: T0 - MIN },
  });
  assert.deepEqual(builds.map(pick(['bucket', 'isNew'])),
    [{ bucket: 'Docs', isNew: false }, { bucket: 'Src', isNew: true }]);
  const planets = await Promise.all(['Docs', 'docs', 'DOCS'].map((name) => tracker.getPlanet(WINDOWS_SLUG, name)));
  assert.deepEqual(planets.map((planet) => planet.builds), [3, 3, 3]);
  tracker.saveState();
  const saved = JSON.parse(fs.readFileSync(world.statePath, 'utf8')).projects[WINDOWS_SLUG];
  assert.deepEqual(pick(['buckets', 'totalBuilds'])(saved), { buckets: { docs: 3, Src: 1 }, totalBuilds: 4 },
    'one bucket per folder: the saved key is kept, not split');
});

test('claude: a mixed-case top-level folder shows its builds on its planet (Windows host)', {
  skip: process.platform !== 'win32' && 'needs a Windows-rooted project on disk',
}, (t) => {
  const session = startClaude(t);
  fs.mkdirSync(path.join(session.dir, 'Docs'));
  appendAndPoll(session, [
    claude.tool(session.dir, T0 + 1 * SEC, 'toolu_d', 'Write', { file_path: path.join(session.dir, 'Docs', 'guide.md') }),
  ], T0 + 1 * SEC);
  assert.equal(session.tracker.snapshot().projects[0].totalBuilds, 1);
  assert.deepEqual(session.tracker.getSystem(SLUG).planets.find((planet) => planet.name === 'Docs'),
    { name: 'Docs', key: 'docs', files: 0, builds: 1 });
});

test('claude: a lower-cased saved bucket and new builds share the folder\'s on-disk planet (Windows host)', {
  skip: process.platform !== 'win32' && 'needs a Windows-rooted project on disk',
}, async (t) => {
  const session = startClaude(t, { saved: { [SLUG]: { buckets: { docs: 2 }, totalBuilds: 2, firstSeen: T0 - MIN } } });
  fs.mkdirSync(path.join(session.dir, 'Docs'));
  const events = appendAndPoll(session, [
    claude.tool(session.dir, T0 + 1 * SEC, 'toolu_d', 'Write', { file_path: path.join(session.dir, 'Docs', 'guide.md') }),
  ], T0 + 1 * SEC);
  // The build, the system's planet and the planet itself carry one key, whatever casing each has.
  assert.deepEqual(ofType(events, 'build').map(pick(['bucket', 'key', 'file', 'isNew'])),
    [{ bucket: 'Docs', key: 'docs', file: path.join('Docs', 'guide.md'), isNew: false }]);
  assert.deepEqual(session.tracker.getSystem(SLUG).planets.filter((planet) => planet.name.toLowerCase() === 'docs'),
    [{ name: 'Docs', key: 'docs', files: 0, builds: 3 }]);
  // Asked for by the saved key, as the Go to palette's Folder row does: the planet the system draws.
  assert.deepEqual(pick(['name', 'key', 'builds'])(await session.tracker.getPlanet(SLUG, 'docs')), { name: 'Docs', key: 'docs', builds: 3 });
});

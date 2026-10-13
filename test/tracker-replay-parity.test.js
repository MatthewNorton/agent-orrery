'use strict';

// Feeds the same transcript to the live Tracker and to the history
// ReplaySource. "agree:" tests pin what both models already share;
// "differs:" tests name a divergence that exists today, so the parser merge
// can change each one deliberately rather than by accident.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalProjectPath } = require('../src/main/provider-adapters');
const {
  SEC, T0, SLUG, CLAUDE_SESSION, CODEX_SESSION, TASK_ID,
  hex8, appendJsonl, createWorld, ofType, countTypes, claude, codex,
} = require('./support/transcripts');

const SHIP_ID = `ship:${SLUG}:${CLAUDE_SESSION}`;
const CODEX_SHIP_ID = `ship:codex:${CODEX_SESSION}`;
const pick = (keys) => (item) => Object.fromEntries(keys.map((key) => [key, item[key]]));

function claudeSession(dir, root) {
  return [
    claude.prompt(dir, T0),
    claude.tool(dir, T0 + 1 * SEC, 'toolu_read', 'Read', { file_path: path.join(dir, 'src', 'a.js') }),
    claude.result(dir, T0 + 2 * SEC, 'toolu_read'),
    claude.tool(dir, T0 + 3 * SEC, 'toolu_edit', 'Edit', { file_path: path.join(dir, 'src', 'a.js') }),
    claude.result(dir, T0 + 4 * SEC, 'toolu_edit'),
    claude.tool(dir, T0 + 5 * SEC, 'toolu_write', 'Write', { file_path: path.join(dir, 'notes.md') }),
    claude.result(dir, T0 + 6 * SEC, 'toolu_write'),
    claude.tool(dir, T0 + 7 * SEC, 'toolu_out', 'Edit', { file_path: path.join(root, 'elsewhere', 'x.js') }),
    claude.result(dir, T0 + 8 * SEC, 'toolu_out'),
    claude.tool(dir, T0 + 9 * SEC, 'toolu_mcp', 'mcp__probe__lookup', {}),
    claude.result(dir, T0 + 10 * SEC, 'toolu_mcp'),
    claude.tool(dir, T0 + 11 * SEC, 'toolu_task', 'Task', { description: 'Survey' }),
    claude.result(dir, T0 + 12 * SEC, 'toolu_task'),
    claude.turnDone(dir, T0 + 13 * SEC),
    claude.prompt(dir, T0 + 14 * SEC, 'next'),
  ];
}

function codexSession(dir) {
  return [
    codex.meta(T0, CODEX_SESSION, dir),
    codex.event(T0 + 1 * SEC, 'task_started'),
    codex.userText(T0 + 2 * SEC, `agent-universe:${TASK_ID}`),
    codex.call(T0 + 3 * SEC, 'call-exec', 'exec_command'),
    codex.output(T0 + 4 * SEC, 'call-exec'),
    codex.patchCall(T0 + 5 * SEC, 'call-patch'),
    codex.patched(T0 + 6 * SEC, 'call-patch', [path.join(dir, 'src', 'x.js')]),
    codex.patchOutput(T0 + 7 * SEC, 'call-patch'),
    codex.event(T0 + 8 * SEC, 'task_complete'),
  ];
}

// Live sees the first record at startup (tailed from EOF) and the rest in one
// poll at the last record's time; replay seeks to the first record and
// advances to the same time.
async function runBoth(t, { provider = 'claude', records, cwd } = {}) {
  const world = createWorld(t);
  const build = records || (provider === 'claude' ? claudeSession : codexSession);
  const lines = build(cwd || world.projectDir, world.root);
  const end = Date.parse(lines.at(-1).timestamp);
  const file = provider === 'claude' ? world.claudeFile() : world.codexFile();

  appendJsonl(file, lines.slice(0, 1), T0);
  const startupBytes = fs.statSync(file).size;
  const live = world.live();
  live.tracker.scan(true);
  live.take();
  world.clock.set(end);
  appendJsonl(file, lines.slice(1), end);
  live.tracker.pollFiles();
  const liveEvents = live.take();

  const replay = world.replay();
  await replay.source.index();
  await replay.source.seek(T0);
  replay.take();
  await replay.source.advanceTo(end);
  const replayEvents = replay.take();

  return {
    world,
    startupBytes,
    live: { tracker: live.tracker, events: liveEvents, snapshot: live.tracker.snapshot() },
    replay: { source: replay.source, events: replayEvents, snapshot: replay.source.snapshot() },
  };
}

// ---------- Claude: where the models agree ----------

test('agree: claude project id, path, seed and ship identity', async (t) => {
  const { live, replay } = await runBoth(t);
  const project = pick(['id', 'path', 'name', 'exists', 'seed', 'totalBuilds', 'lastActivity']);
  assert.deepEqual(project(replay.snapshot.projects[0]), project(live.snapshot.projects[0]));
  assert.equal(live.snapshot.projects[0].id, SLUG);

  const ship = pick(['id', 'name', 'project', 'kind', 'provider', 'lastEvent', 'attention', 'attentionSince', 'builds']);
  assert.deepEqual(replay.snapshot.ships.map(ship), live.snapshot.ships.map(ship));
  assert.equal(live.snapshot.ships[0].builds, 2, 'the out-of-project edit is not a build');
  assert.deepEqual(live.snapshot.ships.map((item) => [item.id, item.name, item.provider]),
    [[SHIP_ID, 'Claude-1', 'claude']]);
});

test('agree: claude build events (project, bucket, isNew, ship, ts) and totals', async (t) => {
  const { live, replay } = await runBoth(t);
  const build = pick(['project', 'bucket', 'isNew', 'shipId', 'ts']);
  assert.deepEqual(ofType(replay.events, 'build').map(build), ofType(live.events, 'build').map(build));
  assert.deepEqual(ofType(live.events, 'build').map(build), [
    { project: SLUG, bucket: 'src', isNew: true, shipId: SHIP_ID, ts: T0 + 3 * SEC },
    { project: SLUG, bucket: '(root)', isNew: true, shipId: SHIP_ID, ts: T0 + 5 * SEC },
  ]);
  assert.equal(live.snapshot.projects[0].totalBuilds, 2);
  assert.equal(replay.snapshot.projects[0].totalBuilds, 2);
});

test('agree: Task launches a drone named from the shared counter and docks it on tool_result', async (t) => {
  const { live, replay } = await runBoth(t);
  for (const side of [live, replay]) {
    assert.deepEqual(
      ofType(side.events, 'ship-spawned').map((event) => pick(['name', 'kind', 'provider', 'project'])(event.ship)),
      [{ name: 'Claude-2', kind: 'drone', provider: 'claude', project: SLUG }]);
    assert.equal(ofType(side.events, 'ship-departed').length, 1);
    assert.deepEqual(
      ofType(side.events, 'feed').map((event) => event.entry.text).filter((text) => /launched|returned/.test(text)),
      ['Claude-1 launched Claude-2 in demo', 'Claude-2 returned to Claude-1']);
  }
});

test('agree: activity tool and status for Read, out-of-project Edit and Task', async (t) => {
  const { live, replay } = await runBoth(t);
  const shared = (events) => ofType(events, 'activity')
    .filter((event) => [T0 + 1 * SEC, T0 + 7 * SEC, T0 + 11 * SEC].includes(event.ts))
    .map(pick(['project', 'shipId', 'tool', 'status', 'ts']));
  assert.deepEqual(shared(replay.events), shared(live.events));
  assert.deepEqual(shared(live.events).map((event) => [event.tool, event.status]),
    [['Read', 'Exploring'], ['Edit', 'Building'], ['Task', 'Delegating']]);
});

function windowsRootBoth(t) {
  const records = (dir) => [
    claude.prompt(dir, T0),
    claude.tool(dir, T0 + 1 * SEC, 'toolu_doc', 'Write', { file_path: `${dir}\\Docs\\Guide.md` }),
  ];
  return runBoth(t, { records, cwd: 'C:\\Orrery-Fixture-Missing\\Demo' });
}

test('agree: buckets keep the folder\'s casing under a Windows-style root in both models', async (t) => {
  const { live, replay } = await windowsRootBoth(t);
  assert.deepEqual(ofType(live.events, 'build').map((event) => event.bucket), ['Docs']);
  assert.deepEqual(ofType(replay.events, 'build').map((event) => event.bucket), ['Docs']);
});

test('agree: both models keep the build file\'s casing under a Windows-style root', async (t) => {
  const { live, replay } = await windowsRootBoth(t);
  assert.deepEqual(ofType(live.events, 'build').map((event) => event.file), [path.join('Docs', 'Guide.md')]);
  assert.deepEqual(ofType(replay.events, 'build').map((event) => event.file), ['Docs/Guide.md']);
});

test('agree: one folder written in two casings under a Windows-style root keeps one bucket in both models', async (t) => {
  const { live, replay } = await runBoth(t, {
    cwd: 'C:\\Orrery-Fixture-Missing\\Demo',
    records: (dir) => [
      claude.prompt(dir, T0),
      claude.tool(dir, T0 + 1 * SEC, 'toolu_a', 'Write', { file_path: `${dir}\\Docs\\a.md` }),
      claude.tool(dir, T0 + 2 * SEC, 'toolu_b', 'Write', { file_path: `${dir}\\docs\\b.md` }),
    ],
  });
  for (const side of [live, replay]) {
    assert.deepEqual(ofType(side.events, 'build').map(pick(['bucket', 'isNew'])),
      [{ bucket: 'Docs', isNew: true }, { bucket: 'docs', isNew: false }]);
  }
  assert.equal(live.tracker.getPlanet(SLUG, 'DOCS').builds, 2);
  assert.deepEqual(replay.snapshot.projects[0].buckets, { Docs: 2 });
  assert.equal(replay.source.getPlanet(SLUG, 'DOCS').builds, 2);
});

// ---------- Claude: where the models differ today ----------

test('differs: event volume — replay adds project-updated per record and ship-updated per turn/tool boundary', async (t) => {
  const { live, replay } = await runBoth(t);
  assert.deepEqual(countTypes(live.events), {
    'ship-updated': 6, activity: 4, build: 2, feed: 6, 'ship-spawned': 1, 'ship-departed': 1,
  });
  assert.deepEqual(countTypes(replay.events), {
    'project-updated': 14, 'ship-updated': 20, activity: 6, build: 2, feed: 6, 'ship-spawned': 1, 'ship-departed': 1,
  });
});

test('differs: in-project edits emit activity + build in replay but build only in live', async (t) => {
  const { live, replay } = await runBoth(t);
  assert.deepEqual(ofType(live.events, 'activity').map((event) => event.tool),
    ['Read', 'Edit', 'mcp__probe__lookup', 'Task']);
  assert.deepEqual(ofType(replay.events, 'activity').map((event) => event.tool),
    ['Read', 'Edit', 'Write', 'Edit', 'Tool', 'Task']);
});

test('differs: unknown tool names stay raw in live but collapse to "Tool" in replay', async (t) => {
  const { live, replay } = await runBoth(t);
  const at = (events) => ofType(events, 'activity').find((event) => event.ts === T0 + 9 * SEC);
  assert.deepEqual(pick(['tool', 'status'])(at(live.events)), { tool: 'mcp__probe__lookup', status: 'Working' });
  assert.deepEqual(pick(['tool', 'status'])(at(replay.events)), { tool: 'Tool', status: 'Working' });
});

test('differs: detail carries file/pattern/description in live and is always null in replay', async (t) => {
  const { live, replay } = await runBoth(t);
  assert.deepEqual(ofType(live.events, 'activity').map((event) => event.detail),
    [path.join('src', 'a.js'), 'x.js', null, 'Survey']);
  assert.ok(ofType(live.events, 'ship-updated').some((event) => event.ship.detail !== null));
  assert.ok(ofType(replay.events, 'activity').every((event) => event.detail === null));
  assert.ok(ofType(replay.events, 'ship-updated').every((event) => event.ship.detail === null));
});

test('differs: build file and feed text use path.sep in live and "/" in replay', async (t) => {
  const { live, replay } = await runBoth(t);
  assert.deepEqual(ofType(live.events, 'build').map((event) => event.file), [path.join('src', 'a.js'), 'notes.md']);
  assert.deepEqual(ofType(replay.events, 'build').map((event) => event.file), ['src/a.js', 'notes.md']);
  const buildText = (events) => ofType(events, 'feed').map((event) => event.entry.text)
    .find((text) => text.startsWith('Claude-1 building src'));
  assert.equal(buildText(live.events), `Claude-1 building ${path.join('src', 'a.js')} in demo`);
  assert.equal(buildText(replay.events), 'Claude-1 building src/a.js in demo');
});

test('differs: drone id is drone:<toolUseId> in live and drone:claude:<session>:<callId> in replay', async (t) => {
  const { live, replay } = await runBoth(t);
  assert.deepEqual(ofType(live.events, 'ship-spawned').map((event) => event.ship.id), ['drone:toolu_task']);
  assert.deepEqual(ofType(replay.events, 'ship-spawned').map((event) => event.ship.id),
    [`drone:claude:${CLAUDE_SESSION}:toolu_task`]);
});

test('differs: galaxy is path-derived in live and history:<hash of parent> in replay', async (t) => {
  const { live, replay } = await runBoth(t);
  assert.deepEqual(live.snapshot.projects[0].galaxy, { key: 'workspace:demo', label: 'Demo' });
  assert.match(replay.snapshot.projects[0].galaxy.key, /^history:[0-9a-f]{8}$/);
  assert.equal(replay.snapshot.projects[0].galaxy.label, 'Workspace');
});

test('differs: replay projects add a buckets key; replay ships have no taskId/turnOutcome keys', async (t) => {
  const { live, replay } = await runBoth(t);
  const keys = (value) => Object.keys(value).sort();
  assert.deepEqual(keys(replay.snapshot.projects[0]), [...keys(live.snapshot.projects[0]), 'buckets'].sort());
  assert.deepEqual(replay.snapshot.projects[0].buckets, { src: 1, '(root)': 1 });
  assert.deepEqual(keys(live.snapshot.ships[0]).filter((key) => !(key in replay.snapshot.ships[0])),
    ['taskId', 'turnOutcome']);
});

test('differs: turn boundaries — replay resets status to Working and emits ship-updated; live is silent', async (t) => {
  const { live, replay } = await runBoth(t);
  assert.equal(live.snapshot.ships[0].status, 'Delegating', 'live keeps the last tool status across turns');
  assert.deepEqual(live.events.slice(-2).map((event) => event.type), ['ship-departed', 'feed'],
    'nothing after the drone docks: turn_duration and the next prompt queue no event');
  assert.equal(replay.snapshot.ships[0].status, 'Working');
  assert.deepEqual(ofType(replay.events, 'ship-updated').slice(-2).map((event) => event.ship.status),
    ['Delegating', 'Working'], 'turn_duration, then the next prompt, each emit a ship-updated in replay');
});

test('differs: totalBytes — live reports transcript bytes as of the last scan, replay always 0', async (t) => {
  const { startupBytes, live, replay } = await runBoth(t);
  assert.equal(live.snapshot.projects[0].totalBytes, startupBytes);
  assert.equal(replay.snapshot.projects[0].totalBytes, 0);
});

test('differs: firstSeen — live uses the discovery time, replay the first record', async (t) => {
  const world = createWorld(t);
  appendJsonl(world.claudeFile(), [claude.prompt(world.projectDir, T0 - 2 * 60 * SEC)], T0 - 2 * 60 * SEC);
  const { tracker } = world.live();
  tracker.scan(true);
  assert.equal(tracker.snapshot().projects[0].firstSeen, T0);
  const snapshot = await world.replay().source.seek(T0);
  assert.equal(snapshot.projects[0].firstSeen, T0 - 2 * 60 * SEC);
});

test('differs: feed timestamps — live stamps Date.now() at parse time, replay the record time', async (t) => {
  const { live, replay } = await runBoth(t);
  const stamps = (events) => [...new Set(ofType(events, 'feed').map((event) => event.entry.ts))];
  assert.deepEqual(stamps(live.events), [T0 + 14 * SEC]);
  assert.deepEqual(stamps(replay.events), [T0 + 3 * SEC, T0 + 5 * SEC, T0 + 11 * SEC, T0 + 12 * SEC]);
});

test('differs: getSystem — live lists folders on disk, replay lists build buckets with files 0', async (t) => {
  const { world, live, replay } = await runBoth(t);
  fs.writeFileSync(path.join(world.projectDir, 'src', 'a.js'), 'a');
  assert.deepEqual(live.tracker.getSystem(SLUG).planets, [
    { name: 'src', files: 1, builds: 1 },
    { name: '(root)', files: 0, builds: 1 },
  ]);
  assert.deepEqual(replay.source.getSystem(SLUG), {
    project: replay.snapshot.projects[0],
    planets: [{ name: '(root)', files: 0, builds: 1 }, { name: 'src', files: 0, builds: 1 }],
    beltDensity: 0,
  });
});

test('differs: attention — live raises question for a pending AskUserQuestion; replay never pages', async (t) => {
  const { world, live, replay } = await runBoth(t, {
    records: (dir) => [claude.prompt(dir, T0), claude.tool(dir, T0 + 1 * SEC, 'toolu_q', 'AskUserQuestion', {})],
  });
  world.clock.set(T0 + 3 * SEC);
  live.tracker.pollFiles();
  assert.equal(live.tracker.snapshot().ships[0].attention, 'question');
  assert.equal(replay.snapshot.ships[0].attention, null);
});

test('differs: attention — live raises done after 10 s of quiet; replay never does', async (t) => {
  const { world, live, replay } = await runBoth(t, {
    records: (dir) => [
      claude.prompt(dir, T0),
      claude.tool(dir, T0 + 1 * SEC, 'toolu_r', 'Read', { file_path: path.join(dir, 'src', 'a.js') }),
      claude.result(dir, T0 + 2 * SEC, 'toolu_r'),
      claude.turnDone(dir, T0 + 3 * SEC),
    ],
  });
  world.clock.set(T0 + 13 * SEC);
  live.tracker.pollFiles();
  assert.equal(live.tracker.snapshot().ships[0].attention, 'done');
  assert.equal(replay.snapshot.ships[0].attention, null);
  assert.equal(ofType(replay.events, 'feed').some((event) => event.entry.kind === 'done'), false);
});

test('differs: a record without a timestamp — live parses it at Date.now(), replay drops it', async (t) => {
  const { live, replay } = await runBoth(t, {
    records: (dir) => {
      const undated = claude.tool(dir, T0, 'toolu_undated', 'Edit', { file_path: path.join(dir, 'src', 'a.js') });
      delete undated.timestamp;
      return [claude.prompt(dir, T0), undated, claude.result(dir, T0 + 2 * SEC, 'toolu_undated')];
    },
  });
  assert.deepEqual(ofType(live.events, 'build').map((event) => event.ts), [T0 + 2 * SEC]);
  assert.deepEqual(ofType(replay.events, 'build'), []);
  assert.equal(replay.snapshot.projects[0].totalBuilds, 0);
});

test('differs: a repeated tool_use id — live counts the edit twice, replay dedupes the build by call id', async (t) => {
  const { live, replay } = await runBoth(t, {
    records: (dir) => [
      claude.prompt(dir, T0),
      claude.tool(dir, T0 + 1 * SEC, 'toolu_dup', 'Edit', { file_path: path.join(dir, 'src', 'a.js') }),
      claude.tool(dir, T0 + 2 * SEC, 'toolu_dup', 'Edit', { file_path: path.join(dir, 'src', 'a.js') }),
    ],
  });
  assert.deepEqual(ofType(live.events, 'build').map((event) => event.isNew), [true, false]);
  assert.equal(live.snapshot.projects[0].totalBuilds, 2);
  assert.equal(live.snapshot.ships[0].builds, 2);
  assert.deepEqual(ofType(replay.events, 'build').map((event) => event.isNew), [true]);
  assert.equal(replay.snapshot.projects[0].totalBuilds, 1);
  assert.equal(replay.snapshot.ships[0].builds, 1);
});

test('differs: project-id collision suffix — live "<id>:<hash8>", replay "<id>-<hash>" (unpadded)', (t) => {
  const world = createWorld(t);
  const first = path.join(world.root, 'one', 'demo');
  const second = path.join(world.root, 'two', 'demo');
  const hash = hex8(canonicalProjectPath(second));

  const { tracker } = world.live();
  assert.equal(tracker.ensureProjectForPath(first, 'project:shared', T0, 0).id, 'project:shared');
  assert.equal(tracker.ensureProjectForPath(second, 'project:shared', T0, 0).id, `project:shared:${hash}`);

  const { source } = world.replay();
  assert.equal(source._model.ensureProject(first, T0, false, 'shared').id, 'shared');
  assert.equal(source._model.ensureProject(second, T0, false, 'shared').id,
    `shared-${parseInt(hash, 16).toString(16)}`);
});

// ---------- Codex and Signal ----------

test('agree: codex project id, ship identity, classified activity and builds', async (t) => {
  const { world, live, replay } = await runBoth(t, { provider: 'codex' });
  const projectId = `project:${hex8(canonicalProjectPath(world.projectDir))}`;
  assert.deepEqual(replay.snapshot.projects.map((project) => project.id), [projectId]);
  assert.deepEqual(live.snapshot.projects.map((project) => project.id), [projectId]);

  const ship = pick(['id', 'name', 'project', 'kind', 'provider', 'status', 'lastEvent', 'builds']);
  assert.deepEqual(replay.snapshot.ships.map(ship), live.snapshot.ships.map(ship));
  assert.equal(live.snapshot.ships[0].id, CODEX_SHIP_ID);
  assert.equal(live.snapshot.ships[0].builds, 1);

  const activity = pick(['shipId', 'tool', 'status', 'detail', 'ts']);
  assert.deepEqual(ofType(replay.events, 'activity').map(activity), ofType(live.events, 'activity').map(activity));
  assert.deepEqual(ofType(live.events, 'activity').map((event) => event.tool), ['Bash', 'Edit']);

  const build = pick(['project', 'bucket', 'isNew', 'shipId', 'ts']);
  assert.deepEqual(ofType(replay.events, 'build').map(build), ofType(live.events, 'build').map(build));
  assert.equal(ofType(live.events, 'build').length, 1);
});

test('differs: codex task marker and turn outcome reach ships in live only', async (t) => {
  const { live, replay } = await runBoth(t, { provider: 'codex' });
  assert.deepEqual(pick(['taskId', 'turnOutcome'])(live.snapshot.ships[0]), { taskId: TASK_ID, turnOutcome: 'completed' });
  assert.equal('taskId' in replay.snapshot.ships[0], false);
  assert.equal('turnOutcome' in replay.snapshot.ships[0], false);
});

test('differs: Signal watch dirs are live-only; ReplaySource reads no provider config', async (t) => {
  const world = createWorld(t);
  const signalDir = path.join(world.root, 'signals');
  fs.mkdirSync(signalDir, { recursive: true });
  fs.writeFileSync(path.join(signalDir, 'beat.log'), 'x');
  fs.mkdirSync(path.dirname(world.providerConfigPath), { recursive: true });
  fs.writeFileSync(world.providerConfigPath,
    JSON.stringify({ watch: [{ directory: signalDir, projectPath: world.projectDir }] }));
  appendJsonl(world.claudeFile(), [claude.prompt(world.projectDir, T0)], T0);

  const { tracker } = world.live();
  tracker.scan(true);
  assert.deepEqual(tracker.snapshot().ships.map((ship) => ship.provider).sort(), ['claude', 'generic']);

  const snapshot = await world.replay({ providerConfigPath: world.providerConfigPath }).source.seek(T0);
  assert.deepEqual(snapshot.ships.map((ship) => ship.provider), ['claude']);
});

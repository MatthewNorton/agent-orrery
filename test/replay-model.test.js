'use strict';

// Characterization of the history model (src/main/replay-source.js): what a
// seek, an advance and a play tick produce over a small fixed history.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { canonicalProjectPath } = require('../src/main/provider-adapters');
const {
  SEC, MIN, T0, SLUG, CLAUDE_SESSION, CODEX_SESSION,
  fnv1a, hex8, appendJsonl, createWorld, ofType, claude, codex,
} = require('./support/transcripts');

const SHIP_ID = `ship:${SLUG}:${CLAUDE_SESSION}`;
const CODEX_SHIP_ID = `ship:codex:${CODEX_SESSION}`;
const DRONE_ID = `drone:claude:${CLAUDE_SESSION}:toolu_task`;
const END = T0 + 10 * MIN;

function writeHistory(world) {
  const dir = world.projectDir;
  appendJsonl(world.claudeFile(), [
    claude.prompt(dir, T0),
    claude.tool(dir, T0 + 5 * SEC, 'toolu_read', 'Read', { file_path: path.join(dir, 'src', 'a.js') }),
    claude.result(dir, T0 + 8 * SEC, 'toolu_read'),
    claude.tool(dir, T0 + 30 * SEC, 'toolu_edit', 'Edit', { file_path: path.join(dir, 'src', 'b.js') }),
    claude.result(dir, T0 + 35 * SEC, 'toolu_edit'),
    claude.tool(dir, T0 + 40 * SEC, 'toolu_task', 'Task', { description: 'Survey' }),
    claude.result(dir, T0 + 50 * SEC, 'toolu_task'),
    claude.turnDone(dir, END),
  ]);
  appendJsonl(world.codexFile(), [
    codex.meta(T0 + 2 * SEC, CODEX_SESSION, dir),
    codex.event(T0 + 12 * SEC, 'task_started'),
    codex.patchCall(T0 + 40 * SEC, 'call-patch'),
    codex.patched(T0 + 45 * SEC, 'call-patch', [path.join(dir, 'docs', 'notes.md')]),
    codex.patchOutput(T0 + 46 * SEC, 'call-patch'),
    codex.event(T0 + 50 * SEC, 'task_complete'),
  ]);
}

async function historyAt(t, options = {}) {
  const world = createWorld(t);
  writeHistory(world);
  const replay = world.replay(options);
  await replay.source.index();
  replay.take();
  return { world, ...replay };
}

// Mirrors replayGalaxy(): galaxies group by the hashed parent of the canonical path.
function historyGalaxy(projectDir) {
  const canonical = canonicalProjectPath(projectDir);
  const flavor = canonical.startsWith('win:') ? path.win32 : path.posix;
  const raw = canonical.slice(canonical.indexOf(':') + 1).replace(/\//g, flavor.sep);
  return { key: `history:${hex8(flavor.dirname(raw))}`, label: 'Workspace' };
}

const pick = (keys) => (event) => Object.fromEntries(keys.map((key) => [key, event[key]]));

test('replay: index() reports the history range and leaves the model empty', async (t) => {
  const { source, states } = await historyAt(t);
  assert.deepEqual(source.status(), {
    mode: 'replay', available: true, indexing: false, minTs: T0, maxTs: END, cursorTs: T0,
    playing: false, speed: 1, sourceCount: 2, truncated: false,
  });
  assert.deepEqual(states.map((state) => state.indexing), [true, false]);
  assert.deepEqual(source.snapshot(), { projects: [], ships: [], feed: [], eventSequence: 0 });
});

test('replay: a seek before the first record yields an empty universe and no event batches', async (t) => {
  const { source, take } = await historyAt(t);
  assert.deepEqual(await source.seek(T0 - MIN), { projects: [], ships: [], feed: [], eventSequence: 0 });
  assert.equal(source.status().cursorTs, T0, 'the cursor is clamped to the first record');
  assert.deepEqual(take(), []);
});

test('replay: a seek inside the history rebuilds the model silently', async (t) => {
  const { world, source, take, states } = await historyAt(t);
  const snapshot = await source.seek(T0 + 31 * SEC);

  assert.deepEqual(take(), [], 'seek reduces without emitting events');
  assert.equal(states.at(-1).cursorTs, T0 + 31 * SEC);
  assert.deepEqual(snapshot.projects, [{
    id: SLUG, path: world.projectDir, name: 'demo', exists: true,
    firstSeen: T0, lastActivity: T0 + 30 * SEC, totalBytes: 0, totalBuilds: 1,
    buckets: { src: 1 }, seed: fnv1a(SLUG), galaxy: historyGalaxy(world.projectDir), planets: ['src'],
  }]);
  assert.deepEqual(snapshot.ships, [
    {
      id: SHIP_ID, name: 'Claude-1', project: SLUG, kind: 'main', provider: 'claude',
      status: 'Building', detail: null, lastEvent: T0 + 30 * SEC, attention: null, attentionSince: null,
      builds: 1, local: false, model: null,
    },
    {
      id: CODEX_SHIP_ID, name: 'Codex-1', project: SLUG, kind: 'main', provider: 'codex',
      status: 'Working', detail: null, lastEvent: T0 + 12 * SEC, attention: null, attentionSince: null,
      builds: 0, local: false, model: null,
    },
  ]);
  assert.deepEqual(snapshot.feed, [
    { kind: 'spawn', text: 'Claude-1 entered demo', project: SLUG, ts: T0 },
    { kind: 'spawn', text: 'Codex-1 entered demo', project: SLUG, ts: T0 + 2 * SEC },
    { kind: 'form', text: 'Planet formation started: src in demo', project: SLUG, ts: T0 + 30 * SEC },
    { kind: 'build', text: 'Claude-1 building src/b.js in demo', project: SLUG, ts: T0 + 30 * SEC },
  ]);
  assert.equal(snapshot.eventSequence, 0);
});

test('replay: advanceTo() emits one ordered batch from the cursor, renumbered from 1', async (t) => {
  const { source, take } = await historyAt(t);
  await source.seek(T0 + 31 * SEC);
  const snapshot = await source.advanceTo(T0 + 60 * SEC);
  const events = take();

  assert.deepEqual(events.map((event) => event.type), [
    'project-updated', 'ship-updated',
    'project-updated', 'ship-updated',
    'ship-updated', 'activity', 'ship-spawned', 'feed',
    'ship-updated', 'activity',
    'project-updated', 'build', 'feed', 'feed',
    'project-updated', 'ship-updated',
    'project-updated', 'ship-updated', 'ship-departed', 'feed',
    'ship-updated',
  ]);
  assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index + 1));
  assert.equal(snapshot.eventSequence, events.length);
  assert.deepEqual(ofType(events, 'activity').map(pick(['shipId', 'tool', 'status', 'detail', 'ts'])), [
    { shipId: SHIP_ID, tool: 'Task', status: 'Delegating', detail: null, ts: T0 + 40 * SEC },
    { shipId: CODEX_SHIP_ID, tool: 'Edit', status: 'Building', detail: null, ts: T0 + 40 * SEC },
  ]);
  assert.deepEqual(ofType(events, 'ship-spawned')[0].ship, {
    id: DRONE_ID, name: 'Claude-2', project: SLUG, kind: 'drone', provider: 'claude',
    status: 'Working', detail: null, lastEvent: T0 + 40 * SEC, attention: null, attentionSince: null,
    builds: 0, local: false, model: null,
  });
  assert.deepEqual(ofType(events, 'build').map(pick(['project', 'bucket', 'file', 'shipId', 'isNew', 'ts'])), [
    { project: SLUG, bucket: 'docs', file: 'docs/notes.md', shipId: CODEX_SHIP_ID, isNew: true, ts: T0 + 45 * SEC },
  ]);
  assert.deepEqual(ofType(events, 'ship-departed').map(pick(['shipId', 'ts'])), [{ shipId: DRONE_ID, ts: T0 + 50 * SEC }]);
  assert.deepEqual(ofType(events, 'feed').map((event) => event.entry.text), [
    'Claude-1 launched Claude-2 in demo',
    'Planet formation started: docs in demo',
    'Codex-1 building docs/notes.md in demo',
    'Claude-2 returned to Claude-1',
  ]);
});

test('replay: idle ships depart at their historical deadline; a later record respawns a renamed ship', async (t) => {
  const { source } = await historyAt(t);
  const snapshot = await source.seek(T0 + 2 * 60 * MIN);
  const deadline = T0 + 50 * SEC + 5 * MIN;

  assert.equal(source.status().cursorTs, END, 'seeks past the end clamp to the last record');
  assert.deepEqual(snapshot.ships.map(pick(['id', 'name', 'status', 'lastEvent'])), [
    { id: SHIP_ID, name: 'Claude-3', status: 'Working', lastEvent: END },
  ]);
  assert.deepEqual(snapshot.feed.slice(-3), [
    { kind: 'depart', text: 'Claude-1 warped out', project: SLUG, ts: deadline },
    { kind: 'depart', text: 'Codex-1 warped out', project: SLUG, ts: deadline },
    { kind: 'spawn', text: 'Claude-3 entered demo', project: SLUG, ts: END },
  ]);
  assert.deepEqual(pick(['lastActivity', 'totalBuilds', 'buckets'])(snapshot.projects[0]),
    { lastActivity: END, totalBuilds: 2, buckets: { src: 1, docs: 1 } });
});

test('replay: a backward seek rebuilds exactly the universe a cold seek does', async (t) => {
  const { source } = await historyAt(t);
  const cold = await source.seek(T0 + 31 * SEC);
  await source.seek(END);
  assert.deepEqual(await source.seek(T0 + 31 * SEC), cold);
});

test('replay: play() advances on scheduler ticks at the chosen speed and pauses at the end', async (t) => {
  const timers = [];
  const cleared = [];
  let wall = T0 + 60 * MIN;
  const scheduler = {
    setTimeout: (fn, delay) => timers.push({ fn, delay }),
    clearTimeout: (id) => cleared.push(id),
  };
  const { source, take } = await historyAt(t, { scheduler, now: () => wall });
  await source.seek(T0);
  source.setSpeed(10);

  assert.equal(source.play().playing, true);
  assert.deepEqual(timers.map((timer) => timer.delay), [0]);
  wall += 3 * SEC;
  await timers[0].fn();
  assert.equal(source.status().cursorTs, T0 + 30 * SEC, '3 s of wall time at 10x');
  assert.deepEqual(ofType(take(), 'build').map((event) => event.bucket), ['src']);
  assert.deepEqual(timers.map((timer) => timer.delay), [0, 100]);

  source.setSpeed(1000);
  wall += 1 * SEC;
  await timers[1].fn();
  assert.deepEqual(pick(['playing', 'cursorTs'])(source.status()), { playing: false, cursorTs: END });
  assert.equal(timers.length, 2, 'reaching the end stops scheduling');
  assert.ok(take().length > 0);
  assert.equal(source.play().playing, false, 'play() at the end stays paused');
});

test('replay: getSystem() and getPlanet() derive planets from build buckets only', async (t) => {
  const { source } = await historyAt(t);
  await source.seek(T0 + 31 * SEC);
  const early = source.getSystem(SLUG);
  assert.deepEqual(early.planets, [{ name: 'src', files: 0, builds: 1 }]);

  await source.seek(END);
  const system = source.getSystem(SLUG);
  assert.deepEqual(system, {
    project: source.snapshot().projects[0],
    planets: [{ name: 'docs', files: 0, builds: 1 }, { name: 'src', files: 0, builds: 1 }],
    beltDensity: 0,
  });
  assert.deepEqual(source.getPlanet(SLUG, 'src'), {
    name: 'src', project: system.project, builds: 1, files: 0, sizeKb: 0, subdirs: 0, resources: [], procedural: false,
  });
  const unknown = source.getPlanet(SLUG, 'Sector-1');
  assert.equal(unknown.procedural, true);
  assert.equal(unknown.builds, 0);
  assert.deepEqual(unknown.resources, ['Unknown']);
  assert.equal(source.getSystem('missing'), null);
  assert.equal(source.getPlanet('missing', 'src'), null);
});

test('replay: a project with no builds yet gets procedural planets', async (t) => {
  const { source } = await historyAt(t);
  await source.seek(T0 + 10 * SEC);
  const { planets, beltDensity } = source.getSystem(SLUG);
  assert.ok(planets.length >= 3 && planets.length <= 6, String(planets.length));
  planets.forEach((planet, index) => {
    assert.equal(planet.name, `Sector-${index + 1}`);
    assert.equal(planet.procedural, true);
  });
  assert.equal(beltDensity, 0);
});

test('replay: input validation and stop()', async (t) => {
  const { source } = await historyAt(t);
  assert.throws(() => source.setSpeed(2), RangeError);
  await assert.rejects(source.seek(Number.NaN), TypeError);
  await source.seek(END);

  source.stop();
  assert.deepEqual(pick(['available', 'minTs', 'maxTs', 'cursorTs', 'playing'])(source.status()),
    { available: false, minTs: null, maxTs: null, cursorTs: null, playing: false });
  assert.deepEqual(source.snapshot(), { projects: [], ships: [], feed: [], eventSequence: 0 });
  assert.equal(source.play().playing, false);
});

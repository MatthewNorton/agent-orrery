'use strict';

// Feeds the same transcript to the live Tracker and to the history ReplaySource: what both
// models already share. tracker-replay-differences.test.js names where they differ.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalProjectPath } = require('../src/main/provider-adapters');
const { SEC, T0, SLUG, SHIP_ID, CODEX_SHIP_ID, hex8, ofType, pick, claude } = require('./support/transcripts');
const { runBoth } = require('./support/both-models');

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
  assert.deepEqual(pick(['name', 'builds'])(await live.tracker.getPlanet(SLUG, 'DOCS')), { name: 'Docs', builds: 2 });
  assert.deepEqual(replay.snapshot.projects[0].buckets, { Docs: 2 });
  assert.deepEqual(pick(['name', 'builds'])(replay.source.getPlanet(SLUG, 'DOCS')), { name: 'Docs', builds: 2 },
    'by the bucket key, which the replay system view draws it under');
});

test('agree: a system of more than eight planets keeps the biggest eight and says of how many', async (t) => {
  const { live, replay } = await runBoth(t, {
    records: (dir) => {
      for (let index = 0; index < 10; index++) fs.mkdirSync(path.join(dir, `dir${index}`));
      return [claude.prompt(dir, T0), ...Array.from({ length: 10 }, (_, index) => (
        claude.tool(dir, T0 + (index + 1) * SEC, `toolu_${index}`, 'Write', { file_path: path.join(dir, `dir${index}`, 'a.js') })))];
    },
  });
  // Live counts the folders on disk, the fixture's own src among them; history, the folders built in.
  const live8 = live.tracker.getSystem(SLUG), replay8 = replay.source.getSystem(SLUG);
  assert.deepEqual([live8.planets.length, live8.planetTotal], [8, 11]);
  assert.deepEqual([replay8.planets.length, replay8.planetTotal], [8, 10]);
  assert.equal(live8.planets.some((planet) => planet.name === 'src'), false, 'the one without builds is past the eighth');
});

// ---------- Codex ----------

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

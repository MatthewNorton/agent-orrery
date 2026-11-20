'use strict';

// Characterization of the live model (src/main/tracker.js) as of the Phase 3
// cleanup. These pin current behaviour so the parser merge can prove it
// changes nothing; tests marked `todo` encode suspected bugs, not intent.
// Here: the derived views (snapshot, getSystem, getPlanet) and the state file. The providers are
// in live-claude-source, live-claude-records, live-codex-source and live-signal-source.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalProjectPath } = require('../src/main/provider-adapters');
const {
  SEC, MIN, T0, SLUG, CODEX_SESSION, appendJsonl, createWorld, ofType, pick, claude, codex, readState,
} = require('./support/transcripts');
const { PROJECT_KEYS, SHIP_KEYS, startClaude, appendAndPoll } = require('./support/live-session');

test('snapshot(), getSystem() and getPlanet() public shapes for a project on disk', async (t) => {
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
  assert.deepEqual(Object.keys(snapshot).sort(), ['buildHistogram', 'eventSequence', 'feed', 'projects', 'ships', 'warnings']);
  assert.equal(snapshot.buildHistogram.bins.length, 48);
  assert.equal(snapshot.eventSequence, events.at(-1).seq);
  assert.deepEqual(Object.keys(snapshot.projects[0]).sort(), PROJECT_KEYS);
  assert.deepEqual(Object.keys(snapshot.ships[0]).sort(), SHIP_KEYS);
  assert.deepEqual(snapshot.feed, ofType(events, 'feed').map((event) => event.entry));

  const system = tracker.getSystem(SLUG);
  assert.deepEqual(system, {
    project: snapshot.projects[0],
    planets: [
      { name: 'src', key: 'src', files: 3, builds: 2 },
      { name: '(root)', key: '(root)', files: 3, builds: 1 },
      { name: 'docs', key: 'docs', files: 1, builds: 0 },
    ],
    beltDensity: 3,
  });
  assert.equal(tracker.getSystem('missing'), null);

  assert.deepEqual(await tracker.getPlanet(SLUG, 'src'), {
    name: 'src', key: 'src', project: snapshot.projects[0], builds: 2, files: 3, sizeKb: 0, subdirs: 1, resources: ['JS'], folderRead: 'full',
  });
  assert.deepEqual(await tracker.getPlanet(SLUG, '(root)'), {
    name: '(root)', key: '(root)', project: snapshot.projects[0], builds: 1, files: 3, sizeKb: 0, subdirs: 2, resources: ['MD', 'JSON'],
    folderRead: 'full',
  });
  const sector = await tracker.getPlanet(SLUG, 'Sector-1');
  assert.equal(sector.procedural, true);
  assert.deepEqual(sector.resources, ['Unknown']);
  assert.equal(await tracker.getPlanet('missing', 'src'), null);
});

test('getSystem() and getPlanet() fall back to deterministic procedural planets for a missing path', async (t) => {
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
    assert.deepEqual(Object.keys(planet).sort(), ['builds', 'files', 'key', 'name', 'procedural']);
    assert.equal(planet.name, `Sector-${index + 1}`);
    assert.equal(planet.builds, 0);
    assert.equal(planet.procedural, true);
  });
  assert.deepEqual(second.getSystem(SLUG), system, 'seeded only by the project id');

  const planet = await first.getPlanet(SLUG, 'src');
  assert.deepEqual(Object.keys(planet).sort(),
    ['builds', 'files', 'key', 'name', 'procedural', 'project', 'resources', 'sizeKb', 'subdirs']);
  assert.deepEqual(await second.getPlanet(SLUG, 'src'), planet);
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

  assert.deepEqual(readState(world.statePath), {
    version: 2,
    projects: {
      [SLUG]: {
        path: dir, name: 'demo', lastActivity: T0 + 2 * SEC,
        buckets: { src: 2 }, totalBuilds: 2, firstSeen: T0,
      },
    },
    pathIds: { [canonicalProjectPath(dir)]: SLUG },
    pathOverrides: {},
    forgotten: {},
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

test('a folder named __proto__ starts one planet, and its builds survive the state file', async (t) => {
  const session = startClaude(t);
  const { dir, world } = session;
  const edit = (n) => claude.tool(dir, T0 + n * SEC, 'toolu_p' + n, 'Edit', { file_path: path.join(dir, '__proto__', `f${n}.js`) });
  const events = appendAndPoll(session, [edit(1), edit(2), edit(3)], T0 + 3 * SEC);
  assert.deepEqual(ofType(events, 'build').map(pick(['bucket', 'key', 'isNew'])), [
    { bucket: '__proto__', key: '__proto__', isNew: true },
    { bucket: '__proto__', key: '__proto__', isNew: false },
    { bucket: '__proto__', key: '__proto__', isNew: false },
  ]);
  assert.equal(ofType(events, 'feed').filter((event) => event.entry.kind === 'form').length, 1, 'one planet formation in the feed');
  assert.deepEqual(session.tracker.snapshot().projects[0].planets, ['__proto__']);

  assert.equal(session.tracker.saveState(), true);
  const saved = readState(world.statePath).projects[SLUG];
  assert.deepEqual([Object.keys(saved.buckets), saved.buckets.__proto__, saved.totalBuilds], [['__proto__'], 3, 3]);
  const restored = world.live({ claudeProjectsDir: path.join(world.root, 'no-claude') }).tracker;
  restored.scan(true);
  assert.deepEqual(pick(['name', 'builds'])(await restored.getPlanet(SLUG, '__proto__')), { name: '__proto__', builds: 3 });
});

test('loadState() treats an unreadable state file as empty', (t) => {
  const world = createWorld(t);
  fs.mkdirSync(path.dirname(world.statePath), { recursive: true });
  fs.writeFileSync(world.statePath, 'not json');
  const { tracker } = world.live();
  assert.deepEqual(tracker.persisted, { version: 2, projects: {} });
});

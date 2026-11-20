'use strict';

// Universe backups: an export brings a universe back on a fresh install, an import merges and
// never removes, and a file from anywhere cannot put a hostile id, name or path in the model.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { namesIgnoreCase, setProjectPath } = require('../src/main/build-buckets');
const { parseBackup } = require('../src/main/live/backup');
const { adoptProjectPath } = require('../src/main/live/projects');
const { CASED_COUNTS, own, KEPT_APART, KEPT_AS_ONE, KEPT_LARGER } = require('./support/bucket-cases');
const { projectsById } = require('./support/live-session');
const { MIN, T0, appendJsonl, claude, createWorld, readState, writeState } = require('./support/transcripts');

test('an export imported into an empty universe brings back every project, path and build count', (t) => {
  const w = createWorld(t);
  const moved = path.join(w.root, 'moved');
  fs.mkdirSync(moved);
  writeState(w.statePath, {
    version: 2,
    projects: {
      demo: { path: w.projectDir, name: 'demo', buckets: { src: 4 }, totalBuilds: 4, firstSeen: T0 - 9 * MIN },
      moved: { path: moved, name: 'moved', buckets: { lib: 2 }, totalBuilds: 2, firstSeen: T0 - 8 * MIN },
    },
    pathOverrides: { moved },
  });
  const source = w.live().tracker;
  const text = JSON.stringify(source.createBackup([{ id: 'x', text: 'ship the backup', createdAt: 1 }]));

  const freshState = path.join(w.root, 'fresh', 'universe-state.json');
  const target = w.live({ statePath: freshState }).tracker;
  const backup = parseBackup(text);
  assert.deepEqual(backup.ideas, ['ship the backup']);
  assert.deepEqual(target.importBackup(backup), { added: 2, merged: 0 });

  const projects = projectsById(target);
  assert.equal(projects.get('demo').path, w.projectDir);
  assert.equal(projects.get('demo').exists, true);
  assert.equal(projects.get('demo').totalBuilds, 4);
  assert.deepEqual({ ...target.model.projects.get('moved').buckets }, { lib: 2 });
  const saved = readState(freshState);
  assert.deepEqual(Object.keys(saved.projects).sort(), ['demo', 'moved']);
  assert.equal(saved.pathOverrides.moved, moved);
});

test('an import merges: larger counts win, nothing is removed, a forgotten project returns', (t) => {
  const w = createWorld(t);
  writeState(w.statePath, {
    version: 2,
    projects: {
      kept: { path: w.projectDir, buckets: { src: 3 }, totalBuilds: 3, firstSeen: T0 - 5 * MIN, lastActivity: T0 - 2 * MIN },
      local: { buckets: { app: 1 }, totalBuilds: 1, firstSeen: T0 - 4 * MIN },
      gone: { buckets: { old: 7 }, totalBuilds: 7, firstSeen: T0 - 30 * MIN },
    },
  });
  const tracker = w.live().tracker;
  tracker.forgetProject('gone');
  const backup = parseBackup(JSON.stringify({
    format: 'agent-orrery-backup',
    version: 1,
    universe: {
      projects: {
        // Same folder, another id: it merges into the project that owns the folder.
        elsewhere: { path: w.projectDir, buckets: { src: 1, docs: 4 }, totalBuilds: 5, firstSeen: T0 - 9 * MIN, lastActivity: T0 - 3 * MIN },
        gone: { buckets: { old: 7 }, totalBuilds: 7, firstSeen: T0 - 30 * MIN },
      },
    },
  }));

  assert.deepEqual(tracker.importBackup(backup), { added: 1, merged: 1 });
  const projects = projectsById(tracker);
  assert.deepEqual([...projects.keys()].sort(), ['gone', 'kept', 'local']);
  assert.deepEqual({ ...tracker.model.projects.get('kept').buckets }, { src: 3, docs: 4 });
  assert.equal(projects.get('kept').totalBuilds, 5);
  assert.equal(projects.get('kept').firstSeen, T0 - 9 * MIN);
  assert.equal(projects.get('kept').lastActivity, T0 - 2 * MIN);
  assert.equal(projects.get('gone').totalBuilds, 7);
  assert.deepEqual({ ...tracker.model.forgotten }, {});
});

test('a folder named __proto__, constructor or prototype keeps its builds through a backup', (t) => {
  const w = createWorld(t);
  writeState(w.statePath, { version: 2, projects: { kept: { path: w.projectDir, buckets: { src: 3 }, totalBuilds: 3, firstSeen: T0 } } });
  const tracker = w.live().tracker;
  const backup = parseBackup(`{
    "format": "agent-orrery-backup", "version": 1,
    "universe": { "projects": {
      "kept": { "buckets": { "__proto__": 4, "constructor": 2, "prototype": 1, "src": 1 }, "totalBuilds": 8 },
      "fresh": { "buckets": { "__proto__": 5 }, "totalBuilds": 5 }
    } }
  }`);
  assert.deepEqual(tracker.importBackup(backup), { added: 1, merged: 1 });
  const ownOf = (id) => {
    const { buckets } = tracker.model.projects.get(id);
    assert.equal(Object.getPrototypeOf(buckets), Object.prototype, id);
    return own(buckets).sort();
  };
  assert.deepEqual(ownOf('kept'), [['__proto__', 4], ['constructor', 2], ['prototype', 1], ['src', 3]]);
  assert.deepEqual(ownOf('fresh'), [['__proto__', 5]]);
  assert.deepEqual(projectsById(tracker).get('fresh').planets, ['__proto__']);

  // And out again: the export of that universe, imported into an empty one.
  const exported = JSON.stringify(tracker.createBackup([]));
  const empty = w.live({ statePath: path.join(w.root, 'fresh', 'universe-state.json') }).tracker;
  empty.importBackup(parseBackup(exported));
  assert.deepEqual(Object.entries(empty.model.projects.get('fresh').buckets), [['__proto__', 5]]);
  assert.equal({}.polluted, undefined);
});

test('a file that is not a backup is refused', () => {
  for (const text of ['not json', '[]', '{}', JSON.stringify({ format: 'agent-orrery-backup', version: 2, universe: { projects: {} } }),
    JSON.stringify({ format: 'something-else', version: 1, universe: { projects: {} } }),
    JSON.stringify({ format: 'agent-orrery-backup', version: 1, universe: { projects: [] } })]) {
    assert.equal(parseBackup(text), null, text);
  }
});

test('a backup\'s count for a folder goes to the bucket the folder has here, in whatever casing', (t) => {
  const w = createWorld(t);
  const other = path.join(w.root, 'workspace', 'other');
  fs.mkdirSync(other);
  writeState(w.statePath, { version: 2, projects: { kept: { path: w.projectDir, buckets: { Docs: 5, src: 3 }, totalBuilds: 8, firstSeen: T0 } } });
  const tracker = w.live().tracker;
  assert.deepEqual(tracker.importBackup(parseBackup(JSON.stringify({ format: 'agent-orrery-backup', version: 1, universe: { projects: {
    kept: { path: w.projectDir, buckets: { docs: 7, SRC: 1, lib: 2 }, totalBuilds: 10 },
    // A file may name one folder twice; a project it adds keeps one bucket for it all the same.
    fresh: { path: other, buckets: { Docs: 5, docs: 7 }, totalBuilds: 12 },
  } } }))), { added: 1, merged: 1 });
  const buckets = (id) => Object.entries(tracker.model.projects.get(id).buckets);
  // The temp folder is a Windows path on Windows only: there one folder is one bucket.
  const oneFolder = namesIgnoreCase({ path: w.projectDir });
  assert.deepEqual(buckets('kept'), oneFolder ? [['Docs', 7], ['src', 3], ['lib', 2]]
    : [['Docs', 5], ['src', 3], ['docs', 7], ['SRC', 1], ['lib', 2]]);
  assert.deepEqual(buckets('fresh'), oneFolder ? [['Docs', 12]] : [['Docs', 5], ['docs', 7]]);
  assert.equal(projectsById(tracker).get('kept').planets.length, oneFolder ? 3 : 5);
});

test('a backup\'s casings of one folder, counted under a path, are added up before they meet what is here', (t) => {
  const w = createWorld(t);
  writeState(w.statePath, { version: 2, projects: {
    held: { name: 'held', buckets: { Docs: 1, SRC: 20 }, totalBuilds: 21, firstSeen: T0 },
    bare: { name: 'bare', buckets: {}, totalBuilds: 0, firstSeen: T0 },
    loose: { name: 'loose', buckets: {}, totalBuilds: 0, firstSeen: T0 },
    far: { name: 'far', buckets: {}, totalBuilds: 0, firstSeen: T0 },
  } });
  const { tracker } = w.live();
  // A folder of a Windows path on every host: the four projects are known by one each.
  for (const id of ['held', 'bare', 'loose', 'far']) setProjectPath(tracker.model.projects.get(id), `C:\\Work\\${id}`);
  // The file's held and bare had a folder where the file was written: any local path, which no project here has.
  const counted = JSON.stringify(path.join(w.root, 'elsewhere'));
  const backup = parseBackup(`{ "format": "agent-orrery-backup", "version": 1, "universe": { "projects": {
    "held": { "path": ${counted}, "buckets": ${CASED_COUNTS} }, "bare": { "path": ${counted}, "buckets": ${CASED_COUNTS} },
    "loose": { "buckets": ${CASED_COUNTS} }, "far": { "path": "work/elsewhere", "buckets": ${CASED_COUNTS} } } } }`);
  assert.deepEqual(tracker.importBackup(backup), { added: 0, merged: 4 });
  const buckets = (id) => Object.entries(tracker.model.projects.get(id).buckets);
  assert.deepEqual(buckets('bare'), KEPT_AS_ONE);
  // A path this machine does not take (it is not absolute) is no folder here, but its builds were counted under it all the same.
  assert.deepEqual([backup.projects.find(([id]) => id === 'far')[1].path, buckets('far')], [null, KEPT_AS_ONE]);
  assert.deepEqual(buckets('held'), [['Docs', 12], ['SRC', 20], ...KEPT_AS_ONE.filter(([name]) => name !== 'Docs' && name !== 'src')],
    'the same 12, not the larger casing alone; src keeps its key here and the larger count');
  // A project the file holds with no path counted nothing where the file was written: its two
  // casings may be two records of the same builds, and the larger is kept.
  assert.deepEqual(buckets('loose'), KEPT_LARGER);
  // What the import saved holds the same, as numbers.
  assert.deepEqual(Object.entries(readState(w.statePath).projects.held.buckets), buckets('held'));

  // A project that is new here goes through the same fold, by the rule of the folder it gets.
  const other = path.join(w.root, 'workspace', 'other');
  fs.mkdirSync(other);
  tracker.importBackup(parseBackup(`{ "format": "agent-orrery-backup", "version": 1, "universe": { "projects": {
    "fresh": { "path": ${JSON.stringify(other)}, "buckets": ${CASED_COUNTS} } } } }`));
  assert.deepEqual(buckets('fresh'), namesIgnoreCase({ path: other }) ? KEPT_AS_ONE : KEPT_APART);
});

test('an import counts both sides by the folder the project ends with, and then keeps the larger', (t) => {
  const w = createWorld(t);
  const dirs = Object.fromEntries(['had', 'took', 'split'].map((id) => [id, path.join(w.root, 'workspace', id)]));
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir);
  writeState(w.statePath, { version: 2, projects: {
    had: { path: dirs.had, buckets: { Docs: 4 }, totalBuilds: 4, firstSeen: T0 },
    took: { name: 'took', buckets: { Docs: 4 }, totalBuilds: 4, firstSeen: T0 },
    // Counted with no folder, where Docs and docs are two names.
    split: { name: 'split', buckets: { Docs: 3, docs: 2 }, totalBuilds: 5, firstSeen: T0 },
  } });
  const { tracker } = w.live();
  const project = (id) => tracker.model.projects.get(id);
  assert.deepEqual([project('took').path, project('split').path, Object.entries(project('split').buckets)], [null, null, [['Docs', 3], ['docs', 2]]]);
  const events = [];
  tracker.on('events', (batch) => events.push(...batch));
  assert.deepEqual(tracker.importBackup(parseBackup(JSON.stringify({ format: 'agent-orrery-backup', version: 1, universe: { projects: {
    had: { path: dirs.had, buckets: { Docs: 5, docs: 7 }, totalBuilds: 12 },
    took: { path: dirs.took, buckets: { Docs: 5, docs: 7 }, totalBuilds: 12 },
    split: { path: dirs.split, buckets: { Docs: 5 }, totalBuilds: 5 },
  } } }))), { added: 0, merged: 3 });
  // The temp folder is a Windows path on Windows only: there Docs and docs are one folder.
  const oneFolder = namesIgnoreCase({ path: dirs.had });
  const buckets = (id) => Object.entries(project(id).buckets);
  assert.deepEqual([project('took').path, project('split').path], [dirs.took, dirs.split]);
  for (const id of ['had', 'took']) {
    assert.deepEqual(buckets(id), oneFolder ? [['Docs', 12]] : [['Docs', 5], ['docs', 7]], `${id}: the same whether the folder was here or came with the backup`);
  }
  // The project's own two casings are one folder under the path it takes. It counted neither
  // itself, so the larger (3) is what it has, and the file's 5 is larger still.
  assert.deepEqual(buckets('split'), oneFolder ? [['Docs', 5]] : [['Docs', 5], ['docs', 2]]);
  if (oneFolder) assert.equal(project('split').buckets.Docs <= project('split').totalBuilds, true, 'a planet has no more builds than its project');
  // One announcement per project, made after the merge: it names the planets the project ends with.
  const updates = events.filter((event) => event.type === 'project-updated');
  assert.deepEqual(updates.map((event) => [event.project.id, event.project.planets]),
    ['had', 'took', 'split'].map((id) => [id, Object.keys(project(id).buckets)]));
});

test('a project with no path that imports another casing of its folder has no more builds there than it has in all', (t) => {
  const w = createWorld(t);
  writeState(w.statePath, { version: 2, projects: {
    // The same three builds, known here as Docs and in the file as docs.
    loose: { name: 'loose', buckets: { Docs: 3 }, totalBuilds: 3, firstSeen: T0 },
    later: { name: 'later', buckets: { Docs: 3 }, totalBuilds: 3, firstSeen: T0 },
  } });
  const first = w.live().tracker;
  assert.deepEqual(first.importBackup(parseBackup(JSON.stringify({ format: 'agent-orrery-backup', version: 1, universe: { projects: {
    loose: { buckets: { docs: 3 }, totalBuilds: 3 }, later: { buckets: { docs: 3 }, totalBuilds: 3 },
  } } }))), { added: 0, merged: 2 });
  const held = (tracker, id) => {
    const project = tracker.model.projects.get(id);
    return [project.path, Object.entries(project.buckets), project.totalBuilds];
  };
  // With no path nothing says the two names are one folder, so both stay.
  assert.deepEqual(held(first, 'loose'), [null, [['Docs', 3], ['docs', 3]], 3]);
  // A transcript then names the folder (live/claude-records.js adopts it): a Windows path on every host.
  adoptProjectPath(first.model, first.model.projects.get('loose'), 'C:\\Work\\loose');
  assert.deepEqual(held(first, 'loose'), ['C:\\Work\\loose', [['Docs', 3]], 3], 'the two records of three builds are three builds');
  // The same after a restart, where the path comes in the run that reads the saved buckets back.
  const second = w.live().tracker;
  assert.deepEqual(held(second, 'later'), [null, [['Docs', 3], ['docs', 3]], 3]);
  adoptProjectPath(second.model, second.model.projects.get('later'), 'C:\\Work\\later');
  assert.deepEqual(held(second, 'later'), ['C:\\Work\\later', [['Docs', 3]], 3]);
});

test('a project whose id is __proto__ or constructor goes out in an export and comes back from it', (t) => {
  const w = createWorld(t);
  const dirs = { ['__proto__']: w.projectDir, constructor: path.join(w.root, 'workspace', 'other') };
  fs.mkdirSync(dirs.constructor);
  for (const id of ['__proto__', 'constructor']) {
    appendJsonl(w.claudeFile(id), [claude.prompt(dirs[id], T0 - 60 * MIN)], T0 - 60 * MIN);
  }
  const { tracker } = w.live();
  tracker.scan(true);
  assert.deepEqual([...projectsById(tracker).keys()].sort(), ['__proto__', 'constructor']);

  const exported = JSON.stringify(tracker.createBackup([]));
  const universe = JSON.parse(exported).universe;
  assert.deepEqual(Object.keys(universe.projects).sort(), ['__proto__', 'constructor'], 'both are in the file');
  assert.deepEqual(Object.values(universe.pathIds).sort(), ['__proto__', 'constructor']);

  const emptyState = path.join(w.root, 'fresh', 'universe-state.json');
  const empty = w.live({ statePath: emptyState, claudeProjectsDir: path.join(w.root, 'none') }).tracker;
  assert.deepEqual(empty.importBackup(parseBackup(exported)), { added: 2, merged: 0 });
  assert.deepEqual([...projectsById(empty)].map(([id, project]) => [id, project.path]).sort(),
    [['__proto__', dirs.__proto__], ['constructor', dirs.constructor]]);
  // The import saved them, as own keys of the file.
  const saved = readState(emptyState);
  assert.deepEqual(Object.keys(saved.projects).sort(), ['__proto__', 'constructor']);
  assert.deepEqual([{}.path, Object.getPrototypeOf(empty.model.pathIds), Object.getPrototypeOf(empty.model.forgotten)], [undefined, null, null]);
});

test('hostile ids, names, bucket counts and paths never reach the model', () => {
  const local = process.platform === 'win32' ? 'C:\\work\\demo' : '/work/demo';
  const backup = parseBackup(`{
    "format": "agent-orrery-backup", "version": 1,
    "universe": {
      "projects": {
        "__proto__": { "totalBuilds": 1 },
        "constructor": { "totalBuilds": 1 },
        "bad\\u0007id": { "totalBuilds": 1 },
        "   ": { "totalBuilds": 1 },
        ${JSON.stringify('i'.repeat(256))}: { "totalBuilds": 1 },
        ${JSON.stringify('i'.repeat(257))}: { "totalBuilds": 1 },
        "share": { "path": "\\\\\\\\evil\\\\share\\\\x", "totalBuilds": -4 },
        "device": { "path": "\\\\\\\\?\\\\C:\\\\x" },
        "relative": { "path": "work/demo", "name": "ok\\u0000name" },
        "fine": { "path": ${JSON.stringify(local)}, "name": "fine", "totalBuilds": 2.7,
          "buckets": { "src": 2, "__proto__": 9, "constructor": 9, "neg": -1, "nan": "3" } }
      },
      "pathIds": { "__proto__": "fine", "posix:/work/demo": "fine", "key": 7 }
    },
    "ideas": [{ "text": "keep" }, { "text": 3 }, "loose"]
  }`);
  const projects = new Map(backup.projects);
  // An id is a key of a Map and of objects with no prototype, so '__proto__' and 'constructor' are
  // ids like others; one with a control character, a blank one or one over 256 characters is not an id.
  assert.deepEqual([...projects.keys()].sort(), ['__proto__', 'constructor', 'device', 'fine', 'i'.repeat(256), 'relative', 'share']);
  assert.deepEqual([projects.get('__proto__').totalBuilds, projects.get('__proto__').path, {}.totalBuilds], [1, null, undefined]);
  assert.equal(projects.get('share').path, null);
  assert.equal(projects.get('share').totalBuilds, 0);
  assert.equal(projects.get('device').path, null);
  assert.equal(projects.get('relative').path, null);
  assert.equal(projects.get('relative').name, undefined);
  assert.equal(projects.get('fine').path, local);
  // A total is at least the largest bucket: no folder has more builds than its project.
  assert.equal(projects.get('fine').totalBuilds, 9);
  // A bucket is a folder's name, which may be one of those: an own count, and no prototype.
  const { buckets } = projects.get('fine');
  assert.deepEqual(own(buckets).sort(),
    [['__proto__', 9], ['constructor', 9], ['src', 2]]);
  assert.equal(Object.getPrototypeOf(buckets), Object.prototype);
  assert.deepEqual(backup.pathIds, [['posix:/work/demo', 'fine']]);
  assert.deepEqual(backup.ideas, ['keep']);
});

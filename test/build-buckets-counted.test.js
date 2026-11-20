'use strict';

// src/main/build-buckets.js foldBuckets: whether a project's buckets were counted under a path
// (bucketsCounted) is kept on the project, in the state file and in a backup, so every later path
// joins a folder's casings by it; and a folder never has more builds than its project.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mergeBuckets, setProjectPath } = require('../src/main/build-buckets');
const { parseBackup } = require('../src/main/live/backup');
const { remapProjectPath } = require('../src/main/live/project-edits');
const { adoptProjectPath, restoreProject, takeProjectPath } = require('../src/main/live/projects');
const { savedProject } = require('../src/main/live/saved-project');
const { getPlanet, getSystem } = require('../src/main/live/system-view');
const { ignoresCase } = require('../src/main/path-safety');
const { own } = require('./support/bucket-cases');
const { newModel } = require('./support/live-model');
const { T0, createWorld, readState, writeState } = require('./support/transcripts');

const backupOf = (projects) => parseBackup(JSON.stringify({ format: 'agent-orrery-backup', version: 1, universe: { projects } }));
const project = (tracker, id) => tracker.model.projects.get(id);
const buckets = (tracker, id) => own(project(tracker, id).buckets);
// A transcript names the folder (live/claude-records.js adopts it): a Windows path on every host.
const adoptWindowsPath = (tracker, id) => adoptProjectPath(tracker.model, project(tracker, id), `C:\\Work\\${id}`);

test('casings counted under a path the app does not keep are added up by every later path, also after a restart', (t) => {
  const w = createWorld(t);
  const counted = () => ({ buckets: { Docs: 3, docs: 2 }, totalBuilds: 5 });
  // A state file keeps no UNC path, and a backup no path that is not absolute: the projects arrive with none.
  writeState(w.statePath, { version: 2, projects: {
    unc: { path: '\\\\server\\share\\unc', ...counted(), firstSeen: T0 },
    restart: { path: '\\\\server\\share\\restart', ...counted(), firstSeen: T0 },
  } });
  const first = w.live().tracker;
  first.importBackup(backupOf({ adopt: { path: 'work/adopt', ...counted() }, remap: { path: 'work/remap', ...counted() }, merge: { path: 'work/merge', ...counted() } }));
  for (const id of ['unc', 'restart', 'adopt', 'remap', 'merge']) {
    assert.deepEqual([project(first, id).path, buckets(first, id)], [null, [['Docs', 3], ['docs', 2]]], id);
  }
  for (const id of ['unc', 'adopt']) adoptWindowsPath(first, id);
  assert.deepEqual([buckets(first, 'unc'), buckets(first, 'adopt')], [[['Docs', 5]], [['Docs', 5]]]);
  // Locate, and a later import that brings a folder this machine has: a Windows path on Windows only.
  const dirs = Object.fromEntries(['remap', 'merge'].map((id) => [id, path.join(w.root, 'workspace', id)]));
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir);
  remapProjectPath(first.model, 'remap', dirs.remap);
  first.importBackup(backupOf({ merge: { path: dirs.merge, buckets: { src: 1 }, totalBuilds: 1 } }));
  const joined = ignoresCase(dirs.remap) ? [['Docs', 5]] : [['Docs', 3], ['docs', 2]];
  assert.deepEqual([buckets(first, 'remap'), buckets(first, 'merge')], [joined, [...joined, ['src', 1]]]);
  // The state file holds no path for it, and says its buckets were counted under one.
  const { restart } = readState(w.statePath).projects;
  assert.deepEqual([restart.path, restart.bucketsCounted], [null, true]);
  const second = w.live().tracker;
  adoptWindowsPath(second, 'restart');
  assert.deepEqual(buckets(second, 'restart'), [['Docs', 5]]);
});

test('a folder never has more builds than its project: a sum of casings stops at the total, which is at least the largest folder', async (t) => {
  const w = createWorld(t);
  const demo = path.join(w.root, 'workspace', 'demo');
  fs.mkdirSync(path.join(demo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(demo, 'src', 'a.js'), 'x');
  writeState(w.statePath, { version: 2, projects: {
    // A total that reads as none, and one smaller than a folder.
    demo: { path: demo, name: 'demo', totalBuilds: '7', buckets: { src: 7 } },
    smaller: { name: 'smaller', totalBuilds: 3, buckets: { docs: 6 } },
    // Casings counted under a path whose sum is more than the project's builds.
    capped: { path: '/work/capped', totalBuilds: 10, buckets: { Docs: 5, docs: 7 } },
    held: { path: 'C:\\Work\\held', totalBuilds: 1, buckets: { src: 1 } },
  } });
  const { tracker } = w.live();
  assert.deepEqual(['demo', 'smaller'].map((id) => project(tracker, id).totalBuilds), [7, 6]);
  // What the planet card shows: this planet's builds of the whole system's.
  const planet = await getPlanet(tracker.model, 'demo', 'src');
  const system = getSystem(tracker.model, 'demo');
  assert.deepEqual([planet.builds, planet.project.totalBuilds, system.planets.map((p) => [p.name, p.builds]), system.project.totalBuilds],
    [7, 7, [['src', 7]], 7]);
  // A later path joins them up to the total, and never below the larger.
  adoptWindowsPath(tracker, 'capped');
  assert.deepEqual(buckets(tracker, 'capped'), [['Docs', 10]]);
  // So does an import: the backup's casings, counted under a path, stop at the backup's total.
  tracker.importBackup(backupOf({ held: { path: 'work/held', buckets: { Docs: 5, docs: 7 }, totalBuilds: 9 } }));
  assert.deepEqual([buckets(tracker, 'held'), project(tracker, 'held').totalBuilds], [[['src', 1], ['Docs', 9]], 9]);
});

test('a pathless project that merged counted casings with uncounted ones stays within its total; one with no buckets takes the file\'s word', (t) => {
  const w = createWorld(t);
  writeState(w.statePath, { version: 2, projects: {
    // Counted under a path, kept with none: five builds, three written as Docs/ and two as docs/.
    keeps: { path: '\\\\server\\share\\keeps', buckets: { Docs: 3, docs: 2 }, totalBuilds: 5, firstSeen: T0 },
    // No path and no buckets yet.
    fresh: { name: 'fresh', firstSeen: T0 },
  } });
  const { tracker } = w.live();
  // Backup entries with no path counted nothing themselves: their two casings may be the same builds.
  tracker.importBackup(backupOf({
    keeps: { buckets: { Docs: 3, docs: 3 }, totalBuilds: 3 },
    fresh: { buckets: { Docs: 3, docs: 3, src: 4 }, totalBuilds: 7 },
  }));
  assert.deepEqual([buckets(tracker, 'keeps'), project(tracker, 'keeps').bucketsCounted, project(tracker, 'fresh').bucketsCounted],
    [[['Docs', 3], ['docs', 3]], true, false]);
  for (const id of ['keeps', 'fresh']) adoptWindowsPath(tracker, id);
  // keeps: one flag cannot say which side each count came from. Added up as counted, 6 would pass
  // the project's 5 builds; the total stops it there, which is what the counted side holds.
  assert.deepEqual([buckets(tracker, 'keeps'), project(tracker, 'keeps').totalBuilds], [[['Docs', 5]], 5]);
  assert.deepEqual(buckets(tracker, 'fresh'), [['Docs', 3], ['src', 4]]);
});

test('the flag goes out in the state file and a backup and comes back, and stays out of what the renderer gets', (t) => {
  const w = createWorld(t);
  writeState(w.statePath, { version: 2, projects: {
    // A file from before the flag: counted when the record had a path, whatever became of it.
    counted: { path: '\\\\server\\share\\counted', buckets: { Docs: 3, docs: 2 }, totalBuilds: 5, firstSeen: T0 },
    loose: { name: 'loose', buckets: { Docs: 3, docs: 2 }, totalBuilds: 5, firstSeen: T0 },
  } });
  const first = w.live().tracker;
  assert.equal(first.saveState(), true);
  const saved = readState(w.statePath).projects;
  assert.deepEqual([saved.counted.path, saved.counted.bucketsCounted, saved.loose.path, saved.loose.bucketsCounted], [null, true, null, false]);
  const target = w.live({ statePath: path.join(w.root, 'fresh', 'universe-state.json') }).tracker;
  target.importBackup(parseBackup(JSON.stringify(first.createBackup([]))));
  const again = w.live().tracker;
  for (const tracker of [target, again]) {
    for (const id of ['counted', 'loose']) adoptWindowsPath(tracker, id);
    assert.deepEqual([buckets(tracker, 'counted'), buckets(tracker, 'loose')], [[['Docs', 5]], [['Docs', 3]]]);
  }
  const shown = first.snapshot().projects;
  assert.deepEqual([shown.length, shown.some((p) => Object.hasOwn(p, 'bucketsCounted'))], [2, false]);
});

test('a path that joins a folder\'s casings has its buckets counted from then on, given to a project or merged into one', () => {
  for (const [root, joins] of [['C:\\Work\\Demo', true], ['c:/work/demo', true], ['/work/demo', false], [null, false]]) {
    const given = { path: null, buckets: { Docs: 1, docs: 1 }, bucketsCounted: false, totalBuilds: 2 };
    setProjectPath(given, root);
    const merged = { path: root, buckets: {}, bucketsCounted: false };
    mergeBuckets(merged, { buckets: { Docs: 1 }, bucketsCounted: false, totalBuilds: 1 });
    assert.deepEqual([given.bucketsCounted, merged.bucketsCounted], [joins, joins], String(root));
  }
});

test('a path given back leaves the flag as it was', (t) => {
  const { model } = newModel(t);
  const loose = restoreProject(model, 'loose', savedProject({ name: 'loose', buckets: { Docs: 3, docs: 2 }, totalBuilds: 5 }));
  const before = loose.buckets;
  const giveBack = takeProjectPath(model, loose, 'C:\\Work\\loose');
  assert.deepEqual([own(loose.buckets), loose.bucketsCounted], [[['Docs', 3]], true]);
  giveBack();
  assert.deepEqual([loose.path, loose.buckets === before, loose.bucketsCounted], [null, true, false]);
});

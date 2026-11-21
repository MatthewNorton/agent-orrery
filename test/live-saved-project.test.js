'use strict';

// src/main/live/saved-project.js: the one reader of a project as the state file or a backup keeps
// it. Whatever either file holds, the same entry is the same project.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseBackup } = require('../src/main/live/backup');
const { savedProject, validKey } = require('../src/main/live/saved-project');
const { CASED_COUNTS, own, KEPT_APART } = require('./support/bucket-cases');
const { SEC, SLUG, T0, claude, createWorld, ofType, writeState } = require('./support/transcripts');
const { appendAndPoll, startClaude } = require('./support/live-session');

const MAX = Number.MAX_SAFE_INTEGER;
const LONG = 'n'.repeat(5000);

test('a saved project: only a record is one, and each field is checked', () => {
  for (const entry of [null, undefined, 5, 'demo', true, ['src']]) assert.equal(savedProject(entry), null, String(entry));
  assert.deepEqual(savedProject({}), { path: null, bucketsCounted: true, name: undefined, lastActivity: 0, firstSeen: 0, totalBuilds: 0, buckets: {} });

  // A name is plain text that fits the screen: no control character (C0, DEL or C1), 4,096 characters at most.
  const nameOf = (name) => savedProject({ name }).name;
  assert.deepEqual(['demo', 'n'.repeat(4096), 'with space'].map(nameOf), ['demo', 'n'.repeat(4096), 'with space']);
  for (const name of ['bell\u0007name', 'nul\u0000', 'del\u007f', 'c1\u0085', LONG, 'n'.repeat(4097), '', 42, ['x'], { toString: 'x' }, null, '__proto__', 'constructor']) {
    assert.equal(nameOf(name), undefined, JSON.stringify(name).slice(0, 30));
  }
  assert.deepEqual([validKey('posix:/work/demo'), validKey('__proto__'), validKey('a\nb'), validKey(7)], [true, false, false, false]);

  // A count or a time is a whole count (shared/values.js): 1e400 reads as Infinity.
  const counts = savedProject(JSON.parse('{ "totalBuilds": "9", "firstSeen": 1700000000000.4, "lastActivity": 1e400 }'));
  assert.deepEqual([counts.totalBuilds, counts.firstSeen, counts.lastActivity], [0, 1700000000000, 0]);
  assert.deepEqual([9.9, -3, 1e308, NaN, null, '12', [4]].map((totalBuilds) => savedProject({ totalBuilds }).totalBuilds), [9, 0, MAX, 0, 0, 0, 0]);
  // No folder has more builds than its project: the total is at least the largest bucket.
  assert.deepEqual([{ totalBuilds: '7', buckets: { src: 7 } }, { totalBuilds: 3, buckets: { docs: 6, src: 2 } }, { totalBuilds: 9, buckets: { src: 2 } }]
    .map((raw) => savedProject(raw).totalBuilds), [7, 6, 9]);

  // Only a string is a path. Whether the app may use it is the rule of the file it came from.
  // Whether the buckets were counted under a path is the file's (a boolean); a file from before
  // that says it by whether the record had a path, whatever became of the path.
  const read = (raw) => (({ path: p, bucketsCounted }) => [p, bucketsCounted])(savedProject({ buckets: { src: 1 }, ...raw }));
  assert.deepEqual([7, '', null, ['C:\\x'], 'relative/x', '/work/demo'].map((p) => read({ path: p })),
    [[null, false], [null, false], [null, false], [null, false], ['relative/x', true], ['/work/demo', true]]);
  assert.deepEqual([{ bucketsCounted: true }, { path: '/work/demo', bucketsCounted: false }, { bucketsCounted: 'yes' }, { path: '/work/demo', bucketsCounted: 0 }]
    .map(read), [[null, true], ['/work/demo', false], [null, false], ['/work/demo', true]]);
  // Buckets that are none have nothing to join: counted, whatever the record says.
  assert.deepEqual([{}, { bucketsCounted: false }, { bucketsCounted: false, buckets: { 'a/b': 3 } }].map((raw) => savedProject(raw).bucketsCounted), [true, true, true]);
});

test('a saved project\'s buckets: a folder name build-buckets.js counts, with a whole count above none', () => {
  // A string, a zero, a negative and a null count are no bucket; a fraction keeps its whole part; '__proto__' is a folder like any other.
  assert.deepEqual(own(savedProject({ buckets: JSON.parse(CASED_COUNTS) }).buckets), KEPT_APART);
  for (const odd of ['text', [3, 4], null, 7, undefined]) assert.deepEqual(savedProject({ buckets: odd }).buckets, {}, String(odd));
  const names = savedProject({ buckets: { 'tab\tname': 4, 'c1\u0085': 4, [LONG]: 4, '': 4, kept: 4, 'with space': 1, 'docs/api': 2, '..': 1,
    'a\\b': 1, ['x'.repeat(256)]: 1, '(root)': 3 } }).buckets;
  assert.deepEqual(own(names), [['kept', 4], ['with space', 1], ['(root)', 3]]);
  // At most 10,000 folders of one project are read.
  const many = Object.fromEntries(Array.from({ length: 10_050 }, (_, i) => ['f' + i, 1]));
  assert.deepEqual([Object.keys(savedProject({ buckets: many }).buckets).length, Object.hasOwn(savedProject({ buckets: many }).buckets, 'f9999')], [10_000, true]);
});

test('a state file and a backup holding the same odd entry give the same project', (t) => {
  const w = createWorld(t);
  const dir = (name) => {
    fs.mkdirSync(path.join(w.root, 'folders', name), { recursive: true });
    return path.normalize(fs.realpathSync.native(path.join(w.root, 'folders', name)));
  };
  const projects = {
    control: { name: 'bell\u0007name', totalBuilds: '12', buckets: { src: '3', lib: 2.9, 'tab\tname': 5 } },
    long: { name: LONG, totalBuilds: 2.5, firstSeen: 1700000000000.7, buckets: { [LONG]: 2, docs: -1 } },
    named: { name: 'kept by name', totalBuilds: 3, lastActivity: 1e308, buckets: { src: 3 } },
    pathed: { path: dir('pathed'), name: 'not\u0000used', totalBuilds: 1e308, lastActivity: -5, firstSeen: '1700000000000',
      buckets: { Docs: 1e308, docs: 1e308, neg: -1, half: 0.5, zero: 0, text: 'many', two: 2.5 } },
    unlisted: { path: dir('unlisted'), buckets: ['src'], totalBuilds: null },
    notOne: 'demo',
  };
  writeState(w.statePath, { version: 2, projects });
  const restored = w.live().tracker;
  const imported = w.live({ statePath: path.join(w.root, 'fresh', 'universe-state.json') }).tracker;
  assert.deepEqual(imported.importBackup(parseBackup(JSON.stringify({ format: 'agent-orrery-backup', version: 1, universe: { projects } }))), { added: 5, merged: 0 });

  const shape = (tracker) => Object.fromEntries([...tracker.model.projects.values()].map((p) => [p.id, {
    path: p.path, name: p.name, exists: p.exists, totalBuilds: p.totalBuilds, lastActivity: p.lastActivity, firstSeen: p.firstSeen, buckets: own(p.buckets),
  }]));
  const got = shape(restored);
  assert.deepEqual(got, shape(imported));
  assert.deepEqual(Object.keys(got).sort(), ['control', 'long', 'named', 'pathed', 'unlisted']);
  // A name that is not plain text is not kept: the project goes by its id, or by its folder.
  assert.deepEqual([got.control.name, got.long.name, got.named.name, got.pathed.name], ['control', 'long', 'kept by name', 'pathed']);
  // The total read as none is raised to the largest bucket.
  assert.deepEqual([got.control.totalBuilds, got.control.buckets], [2, [['lib', 2]]]);
  assert.deepEqual([got.long.totalBuilds, got.long.firstSeen, got.long.buckets], [2, 1700000000000, []]);
  assert.deepEqual([got.named.lastActivity, got.pathed.totalBuilds, got.pathed.lastActivity, got.unlisted.buckets], [MAX, MAX, 0, []]);
  // Docs and docs are one folder under a Windows path, two elsewhere; either way no count passes the largest kept.
  const docs = got.pathed.buckets.filter(([name]) => name.toLowerCase() === 'docs');
  assert.deepEqual([got.pathed.buckets.filter((bucket) => !docs.includes(bucket)), docs.every(([, builds]) => builds === MAX)], [[['two', 2]], true]);
});

test('a planet\'s builds are the same after a restart, also in a folder whose name can be no bucket', (t) => {
  const session = startClaude(t);
  const { dir, tracker, world } = session;
  // Names a folder can have on some disk (DEL and C1 on NTFS, tab and ESC on POSIX) that a file
  // keeps no bucket of: their builds count in the totals only, before the restart and after it.
  const names = ['tab\tdir', 'esc\u001bdir', 'del\u007fdir', 'c1\u0085dir', 'src'];
  const events = appendAndPoll(session, names.map((name, index) => claude.tool(dir, T0 + (1 + index) * SEC, `toolu_${index}`, 'Edit',
    { file_path: path.join(dir, name, 'a.js') })), T0 + 9 * SEC);
  assert.deepEqual(ofType(events, 'build').map((event) => event.isNew), [false, false, false, false, true]);
  const counts = (live) => [live.model.projects.get(SLUG).totalBuilds, own(live.model.projects.get(SLUG).buckets), live.snapshot().projects[0].planets];
  const before = counts(tracker);
  assert.deepEqual(before, [5, [['src', 1]], ['src']]);
  tracker.stop();
  const again = world.live();
  assert.deepEqual(counts(again.tracker), before);
  // And a build there after the restart starts no planet either.
  again.tracker.scan(true);
  again.take();
  const after = appendAndPoll({ ...session, ...again }, [claude.tool(dir, T0 + 20 * SEC, 'toolu_next', 'Edit',
    { file_path: path.join(dir, 'del\u007fdir', 'b.js') })], T0 + 20 * SEC);
  assert.deepEqual(ofType(after, 'build').map((event) => event.isNew), [false]);
  assert.deepEqual(counts(again.tracker), [6, [['src', 1]], ['src']]);
});

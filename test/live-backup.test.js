'use strict';

// Universe backups: an export brings a universe back on a fresh install, an import merges and
// never removes, and a file from anywhere cannot put a hostile id, name or path in the model.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseBackup } = require('../src/main/live/backup');
const { MIN, T0, createWorld, writeState } = require('./support/transcripts');

function byId(tracker) {
  return new Map(tracker.snapshot().projects.map((project) => [project.id, project]));
}

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

  const projects = byId(target);
  assert.equal(projects.get('demo').path, w.projectDir);
  assert.equal(projects.get('demo').exists, true);
  assert.equal(projects.get('demo').totalBuilds, 4);
  assert.deepEqual({ ...target.model.projects.get('moved').buckets }, { lib: 2 });
  const saved = JSON.parse(fs.readFileSync(freshState, 'utf8'));
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
  const projects = byId(tracker);
  assert.deepEqual([...projects.keys()].sort(), ['gone', 'kept', 'local']);
  assert.deepEqual({ ...tracker.model.projects.get('kept').buckets }, { src: 3, docs: 4 });
  assert.equal(projects.get('kept').totalBuilds, 5);
  assert.equal(projects.get('kept').firstSeen, T0 - 9 * MIN);
  assert.equal(projects.get('kept').lastActivity, T0 - 2 * MIN);
  assert.equal(projects.get('gone').totalBuilds, 7);
  assert.deepEqual({ ...tracker.model.forgotten }, {});
});

test('a file that is not a backup is refused', () => {
  for (const text of ['not json', '[]', '{}', JSON.stringify({ format: 'agent-orrery-backup', version: 2, universe: { projects: {} } }),
    JSON.stringify({ format: 'something-else', version: 1, universe: { projects: {} } }),
    JSON.stringify({ format: 'agent-orrery-backup', version: 1, universe: { projects: [] } })]) {
    assert.equal(parseBackup(text), null, text);
  }
});

test('hostile ids, names, buckets and paths never reach the model', () => {
  const local = process.platform === 'win32' ? 'C:\\work\\demo' : '/work/demo';
  const backup = parseBackup(`{
    "format": "agent-orrery-backup", "version": 1,
    "universe": {
      "projects": {
        "__proto__": { "totalBuilds": 1 },
        "constructor": { "totalBuilds": 1 },
        "bad\\u0007id": { "totalBuilds": 1 },
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
  assert.deepEqual([...projects.keys()].sort(), ['device', 'fine', 'relative', 'share']);
  assert.equal(projects.get('share').path, null);
  assert.equal(projects.get('share').totalBuilds, 0);
  assert.equal(projects.get('device').path, null);
  assert.equal(projects.get('relative').path, null);
  assert.equal(projects.get('relative').name, undefined);
  assert.equal(projects.get('fine').path, local);
  assert.equal(projects.get('fine').totalBuilds, 2);
  assert.deepEqual(projects.get('fine').buckets, { src: 2 });
  assert.deepEqual(backup.pathIds, [['posix:/work/demo', 'fine']]);
  assert.deepEqual(backup.ideas, ['keep']);
});

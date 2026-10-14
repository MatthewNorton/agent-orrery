'use strict';

// Projects outlive their transcripts: universe-state.json brings them back, keeps them, and
// survives a bad write.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadState } = require('../src/main/live/state-file');
const { canonicalProjectPath } = require('../src/main/provider-adapters');
const { createWorld } = require('./support/transcripts');

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state));
}

test('a version 1 file with no transcripts left still yields its projects, folder casing restored', (t) => {
  const w = createWorld(t);
  const projectDir = path.join(w.root, 'Demo-App');
  fs.mkdirSync(projectDir);
  writeState(w.statePath, {
    projects: {
      'demo-app': { buckets: { src: 4, docs: 1 }, totalBuilds: 5, firstSeen: 1000 },
      'gone:1': { buckets: { lib: 2 }, totalBuilds: 2, firstSeen: 2000 },
    },
    pathIds: { [canonicalProjectPath(projectDir)]: 'demo-app', 'win:c:/no/such/folder': 'gone:1' },
  });
  const { tracker } = w.live();
  tracker.start();
  const projects = tracker.snapshot().projects;
  assert.deepEqual(projects.map((p) => p.id).sort(), ['demo-app', 'gone:1']);
  const demo = projects.find((p) => p.id === 'demo-app');
  assert.equal(demo.exists, true);
  assert.equal(demo.name, 'Demo-App');
  assert.equal(demo.totalBuilds, 5);
  assert.deepEqual(demo.planets.sort(), ['docs', 'src']);
  const gone = projects.find((p) => p.id === 'gone:1');
  assert.equal(gone.exists, false);
  assert.equal(gone.name, 'folder');
  assert.equal(gone.lastActivity, 2000);

  assert.ok(tracker.saveState(true));
  const saved = JSON.parse(fs.readFileSync(w.statePath, 'utf8'));
  assert.equal(saved.version, 2);
  assert.equal(saved.projects['demo-app'].name, 'Demo-App');
  assert.equal(path.basename(saved.projects['demo-app'].path), 'Demo-App');
  assert.equal(saved.projects['gone:1'].lastActivity, 2000);
});

test('loading keeps the file it found as the backup for the whole run', (t) => {
  const w = createWorld(t);
  writeState(w.statePath, { version: 2, projects: { kept: { totalBuilds: 3, firstSeen: 1 } } });
  const { tracker } = w.live();
  tracker.start();
  assert.ok(tracker.saveState(true));
  assert.ok(tracker.saveState(true));
  const backup = JSON.parse(fs.readFileSync(w.statePath + '.bak', 'utf8'));
  assert.deepEqual(backup.projects, { kept: { totalBuilds: 3, firstSeen: 1 } });
  assert.equal(JSON.parse(fs.readFileSync(w.statePath, 'utf8')).projects.kept.totalBuilds, 3);
});

test('an unreadable file falls back to its backup; a missing one starts empty', (t) => {
  const w = createWorld(t);
  writeState(w.statePath + '.bak', { version: 2, projects: { fromBackup: { totalBuilds: 1 } } });
  fs.writeFileSync(w.statePath, '{"projects": {');
  assert.deepEqual(Object.keys(loadState(w.statePath).projects), ['fromBackup']);
  assert.deepEqual(loadState(path.join(w.root, 'none.json')), { version: 2, projects: {} });
});

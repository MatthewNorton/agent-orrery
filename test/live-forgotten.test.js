'use strict';

// Forgetting a project: it leaves the map and the state file, stays gone while its transcripts
// hold only older work, and comes back as a new system once an agent works there again.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalProjectPath } = require('../src/main/provider-adapters');
const {
  CODEX_SESSION, MIN, SLUG, T0, appendJsonl, claude, codex, createWorld, writeState,
} = require('./support/transcripts');

function ids(tracker) {
  return tracker.snapshot().projects.map((project) => project.id).sort();
}

function savedState(w) {
  return JSON.parse(fs.readFileSync(w.statePath, 'utf8'));
}

test('a forgotten project stays gone across scans and restarts while its transcripts are older', (t) => {
  const w = createWorld(t);
  const other = path.join(w.root, 'workspace', 'other');
  fs.mkdirSync(other, { recursive: true });
  appendJsonl(w.claudeFile(), [claude.prompt(w.projectDir, T0 - 60 * MIN)], T0 - 60 * MIN);
  appendJsonl(w.codexFile(), [codex.meta(T0 - 60 * MIN, CODEX_SESSION, other)], T0 - 60 * MIN);
  const { tracker } = w.live();
  tracker.scan(true);
  const codexId = ids(tracker).find((id) => id !== SLUG);
  assert.equal(ids(tracker).length, 2);

  tracker.forgetProject(SLUG);
  tracker.forgetProject(codexId);
  tracker.scan(false);
  tracker.scan(false);
  assert.deepEqual(ids(tracker), []);
  const saved = savedState(w);
  assert.deepEqual(saved.projects, {});
  assert.deepEqual(Object.values(saved.pathIds).sort(), [SLUG, codexId].sort(), 'path keys lead to the records');
  assert.deepEqual(Object.keys(saved.forgotten).sort(), [SLUG, codexId].sort());
  assert.equal(saved.forgotten[SLUG].at, T0);

  const restarted = w.live().tracker;
  restarted.scan(true);
  assert.deepEqual(ids(restarted), []);
});

test('newer work brings a forgotten project back as a new system', (t) => {
  const w = createWorld(t);
  writeState(w.statePath, {
    version: 2,
    projects: { [SLUG]: { path: w.projectDir, totalBuilds: 5, buckets: { src: 5 }, firstSeen: T0 - 90 * MIN } },
  });
  appendJsonl(w.claudeFile(), [claude.prompt(w.projectDir, T0 - 60 * MIN)], T0 - 60 * MIN);
  const { tracker } = w.live();
  tracker.scan(true);
  tracker.forgetProject(SLUG);
  tracker.scan(false);
  assert.deepEqual(ids(tracker), []);

  w.clock.set(T0 + 2 * MIN);
  appendJsonl(w.claudeFile(), [claude.prompt(w.projectDir, T0 + 2 * MIN)], T0 + 2 * MIN);
  tracker.scan(false);
  const back = tracker.snapshot().projects;
  assert.deepEqual(back.map((project) => project.id), [SLUG]);
  assert.equal(back[0].totalBuilds, 0, 'the old build history stays forgotten');
  assert.ok(tracker.saveState(true));
  assert.deepEqual(savedState(w).forgotten, {});
});

test('a Claude folder mapped to another id is read once, then skipped by name', (t) => {
  const w = createWorld(t);
  appendJsonl(w.codexFile(), [codex.meta(T0 - 60 * MIN, CODEX_SESSION, w.projectDir)], T0 - 60 * MIN);
  const { tracker } = w.live();
  tracker.scan(true);
  appendJsonl(w.claudeFile(), [claude.prompt(w.projectDir, T0 - 50 * MIN)], T0 - 50 * MIN);
  tracker.scan(false);
  const [codexId] = ids(tracker);
  assert.notEqual(codexId, SLUG, 'the Claude transcript joined the project Codex found first');

  tracker.forgetProject(codexId);
  tracker.scan(false);
  assert.equal(tracker.model.forgottenSlugs.get(SLUG), codexId);
  tracker.scan(false);
  assert.deepEqual(ids(tracker), []);
});

test('a project forgotten after its folder moved stays gone under its old folder too', (t) => {
  const w = createWorld(t);
  const oldDir = path.join(w.root, 'workspace', 'old-demo');
  writeState(w.statePath, {
    version: 2,
    projects: { moved: { path: w.projectDir, firstSeen: T0 - 90 * MIN } },
    pathIds: { [canonicalProjectPath(oldDir)]: 'moved', [canonicalProjectPath(w.projectDir)]: 'moved' },
    pathOverrides: { moved: w.projectDir },
  });
  appendJsonl(w.claudeFile('C--workspace-old-demo'), [claude.prompt(oldDir, T0 - 60 * MIN)], T0 - 60 * MIN);
  const { tracker } = w.live();
  tracker.scan(true);
  assert.deepEqual(ids(tracker), ['moved']);

  tracker.forgetProject('moved');
  tracker.scan(false);
  tracker.scan(false);
  assert.deepEqual(ids(tracker), []);
});

test('a moved project may take the folder of a forgotten one', (t) => {
  const w = createWorld(t);
  writeState(w.statePath, {
    version: 2,
    projects: {
      [SLUG]: { path: w.projectDir, firstSeen: T0 - 90 * MIN },
      moved: { path: path.join(w.root, 'workspace', 'gone'), firstSeen: T0 - 90 * MIN },
    },
  });
  const { tracker } = w.live();
  tracker.scan(true);
  assert.throws(() => tracker.remapProjectPath('moved', w.projectDir), { code: 'IN_USE' });
  tracker.forgetProject(SLUG);
  assert.equal(tracker.remapProjectPath('moved', w.projectDir).id, 'moved');
  assert.deepEqual(ids(tracker), ['moved']);
});

test('forgetting is refused while an agent works in the project', (t) => {
  const w = createWorld(t);
  appendJsonl(w.claudeFile(), [claude.prompt(w.projectDir, T0 - MIN)], T0 - MIN);
  const { tracker } = w.live();
  tracker.scan(true);
  assert.equal(tracker.ships.size, 1);
  assert.throws(() => tracker.forgetProject(SLUG), { code: 'ACTIVE' });
  assert.throws(() => tracker.forgetProject('no-such-project'), { code: 'NOT_FOUND' });
  assert.deepEqual(ids(tracker), [SLUG]);
});

test('a forget that cannot be saved leaves the project as it was', (t) => {
  const w = createWorld(t);
  appendJsonl(w.claudeFile(), [claude.prompt(w.projectDir, T0 - 60 * MIN)], T0 - 60 * MIN);
  const { tracker } = w.live();
  tracker.scan(true);
  fs.rmSync(w.statePath, { force: true });
  fs.mkdirSync(w.statePath, { recursive: true });

  assert.throws(() => tracker.forgetProject(SLUG), { code: 'FAILED' });
  assert.deepEqual(ids(tracker), [SLUG]);
  assert.deepEqual({ ...tracker.model.forgotten }, {});
  tracker.scan(false);
  assert.deepEqual(ids(tracker), [SLUG]);
  fs.rmSync(w.statePath, { recursive: true, force: true });
});

'use strict';

// src/main/live/projects.js: project ids for Codex/Signal paths, path overrides, existence and
// moved-project recovery.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLiveModel } = require('../src/main/live/model');
const {
  ensureProjectForPath, preferredProjectPath, refreshProjectExistence, remapProjectPath,
} = require('../src/main/live/projects');
const { canonicalProjectPath } = require('../src/main/provider-adapters');
const { hex8 } = require('./support/transcripts');

function newModel(t, { statePath, persisted } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'au-live-projects-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = statePath ? statePath(root) : path.join(root, 'state', 'universe-state.json');
  if (persisted) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(persisted));
  }
  const published = [];
  const model = createLiveModel(file, { claudeProjectsDir: path.join(root, 'none'), codexSessionDirs: [],
    providerConfigPath: path.join(root, 'providers.json') }, (batch) => published.push(...batch));
  // Flushed events first, then whatever is still queued: seq order either way.
  const take = () => [...published.splice(0), ...model.pending.splice(0)].map((event) => event.type === 'feed'
    ? ['feed', event.entry.text] : [event.type, event.project.id]);
  const dir = (name) => {
    const full = path.join(root, name);
    fs.mkdirSync(full, { recursive: true });
    return full;
  };
  return { root, file, model, take, dir };
}

function record(id, projectPath, exists) {
  return {
    id, path: projectPath, name: projectPath ? path.basename(projectPath) : id, exists,
    lastActivity: 0, totalBytes: 0, buckets: {}, totalBuilds: 0, firstSeen: 0,
  };
}

test('live projects: a path keeps one id; a fallback id taken by another path gets a hash suffix', (t) => {
  const { model, take, dir } = newModel(t);
  const a = dir('a');
  const b = dir('b');
  const first = ensureProjectForPath(model, a, 'shared', 5, 0);
  const second = ensureProjectForPath(model, b, 'shared', 6, 0);
  const third = ensureProjectForPath(model, dir('c'), null, 7, 0);

  assert.deepEqual([first.id, first.name, first.exists, first.lastActivity], ['shared', 'a', true, 5]);
  assert.equal(second.id, `shared:${hex8(canonicalProjectPath(b))}`);
  assert.equal(third.id, `project:${hex8(canonicalProjectPath(third.path))}`);
  assert.equal(ensureProjectForPath(model, `${a}${path.sep}`, 'other', 9, 0), first, 'a known path keeps its id');
  assert.equal(first.lastActivity, 9);
  assert.equal(ensureProjectForPath(model, '\\\\host\\share\\x', 'unc', 1, 0), null);
  assert.deepEqual(take(), [['project-added', 'shared'], ['project-added', second.id], ['project-added', third.id]]);
  assert.deepEqual({ ...model.pathIds }, {
    [canonicalProjectPath(a)]: 'shared', [canonicalProjectPath(b)]: second.id,
    [canonicalProjectPath(third.path)]: third.id,
  });
});

test('live projects: a pathless Claude project whose slug matches the path adopts it', (t) => {
  const { model, take, dir } = newModel(t);
  const repo = dir('repo');
  const slug = repo.replace(/[^A-Za-z0-9]/g, '-');
  model.projects.set(slug, record(slug, null, false));

  const project = ensureProjectForPath(model, repo, 'codex-id', 7, 0);
  assert.equal(project.id, slug);
  assert.deepEqual([project.path, project.name, project.exists, project.lastActivity], [repo, 'repo', true, 7]);
  assert.deepEqual(take(), [['project-updated', slug]]);
});

test('live projects: a saved override wins over the discovered path; network paths never show', (t) => {
  const moved = path.join(os.tmpdir(), 'au-moved-project');
  const { model } = newModel(t, { persisted: { projects: {}, pathOverrides: { p1: moved, p2: 'relative' } } });
  assert.equal(preferredProjectPath(model, 'p1', '/elsewhere'), path.normalize(moved));
  assert.equal(preferredProjectPath(model, 'p2', '/elsewhere'), '/elsewhere', 'a relative override is dropped on load');
  assert.equal(preferredProjectPath(model, 'p3', '\\\\host\\share\\x'), null);
});

test('live projects: refreshProjectExistence announces a folder that disappeared', (t) => {
  const { model, take, dir } = newModel(t);
  const repo = dir('repo');
  model.projects.set('p', record('p', repo, true));
  model.systemCache.set('p', { at: 0, data: null });
  refreshProjectExistence(model);
  assert.deepEqual(take(), []);

  fs.rmSync(repo, { recursive: true });
  refreshProjectExistence(model);
  assert.deepEqual(take(), [['project-updated', 'p']]);
  assert.equal(model.projects.get('p').exists, false);
  assert.equal(model.systemCache.has('p'), false);
});

test('live projects: remapProjectPath refuses with a code, then recovers and saves the new path', (t) => {
  const { root, file, model, take, dir } = newModel(t);
  const moved = dir('moved');
  const here = dir('here');
  fs.writeFileSync(path.join(root, 'file.txt'), 'x');
  model.projects.set('missing', record('missing', path.join(root, 'gone'), false));
  model.projects.set('here', record('here', here, true));
  const code = (id, next) => {
    try { remapProjectPath(model, id, next); return 'OK'; } catch (error) { return error.code; }
  };

  assert.deepEqual([
    code('nope', moved), code('here', moved), code('missing', 'relative/dir'),
    code('missing', path.join(root, 'absent')), code('missing', path.join(root, 'file.txt')), code('missing', here),
  ], ['NOT_FOUND', 'NOT_MISSING', 'INVALID', 'NOT_FOUND', 'INVALID', 'IN_USE']);
  assert.deepEqual(take(), []);

  const real = path.normalize(fs.realpathSync.native(moved));
  const visible = remapProjectPath(model, 'missing', moved);
  assert.deepEqual([visible.path, visible.name, visible.exists], [real, 'moved', true]);
  assert.deepEqual(take(), [['project-updated', 'missing'], ['feed', 'Project path recovered: moved']]);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pathOverrides.missing, real);
  assert.equal(code('missing', moved), 'NOT_MISSING');
});

test('live projects: remapProjectPath rolls everything back when the state file cannot be saved', (t) => {
  const { model, take, dir } = newModel(t, { statePath: (root) => {
    fs.writeFileSync(path.join(root, 'blocker'), 'x');
    return path.join(root, 'blocker', 'universe-state.json');
  } });
  const moved = dir('moved');
  const gone = path.join(path.dirname(moved), 'gone');
  model.projects.set('missing', record('missing', gone, false));

  assert.throws(() => remapProjectPath(model, 'missing', moved), { code: 'FAILED' });
  const project = model.projects.get('missing');
  assert.deepEqual([project.path, project.name, project.exists], [gone, 'gone', false]);
  assert.deepEqual([{ ...model.pathOverrides }, model.projectPathIndex.size, { ...model.pathIds }], [{}, 0, {}]);
  assert.deepEqual(take(), []);
});

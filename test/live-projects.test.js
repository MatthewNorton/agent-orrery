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
  adoptProjectPath, ensureProjectForPath, preferredProjectPath, refreshProjectExistence, remapProjectPath, restoreProject,
} = require('../src/main/live/projects');
const { ignoresCase } = require('../src/main/path-safety');
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
  const buckets = { Docs: 5, docs: 7 };
  model.projects.set('missing', { ...record('missing', gone, false), buckets });

  assert.throws(() => remapProjectPath(model, 'missing', moved), { code: 'FAILED' });
  const project = model.projects.get('missing');
  assert.deepEqual([project.path, project.name, project.exists], [gone, 'gone', false]);
  assert.equal(project.buckets, buckets, 'the counts as they were');
  assert.deepEqual(Object.entries(buckets), [['Docs', 5], ['docs', 7]]);
  assert.deepEqual([{ ...model.pathOverrides }, model.projectPathIndex.size, { ...model.pathIds }], [{}, 0, {}]);
  assert.deepEqual(take(), []);
});

test('live projects: a folder keeps one bucket by the rule of the path its project has', (t) => {
  const { model, dir } = newModel(t);
  const counts = () => JSON.parse('{ "Docs": 5, "docs": 7, "src": 1, "__proto__": 2 }');
  // A temp folder is a Windows path on Windows only: there Docs and docs are one folder.
  const kept = (project) => [Object.entries(project.buckets),
    ignoresCase(project.path) ? [['Docs', 12], ['src', 1], ['__proto__', 2]] : Object.entries(counts())];
  // From a state file or a backup.
  const here = restoreProject(model, 'here', { path: dir('here'), buckets: counts(), totalBuilds: 15 });
  assert.deepEqual(...kept(here));
  assert.equal(here.totalBuilds, 15);
  // No path tells no two names apart or together; the folder the project then gets decides.
  const pathless = restoreProject(model, 'pathless', { name: 'pathless', buckets: counts() });
  assert.deepEqual(Object.entries(pathless.buckets), Object.entries(counts()));
  adoptProjectPath(model, pathless, dir('adopted'));
  assert.deepEqual(...kept(pathless));
  // Counted under a POSIX path, on another machine, and recovered to a folder here.
  const moved = restoreProject(model, 'moved', { path: '/work/elsewhere', buckets: counts() });
  assert.deepEqual([moved.path, Object.entries(moved.buckets)], ['/work/elsewhere', Object.entries(counts())]);
  remapProjectPath(model, 'moved', dir('moved'));
  assert.deepEqual(...kept(moved));
  // Buckets that are no object count nothing.
  assert.deepEqual(restoreProject(model, 'odd', { path: dir('odd'), buckets: /** @type {any} */ ('text') }).buckets, {});
});

test('live projects: a count a state file holds is made a whole count, and casings of 1e308 add up to the largest kept', (t) => {
  const { model, file, dir } = newModel(t);
  const MAX = Number.MAX_SAFE_INTEGER;
  // 1e400 reads as Infinity. Joined as they stood, "5" and 7 made the string "57", and the two 1e308 Infinity, which saves as null.
  const saved = () => JSON.parse('{ "buckets": { "Docs": "5", "docs": 7, "src": 2.9, "big": 1e308, "BIG": 1e308, "none": null, "neg": -3 },'
    + ' "totalBuilds": "9", "firstSeen": "soon", "lastActivity": 1e400 }');
  const exact = restoreProject(model, 'exact', { path: '/work/elsewhere', ...saved() });
  assert.deepEqual(Object.entries(exact.buckets), [['docs', 7], ['src', 2], ['big', MAX], ['BIG', MAX]]);
  assert.deepEqual([exact.totalBuilds, exact.lastActivity, typeof exact.firstSeen, exact.firstSeen > 0], [0, 0, 'number', true]);
  const here = restoreProject(model, 'here', { path: dir('here'), ...saved(), totalBuilds: 9.5, firstSeen: 1700000000000.4 });
  assert.deepEqual(Object.entries(here.buckets), ignoresCase(here.path) ? [['docs', 7], ['src', 2], ['big', MAX]] : Object.entries(exact.buckets));
  assert.deepEqual([here.totalBuilds, here.firstSeen, here.lastActivity], [9, 1700000000000, 1700000000000]);
  // A path that joins the casings adds them up, and stops at the largest count kept.
  remapProjectPath(model, 'exact', dir('moved'));
  if (ignoresCase(exact.path)) assert.deepEqual(Object.entries(exact.buckets), [['docs', 7], ['src', 2], ['big', MAX]]);
  const written = fs.readFileSync(file, 'utf8');
  assert.equal(/null|Infinity|"57"/.test(JSON.stringify(Object.values(JSON.parse(written).projects).map((project) => project.buckets))), false, written);
});

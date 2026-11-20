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
const { casedCounts, KEPT_APART, KEPT_AS_ONE, KEPT_LARGER } = require('./support/bucket-cases');
const { projectsById } = require('./support/live-session');
const { createWorld, hex8, readState, writeState } = require('./support/transcripts');

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
  assert.equal(readState(file).pathOverrides.missing, real);
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
  const { model, file, dir } = newModel(t);
  // A temp folder is a Windows path on Windows only: there Docs and docs are one folder.
  const kept = (project) => [Object.entries(project.buckets), ignoresCase(project.path) ? KEPT_AS_ONE : KEPT_APART];
  // From a state file or a backup: every count a whole one, and the casings a path joins added up.
  const here = restoreProject(model, 'here', { path: dir('here'), buckets: casedCounts(), totalBuilds: 15 });
  assert.deepEqual(...kept(here));
  assert.equal(here.totalBuilds, 15);
  // No path tells no two names apart or together; the folder the project then gets decides. It
  // counted no build without a path, so two casings may be two records of the same builds: the
  // larger stays, by adoption and by recovery alike.
  const larger = (project) => [Object.entries(project.buckets), ignoresCase(project.path) ? KEPT_LARGER : KEPT_APART];
  const pathless = restoreProject(model, 'pathless', { name: 'pathless', buckets: casedCounts() });
  assert.deepEqual(Object.entries(pathless.buckets), KEPT_APART);
  adoptProjectPath(model, pathless, dir('adopted'));
  assert.deepEqual(...larger(pathless));
  const recovered = restoreProject(model, 'recovered', { name: 'recovered', buckets: casedCounts() });
  remapProjectPath(model, 'recovered', dir('recovered'));
  assert.deepEqual(...larger(recovered));
  // A saved project with no path of its own that an override gives a folder.
  model.pathOverrides.overridden = dir('overridden');
  assert.deepEqual(...larger(restoreProject(model, 'overridden', { buckets: casedCounts() })));
  // Counted under a POSIX path, on another machine, and recovered to a folder here.
  const moved = restoreProject(model, 'moved', { path: '/work/elsewhere', buckets: casedCounts() });
  assert.deepEqual([moved.path, Object.entries(moved.buckets)], ['/work/elsewhere', KEPT_APART]);
  remapProjectPath(model, 'moved', dir('moved'));
  assert.deepEqual(...kept(moved));
  // Buckets that are no object count nothing.
  ['text', [3, 4], null, 7].forEach((odd, i) => {
    assert.deepEqual(restoreProject(model, 'odd' + i, { path: dir('odd' + i), buckets: /** @type {any} */ (odd) }).buckets, {}, String(odd));
  });
  // The state file the recovery wrote holds whole counts only: no "46", and no null for an Infinity.
  const written = Object.values(readState(file).projects).flatMap((project) => Object.values(project.buckets));
  assert.deepEqual([written.length > 0, written.filter((count) => !Number.isSafeInteger(count))], [true, []]);
});

test('live projects: a total or a time a state file holds is made a whole count', (t) => {
  const { model, dir } = newModel(t);
  // 1e400 reads as Infinity.
  const saved = () => JSON.parse('{ "totalBuilds": "9", "firstSeen": "soon", "lastActivity": 1e400 }');
  const odd = restoreProject(model, 'odd', { path: dir('odd'), ...saved() });
  assert.deepEqual([odd.totalBuilds, odd.lastActivity, typeof odd.firstSeen, odd.firstSeen > 0], [0, 0, 'number', true]);
  const here = restoreProject(model, 'here', { path: dir('here'), ...saved(), totalBuilds: 9.5, firstSeen: 1700000000000.4 });
  assert.deepEqual([here.totalBuilds, here.firstSeen, here.lastActivity], [9, 1700000000000, 1700000000000]);
});

test('live projects: a state file with entries that are not project records starts the app with the good ones', (t) => {
  // A file from before version 2 (its paths come from pathIds, through migrate) and one of today.
  const world = createWorld(t);
  for (const version of [undefined, 2]) {
    const statePath = path.join(world.root, 'state-' + version, 'universe-state.json');
    fs.mkdirSync(path.join(world.root, 'workspace', 'kept'), { recursive: true });
    const kept = path.normalize(fs.realpathSync.native(path.join(world.root, 'workspace', 'kept')));
    const keyOf = (...parts) => canonicalProjectPath(path.join(world.root, ...parts));
    const projects = JSON.parse(`{
      "a": null, "b": 5, "c": ["src"], "d": "demo", "e": true,
      "good": { "name": "kept by name", "totalBuilds": 3, "buckets": { "src": 3 } },
      "numbered": { "name": 42 }, "listed": { "name": ["x"] }, "nested": { "name": { "toString": "x" } },
      "pathed": { "path": 7, "name": "seven" }
    }`);
    const state = { version, projects, pathIds: Object.fromEntries(['a', 'b', 'c', 'good'].map((id) => [keyOf('gone', id), id])) };
    if (version) projects.here = { path: kept, name: 'ignored for a folder' };
    else state.pathIds[keyOf('workspace', 'kept')] = 'pathed'; // the folder of an entry whose own path is not a string
    writeState(statePath, state);

    const { tracker } = world.live({ statePath });
    const shown = projectsById(tracker);
    const names = Object.fromEntries([...shown].map(([id, project]) => [id, project.name]));
    assert.deepEqual(names, version
      ? { good: 'kept by name', numbered: 'numbered', listed: 'listed', nested: 'nested', pathed: 'seven', here: 'kept' }
      : { good: 'good', numbered: 'numbered', listed: 'listed', nested: 'nested', pathed: 'kept' },
    `version ${version}: every name the renderer gets is a string`);
    assert.deepEqual([shown.get('good').totalBuilds, shown.get('good').planets, shown.get('pathed').path], [3, ['src'], version ? null : kept]);
    assert.deepEqual(Object.keys(readState(statePath + '.bak').projects).length, version ? 11 : 10, 'the file it started from is kept as the backup');
  }
});

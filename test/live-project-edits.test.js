'use strict';

// src/main/live/project-edits.js: a missing project pointed at the folder it moved to. Forgetting
// one is test/live-forgotten.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { remapProjectPath } = require('../src/main/live/project-edits');
const { newModel, record } = require('./support/live-model');
const { readState } = require('./support/transcripts');

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

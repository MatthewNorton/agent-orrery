'use strict';

// src/renderer/app/project/tasks.js: the project task panel's edits, one at a time.

const test = require('node:test');
const assert = require('node:assert/strict');
const { runRenderer, settled } = require('./support/renderer-source');
const { fakeDocument, withClass } = require('./support/fake-dom');
const { deferred } = require('./support/main-wiring');

// tasks.js with its edit function reachable as A.mutateTasks: the panel's buttons and form call it
// and drop its promise.
function exposed(code) {
  const out = code.replace('  async function mutateTasks(', '  A.mutateTasks = mutateTasks;\n  async function mutateTasks(');
  assert.notEqual(out, code, 'mutateTasks was found');
  return out;
}

// The task panel of project p, shown and trusted, with main's answer to an edit from `answerWith`;
// `asked` lists the edits main was asked for.
function setup() {
  const state = {
    current: { view: 'system', projectId: 'p', planetName: null }, playback: { mode: 'live' },
    taskPanel: {
      owner: 0, request: 0, projectId: 'p', items: [], trusted: true, saving: false, refreshAfterSave: false,
      status: '', error: false, focusAfterRender: null, interval: null, els: null,
    },
  };
  const window = { AU: {} }, document = fakeDocument(), frames = [], logged = [];
  runRenderer('util.js', { window, document });
  window.AUR.app = { state };
  window.AUR.log = (...args) => logged.push(args.join(' '));
  runRenderer('app/project/tasks.js', { window, document, requestAnimationFrame: (fn) => frames.push(fn) }, exposed);
  const app = window.AUR.app;
  app.wireTasksPanel();
  const asked = [];
  let answer = async (text) => ({ ok: true, items: [{ text, done: false, line: 0 }] });
  const add = (text) => app.mutateTasks(() => { asked.push(text); return answer(text); }, true, { successText: 'Task added' });
  return { app, state, asked, add, frames, logged, answerWith: (next) => { answer = next; } };
}

test('tasks: one edit at a time, and the panel takes the next once it is answered', async () => {
  const { state, asked, add, answerWith } = setup();
  const held = deferred();
  answerWith(() => held.promise);
  const first = add('one');
  assert.equal(state.taskPanel.saving, true);
  await add('refused');
  held.resolve({ ok: true, items: [{ text: 'one', done: false, line: 0 }] });
  await first;
  assert.deepEqual([asked, state.taskPanel.saving, state.taskPanel.status], [['one'], false, 'Task added']);
});

test('tasks: an edit whose render throws leaves the panel open to the next edit, and drawn so', async () => {
  const { state, asked, add, frames } = setup();
  const { panel, input } = state.taskPanel.els;
  const setAttribute = panel.setAttribute;
  panel.setAttribute = (name, value) => {
    if (name === 'aria-busy' && value === 'true') { input.disabled = true; throw new Error('render failed'); }
    setAttribute(name, value);
  };
  await assert.rejects(add('one'), /render failed/);
  assert.deepEqual([state.taskPanel.saving, asked], [false, []], 'not left saving until the next view switch');
  panel.setAttribute = setAttribute;
  assert.equal(frames.length, 1, 'the panel is drawn again, as the busy flag went up');
  frames.shift()();
  assert.deepEqual([panel.getAttribute('aria-busy'), input.disabled], ['false', false]);
  await add('two');
  assert.deepEqual([asked, state.taskPanel.saving, state.taskPanel.status, frames.length], [['two'], false, 'Task added', 0],
    'an edit drawn as it went up is drawn by its answer alone');
});

test('tasks: a tick or an add whose render throws as the edit goes up is logged, not left unhandled', async () => {
  const { state, add, logged } = setup();
  await add('one');
  const { panel, list, form, input } = state.taskPanel.els;
  const setAttribute = panel.setAttribute;
  panel.setAttribute = (name, value) => {
    if (name === 'aria-busy' && value === 'true') throw new Error('render failed');
    setAttribute(name, value);
  };
  const unhandled = await settled(() => {
    withClass(list, 'task-toggle')[0].fire('click');
    input.value = 'two';
    form.fire('submit');
  });
  assert.deepEqual([unhandled, logged], [[], [
    'click handler failed: Error: render failed', 'submit handler failed: Error: render failed',
  ]]);
});

test('tasks: an edit the panel has moved on from leaves the flag to the next session\'s edit', async () => {
  const { app, state, add, answerWith } = setup();
  const late = deferred(), next = deferred();
  answerWith(() => late.promise);
  const old = add('old');
  app.stopTasksView(); // the view switched away and back, to the same project
  Object.assign(state.taskPanel, { projectId: 'p', trusted: true });
  answerWith(() => next.promise);
  const current = add('new');
  late.resolve({ ok: true, items: [] });
  await old;
  assert.equal(state.taskPanel.saving, true, 'the new session\'s edit still holds the flag');
  next.resolve({ ok: true, items: [{ text: 'new', done: false, line: 0 }] });
  await current;
  assert.deepEqual([state.taskPanel.saving, state.taskPanel.items.map((item) => item.text)], [false, ['new']]);
});

'use strict';

// src/renderer/app/ideas.js: the IDEAS queue's edits, one at a time.

const test = require('node:test');
const assert = require('node:assert/strict');
const { runApp } = require('./support/renderer-source');
const { fakeDocument } = require('./support/fake-dom');
const { deferred } = require('./support/main-wiring');

function setup() {
  const state = {
    ideaPanel: { request: 0, items: [], busy: false, refreshAfterBusy: false, selections: new Map(), status: '', error: false, els: null },
    playback: { mode: 'live' }, replayTransitionPending: false, store: { projects: new Map() },
  };
  const asked = [];
  let answer = Promise.resolve({ ok: true });
  const AU = { rootTaskRetry: (id) => { asked.push(id); return answer; } };
  const scheduled = [];
  const app = { state, const: { CHROME: { IDEAS: 64 } }, renderIdeas() {}, scheduleChrome: (mask) => scheduled.push(mask) };
  runApp(['app/ideas.js'], app, { window: { AU }, document: fakeDocument() });
  return { app, state, asked, scheduled, answerWith: (next) => { answer = next; } };
}

test('ideas: one edit at a time, and the queue takes the next when it is answered', async () => {
  const { app, state, asked, answerWith } = setup();
  const held = deferred();
  answerWith(held.promise);
  const first = app.retryIdea('one');
  assert.deepEqual([state.ideaPanel.busy, app.ideaMutationsDisabled()], [true, true]);
  await app.retryIdea('refused');
  held.resolve({ ok: false, code: 'BUSY' });
  await first;
  assert.deepEqual([asked, state.ideaPanel.busy, state.ideaPanel.status, state.ideaPanel.error],
    [['one'], false, 'That idea is already being updated.', true]);
});

test('ideas: an edit whose render throws leaves the queue open to the next edit, and drawn so', async () => {
  const { app, state, asked, scheduled } = setup();
  let renders = 0;
  app.renderIdeas = () => { if (renders++ === 0) throw new Error('render failed'); };
  await assert.rejects(app.retryIdea('one'), /render failed/);
  assert.deepEqual([state.ideaPanel.busy, app.ideaMutationsDisabled(), asked], [false, false, []], 'not left busy for the session');
  assert.deepEqual(scheduled, [64], 'the panel is drawn again, as the busy flag went up');
  await app.retryIdea('two');
  assert.deepEqual([asked, state.ideaPanel.busy, state.ideaPanel.status], [['two'], false, 'Agent start requested again']);
  assert.deepEqual(scheduled, [64], 'an edit drawn as it went up is drawn by its answer alone');
});

'use strict';

// src/renderer/app/project/settings.js: the Settings dialog's requests, one at a time.

const test = require('node:test');
const assert = require('node:assert/strict');
const { runApp } = require('./support/renderer-source');
const { fakeDocument, fakeElement } = require('./support/fake-dom');
const { deferred } = require('./support/main-wiring');

function setup() {
  const state = {
    projectSettings: { open: true, owner: 0, request: 0, busy: false, status: '', error: false, els: { close: fakeElement('button') } },
    playback: { mode: 'live' }, replayTransitionPending: false,
  };
  state.projectSettings.els.close.focus = () => {};
  const scheduled = [];
  const app = { state, const: { CHROME: { SETTINGS: 32 } }, scheduleChrome: (mask) => scheduled.push(mask) };
  runApp(['app/project/settings.js'], app, { window: { AU: {} }, document: fakeDocument() });
  app.renderProjectSettings = () => {};
  return { app, state, scheduled };
}

test('settings requests: one at a time; a request the dialog has left behind answers nothing and frees nothing', async () => {
  const { app, state } = setup();
  const held = deferred();
  const first = app.runSettingsRequest('Working', () => held.promise);
  assert.deepEqual([state.projectSettings.busy, state.projectSettings.status], [true, 'Working']);
  assert.equal(await app.runSettingsRequest('Again', async () => 'second'), null, 'refused while one is out');
  held.resolve('first');
  assert.deepEqual([await first, state.projectSettings.busy], ['first', false]);

  // The dialog was closed and opened again while a request was out: the flag is the new session's.
  const late = deferred();
  const old = app.runSettingsRequest('Working', () => late.promise);
  Object.assign(state.projectSettings, { owner: state.projectSettings.owner + 1, busy: false });
  const next = deferred();
  const current = app.runSettingsRequest('Working', () => next.promise);
  late.resolve('late');
  assert.deepEqual([await old, state.projectSettings.busy], [null, true], 'the new session\'s request still holds the flag');
  next.resolve('next');
  assert.deepEqual([await current, state.projectSettings.busy], ['next', false]);
});

test('settings requests: one whose render throws leaves the dialog open to the next, and drawn so', async () => {
  const { app, state, scheduled } = setup();
  let renders = 0;
  app.renderProjectSettings = () => { if (renders++ === 0) throw new Error('render failed'); };
  await assert.rejects(app.runSettingsRequest('Working', async () => 'never asked'), /render failed/);
  assert.equal(state.projectSettings.busy, false, 'not left busy for the session');
  assert.deepEqual(scheduled, [32], 'the dialog is drawn again, as the busy flag went up');
  assert.equal(await app.runSettingsRequest('Working', async () => 'answered'), 'answered');
  assert.deepEqual(scheduled, [32], 'a request drawn as it went up is drawn by its caller alone');
});

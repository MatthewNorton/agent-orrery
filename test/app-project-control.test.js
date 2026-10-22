'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readRenderer } = require('./support/renderer-source');
const { deferred } = require('./support/main-wiring');

function setup() {
  const calls = [];
  const pending = deferred();
  const state = { projectControl: { projectId: null }, terminalRequestSerial: 0,
    playback: { mode: 'live' }, replayTransitionPending: false, replayBusy: false };
  const app = { state, const: { CHROME: { PROJECT: 1, FOCUS: 2 } }, renderChromeNow() {} };
  const window = { AUR: { app, settle: (call) => call() },
    AU: { openTerminal(id) { calls.push(id); return pending.promise; } } };
  vm.runInNewContext(readRenderer('app/project/control.js'), { window });
  return { app, state, calls, pending };
}

test('cockpit terminal actions preserve the exact ship ID through the bridge', async () => {
  const { app, calls, pending } = setup();
  const request = app.requestProjectTerminal('project', 'ship:codex:second');
  assert.deepEqual(calls, ['ship:codex:second']);
  assert.equal(app.projectControlPresentation('project', 'ship:codex:second').disabled, true);
  await app.requestProjectTerminal('project', 'ship:codex:first');
  assert.equal(calls.length, 1, 'other ships cannot bypass an in-flight request');
  pending.resolve({ ok: false, code: 'TERMINAL_NOT_FOUND' });
  await request;
  assert.match(app.projectControlPresentation('project', 'ship:codex:second').note, /existing terminal/);
  assert.equal(app.projectControlPresentation('project', 'ship:codex:first').phase, 'idle',
    'the previous agent’s result must not be attributed to a newly selected agent');
  assert.equal(app.projectControlPresentation('project').phase, 'idle');
});

test('project actions retain their project ID and replay blocks both target types', async () => {
  const { app, state, calls, pending } = setup();
  state.playback.mode = 'replay';
  await app.requestProjectTerminal('project', 'ship:codex:second');
  await app.requestProjectTerminal('project');
  assert.deepEqual(calls, []);
  state.playback.mode = 'live';
  const request = app.requestProjectTerminal('project');
  assert.deepEqual(calls, ['project']);
  pending.resolve({ ok: false, code: 'AMBIGUOUS' });
  await request;
  assert.match(app.projectControlPresentation('project').note, /Select an agent/);
});

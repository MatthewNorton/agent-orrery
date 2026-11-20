'use strict';

// src/renderer/app/project/control.js and forget.js on a page, drawn through the real chrome queue
// (app/chrome-queue.js): the project card's busy actions, Open Terminal and Forget.

const test = require('node:test');
const assert = require('node:assert/strict');
const { runApp } = require('./support/renderer-source');
const { fakeDocument, withClass } = require('./support/fake-dom');
const { deferred } = require('./support/main-wiring');

// The system view of project p with its card drawn. Main holds each terminal and forget it is asked
// for in `asked` until the test answers it; frames run when the test runs them.
function page() {
  const document = fakeDocument(), frames = [], asked = [], logged = [];
  const ask = (kind) => (id) => { const held = deferred(); asked.push({ kind, id, held }); return held.promise; };
  const project = (id) => ({ id, name: id, exists: true, totalBuilds: 0, lastActivity: 0 });
  const state = {
    current: { view: 'system', projectId: 'p' }, store: { projects: new Map([['p', project('p')], ['q', project('q')]]), ships: new Map() },
    projectControl: { projectId: null }, terminalRequestSerial: 0, projectForget: { projectId: null, pending: false, note: '' },
    playback: { mode: 'live' }, replayTransitionPending: false, replayBusy: false,
  };
  const app = {
    state, const: { CHROME: { PROJECT: 1, FOCUS: 2 } }, shipsInProject: () => [], playbackReferenceTs: () => 0,
    moduleHead: (card) => card.appendChild(document.createElement('h2')), renderAgentFocus() {}, adoptLiveRestart() {},
  };
  runApp(['app/chrome-queue.js', 'app/project/control.js', 'app/project/forget.js'], app, {
    document, window: { AU: { openTerminal: ask('terminal'), projectForget: ask('forget') } },
    aur: { ProjectVcsStatus: { renderDetails() {} }, log: (...args) => logged.push(args.join(' ')) },
    globals: { requestAnimationFrame: (fn) => frames.push(fn) },
  });
  app.renderProjectCard();
  const button = (cls) => withClass(document.getElementById('project-card'), cls)[0];
  const shown = (cls) => [button(cls).textContent, button(cls).disabled];
  const runFrames = () => { while (frames.length) frames.shift()(); };
  return { app, state, asked, logged, button, shown, runFrames };
}

test('a terminal request whose cockpit render throws as it goes up leaves the card\'s button free once its frame has run', async () => {
  const { app, asked, shown, runFrames } = page();
  let focusRenders = 0;
  app.renderAgentFocus = () => { if (focusRenders++ === 0) throw new Error('focus render failed'); };
  await assert.rejects(app.requestProjectTerminal('p'), /focus render failed/);
  assert.deepEqual(shown('project-terminal'), ['Opening…', true], 'drawn as the request went up');
  runFrames();
  assert.deepEqual([shown('project-terminal'), asked], [['Open Terminal', false], []], 'and main was not asked');
});

test('a forget whose card render throws as it goes up leaves the card\'s Forget free once its frame has run', async () => {
  const { app, asked, shown, runFrames } = page();
  const draw = app.renderProjectCard;
  let cardRenders = 0;
  app.renderProjectCard = () => { draw(); if (cardRenders++ === 0) throw new Error('card render failed'); };
  await assert.rejects(app.forgetFromCard('p'), /card render failed/);
  assert.deepEqual(shown('pc-forget'), ['Forget…', true], 'drawn as the forget went up');
  runFrames();
  assert.deepEqual([shown('pc-forget'), asked], [['Forget…', false], []], 'and main was not asked');
});

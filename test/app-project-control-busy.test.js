'use strict';

// src/renderer/app/project/control.js and forget.js on a page, drawn through the real chrome queue
// (app/chrome-queue.js): the project card's busy actions, Open Terminal and Forget.

const test = require('node:test');
const assert = require('node:assert/strict');
const { runApp, settled } = require('./support/renderer-source');
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

test('an Open Terminal answer that comes back after the card moved on leaves the next project\'s request on Opening…', async () => {
  const { app, state, asked, shown } = page();
  const first = app.requestProjectTerminal('p');
  state.current.projectId = 'q';
  app.renderProjectCard();
  const second = app.requestProjectTerminal('q');
  asked[0].held.resolve({ ok: true });
  await first;
  app.renderProjectCard();
  assert.deepEqual(shown('project-terminal'), ['Opening…', true], 'q\'s request holds the button');
  asked[1].held.resolve({ ok: true });
  await second;
  assert.deepEqual(shown('project-terminal'), ['Open Terminal', false]);
});

// A card button's click whose render throws as its action goes up (`raise`) or once main answers.
const THROWN_CLICKS = [
  { button: 'project-terminal', render: 'renderAgentFocus', at: 'raise' },
  { button: 'project-terminal', render: 'renderAgentFocus', at: 'answer' },
  { button: 'pc-forget', render: 'renderProjectCard', at: 'raise' },
  { button: 'pc-forget', render: 'renderProjectCard', at: 'answer' },
];

for (const { button: cls, render, at } of THROWN_CLICKS) {
  test(`a click on the card's ${cls} whose render throws at its ${at} is logged, not left unhandled`, async () => {
    const { app, asked, logged, button } = page();
    const draw = app[render], throwAt = at === 'raise' ? 0 : 1;
    let renders = 0;
    app[render] = () => { draw(); if (renders++ === throwAt) throw new Error('render failed'); };
    const unhandled = await settled(() => {
      button(cls).fire('click');
      if (at === 'answer') asked[0].held.resolve({ ok: true, canceled: true });
    });
    assert.deepEqual([unhandled, logged], [[], ['click handler failed: Error: render failed']]);
  });
}

test('a click on the cockpit\'s Open Terminal whose render throws as it goes up is logged, not left unhandled', async () => {
  const logged = [];
  const document = fakeDocument(['agent-focus', 'agent-focus-frame', 'agent-focus-exit', 'agent-focus-folder', 'agent-focus-terminal']);
  const C = {
    CHROME: { PROJECT: 1, FOCUS: 2, AGENTS: 4 }, AGENT_FOCUS_VANTAGES: { forward: {} },
    AGENT_FOCUS_ENVIRONMENTS: { exterior: { camera: 'exterior', label: 'Exterior', asset: null } },
  };
  const state = {
    current: { view: 'system', projectId: 'p' }, store: { ships: new Map([['s', { id: 's', project: 'p' }]]) },
    projectControl: { projectId: null }, terminalRequestSerial: 0, playback: { mode: 'live' }, replayTransitionPending: false,
    agentFocus: { shipId: 's' },
  };
  const app = { state, const: C, renderChromeNow() { throw new Error('render failed'); }, scheduleChrome() {} };
  runApp(['app/project/control.js', 'app/agent-focus.js'], app, {
    document, window: { AU: { openTerminal: () => new Promise(() => {}) }, matchMedia: () => ({ matches: false }) },
    aur: { log: (...args) => logged.push(args.join(' ')) },
  });
  app.wireAgentFocus();
  const unhandled = await settled(() => document.getElementById('agent-focus-terminal').fire('click'));
  assert.deepEqual([unhandled, logged], [[], ['click handler failed: Error: render failed']]);
});

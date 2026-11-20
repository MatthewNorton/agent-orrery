'use strict';

// src/renderer/app/project/forget.js: forgetting a project from its card, one request at a time.

const test = require('node:test');
const assert = require('node:assert/strict');
const { runApp } = require('./support/renderer-source');
const { fakeDocument } = require('./support/fake-dom');
const { deferred } = require('./support/main-wiring');

const COULD_NOT = 'The project could not be forgotten.';

// The card's forget with main's answer from `answerWith`, by default `forgets`: main forgets a
// project once and finds it no more after. `asked` lists the projects main was asked to forget;
// `logged` holds what AUR.log was given.
function setup() {
  const state = { projectForget: { projectId: null, pending: false, note: '' } };
  const asked = [], logged = [], forgotten = new Set();
  const forgets = async (id) => (forgotten.has(id) ? { ok: false, code: 'NOT_FOUND' } : (forgotten.add(id), { ok: true, canceled: false }));
  let answer = forgets;
  const AU = { projectForget: (id) => { asked.push(id); return answer(id); } };
  const app = { state, const: { CHROME: { PROJECT: 1 } }, renderChromeNow() {}, adoptLiveRestart() {} };
  runApp(['app/project/forget.js'], app, { window: { AU }, document: fakeDocument(), aur: { log: (...args) => logged.push(args.join(' ')) } });
  return { app, state, asked, logged, answerWith: (next) => { answer = next; } };
}

test('forget from the card: pending while main is asked, then a note for a refusal', async () => {
  const { app, state, asked, answerWith } = setup();
  const held = deferred();
  answerWith(() => held.promise);
  const first = app.forgetFromCard('p');
  assert.deepEqual(state.projectForget, { projectId: 'p', pending: true, note: '' });
  await app.forgetFromCard('q');
  held.resolve({ ok: false, code: 'ACTIVE' });
  await first;
  assert.deepEqual([asked, state.projectForget], [['p'], {
    projectId: 'p', pending: false, note: 'An agent is working in this project. Forget it once the agent leaves.',
  }], 'one at a time: q was refused while p was out');
});

test('forget from the card: a render or a call that throws leaves the card free to forget again', async () => {
  const { app, state, asked, answerWith } = setup();
  let renders = 0;
  app.renderChromeNow = () => { if (renders++ === 0) throw new Error('render failed'); };
  await assert.rejects(app.forgetFromCard('p'), /render failed/);
  assert.deepEqual([state.projectForget.pending, asked], [false, []], 'not left pending for the session, and main was not asked');

  answerWith(async () => { throw new Error('main is away'); });
  await app.forgetFromCard('p');
  assert.deepEqual(state.projectForget, { projectId: 'p', pending: false, note: COULD_NOT });

  answerWith(async () => ({ ok: true, canceled: false }));
  await app.forgetFromCard('p');
  assert.deepEqual([state.projectForget, asked], [{ projectId: 'p', pending: false, note: '' }, ['p', 'p']]);
});

test('forget from the card: a reseed that fails after main forgot the project is logged, and the card says what main did', async () => {
  const { app, state, asked, logged } = setup();
  app.adoptLiveRestart = () => { throw new Error('no snapshot'); };
  await app.forgetFromCard('p');
  assert.deepEqual(state.projectForget, { projectId: 'p', pending: false, note: '' }, 'forgotten, as main says');
  assert.deepEqual(logged.map((line) => line.includes('no snapshot')), [true]);
  // Asked again, main has it no more.
  app.adoptLiveRestart = () => {};
  await app.forgetFromCard('p');
  assert.deepEqual([state.projectForget.note, asked], ['This project is already gone.', ['p', 'p']]);
});

'use strict';

// src/renderer/app/replay.js A.issueReplay: a replay command holds the history bar busy until main
// answers, and the events that came meanwhile go after the answer.

const test = require('node:test');
const assert = require('node:assert/strict');
const { runApp } = require('./support/renderer-source');
const { fakeDocument } = require('./support/fake-dom');
const { deferred } = require('./support/main-wiring');

// Replay commands with main's answer from `answerWith`; `handled` lists the event batches let
// through, and `logged` what AUR.log was given.
function setup() {
  const state = {
    replayRequest: 0, replayTransitionPending: false, replayBusy: false, historyPreviewTs: 5,
    transitionEventQueue: [], deferredEpochBatches: [], retiredEpochs: new Set(), streamEpoch: 1, booting: false,
    playback: { mode: 'live' },
  };
  const handled = [], logged = [];
  let answer = async () => ({ playback: { mode: 'replay' } });
  const AU = { replay: () => answer() };
  const CHROME = { HISTORY: 1, PROJECT: 2, FOCUS: 4, SETTINGS: 8, IDEAS: 16, FEED: 32 };
  const app = { state, const: { CHROME }, renderChromeNow() {}, handleSequencedEvents: (batch) => handled.push(batch) };
  runApp(['app/replay.js'], app, { window: { AU }, document: fakeDocument(), aur: { log: (...args) => logged.push(args.join(' ')) } });
  // An event batch that arrives while a command is out waits in the queue (app/boot.js routeEvents).
  const arrive = (batch) => state.transitionEventQueue.push({ batch, meta: {} });
  const flags = () => [state.replayBusy, state.replayTransitionPending];
  return { app, state, handled, logged, arrive, flags, answerWith: (next) => { answer = next; } };
}

test('replay: busy while main answers, then the events that waited, after the answer', async () => {
  const { app, state, handled, arrive, flags, answerWith } = setup();
  const held = deferred();
  answerWith(() => held.promise);
  const seek = app.issueReplay({ action: 'seek', ts: 5 });
  assert.deepEqual(flags(), [true, true]);
  arrive('meanwhile');
  assert.deepEqual(handled, []);
  held.resolve({ playback: { mode: 'replay', cursorTs: 5 } });
  await seek;
  assert.deepEqual([flags(), handled, state.playback.mode, state.historyPreviewTs], [[false, false], ['meanwhile'], 'replay', null]);
});

test('replay: a render or a call that throws leaves the bar free and lets the waiting events through', async () => {
  const { app, handled, logged, arrive, flags, answerWith } = setup();
  let renders = 0;
  app.renderChromeNow = () => { if (renders++ === 0) throw new Error('render failed'); };
  arrive('before');
  await assert.rejects(app.issueReplay({ action: 'seek', ts: 5 }), /render failed/);
  assert.deepEqual([flags(), handled], [[false, false], ['before']], 'not left busy, and LIVE events are not held from then on');

  answerWith(async () => { throw new Error('main is away'); });
  const live = app.issueReplay({ action: 'live' });
  arrive('meanwhile');
  await live;
  assert.deepEqual([flags(), handled, logged], [[false, false], ['before', 'meanwhile'], ['replay command failed main is away']]);
});

test('replay: a command overtaken by another leaves the flags and the waiting events to the newer one', async () => {
  const { app, handled, logged, arrive, flags, answerWith } = setup();
  const first = deferred(), second = deferred();
  answerWith(() => first.promise);
  const old = app.issueReplay({ action: 'seek', ts: 5 });
  answerWith(() => second.promise);
  const next = app.issueReplay({ action: 'seek', ts: 9 });
  arrive('meanwhile');
  first.reject(new Error('overtaken'));
  await old;
  assert.deepEqual([flags(), handled, logged], [[true, true], [], []], 'the newer command still holds them');
  second.resolve({ playback: { mode: 'replay', cursorTs: 9 } });
  await next;
  assert.deepEqual([flags(), handled], [[false, false], ['meanwhile']]);
});

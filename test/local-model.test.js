'use strict';

// The model a session runs, and whether it is local: read from its transcript, carried on the
// ship by the live tracker and by history alike, and inherited by the drones it launches.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { codexProviderIsLocal, claudeModel, modelName } = require('../src/main/transcripts/model');
const {
  SEC, MIN, T0, SLUG, CLAUDE_SESSION, CODEX_SESSION, appendJsonl, createWorld, ofType, claude, codex,
} = require('./support/transcripts');

const SHIP_ID = `ship:${SLUG}:${CLAUDE_SESSION}`;
const CODEX_SHIP_ID = `ship:codex:${CODEX_SESSION}`;
const withModel = (record, model) => ({ ...record, message: { ...record.message, model } });
const shipLocal = (snapshot, id) => snapshot.ships.find((ship) => ship.id === id).local;
const shipModel = (snapshot, id) => snapshot.ships.find((ship) => ship.id === id).model;

test('model names are printed as written, trimmed and capped, for any provider', () => {
  for (const name of ['claude-opus-5-5', 'gpt-6-astra', 'qwen3-coder:30b', 'opus', 'Qwen3-Coder-480B-A35B-Instruct-FP8', 'ñandú-7b']) {
    assert.equal(modelName(name), name);
  }
  assert.equal(modelName('  llama-3.3\u0007​ '), 'llama-3.3');
  assert.equal(modelName('m'.repeat(100)).length, 64);
  for (const value of [undefined, '', '   ', 42]) assert.equal(modelName(value), null);
});

test('model family: the Codex providers and Claude models that count as local', () => {
  for (const provider of ['ollama', 'LMStudio', 'oss', 'llama.cpp', 'vllm']) {
    assert.equal(codexProviderIsLocal(provider), true, provider);
  }
  for (const provider of ['openai', 'azure', 'openrouter']) assert.equal(codexProviderIsLocal(provider), false, provider);
  for (const provider of [undefined, '', 42]) assert.equal(codexProviderIsLocal(provider), null);
  assert.deepEqual(claudeModel('qwen3-coder:30b'), { local: true, model: 'qwen3-coder:30b' });
  for (const model of ['claude-opus-5-5', 'us.anthropic.claude-sonnet-5-5-v1:0']) {
    assert.deepEqual(claudeModel(model), { local: false, model }, model);
  }
  for (const model of [undefined, '', '<synthetic>']) assert.deepEqual(claudeModel(model), { local: null, model: null });
});

test('live: a Claude session turns local when a non-Claude model answers, its drone too, and back', (t) => {
  const world = createWorld(t);
  const file = world.claudeFile();
  const dir = world.projectDir;
  appendJsonl(file, [claude.prompt(dir, T0)], T0);
  const live = world.live();
  live.tracker.scan(true);
  assert.equal(shipLocal(live.tracker.snapshot(), SHIP_ID), false);
  live.take();

  world.clock.set(T0 + 5 * SEC);
  appendJsonl(file, [withModel(claude.tool(dir, T0 + 5 * SEC, 'toolu_task', 'Task', { description: 'Survey' }), 'qwen3-coder:30b')],
    T0 + 5 * SEC);
  live.tracker.pollFiles();
  const events = live.take();
  assert.ok(ofType(events, 'ship-updated').some((event) => event.ship.id === SHIP_ID && event.ship.local === true));
  assert.equal(ofType(events, 'ship-spawned')[0].ship.local, true, 'the drone inherits its parent\'s model');
  assert.equal(ofType(events, 'ship-spawned')[0].ship.model, 'qwen3-coder:30b');
  assert.equal(shipLocal(live.tracker.snapshot(), SHIP_ID), true);
  assert.equal(shipModel(live.tracker.snapshot(), SHIP_ID), 'qwen3-coder:30b');

  world.clock.set(T0 + 10 * SEC);
  appendJsonl(file, [withModel(claude.tool(dir, T0 + 10 * SEC, 'toolu_read', 'Read', { file_path: path.join(dir, 'a.js') }),
    'claude-opus-5-5')], T0 + 10 * SEC);
  live.tracker.pollFiles();
  assert.equal(shipLocal(live.tracker.snapshot(), SHIP_ID), false);
  assert.equal(shipModel(live.tracker.snapshot(), SHIP_ID), 'claude-opus-5-5');
});

test('live: a Codex rollout on a local model_provider docks a local ship at startup', (t) => {
  const world = createWorld(t);
  appendJsonl(world.codexFile(), [
    codex.meta(T0, CODEX_SESSION, world.projectDir, { model_provider: 'ollama', model: 'gpt-oss:20b' }),
  ], T0);
  const live = world.live();
  live.tracker.scan(true);
  assert.equal(shipLocal(live.tracker.snapshot(), CODEX_SHIP_ID), true);
  assert.equal(shipModel(live.tracker.snapshot(), CODEX_SHIP_ID), 'gpt-oss:20b');
});

test('live: a Codex session reports its model and follows a mid-session switch', (t) => {
  const world = createWorld(t);
  const file = world.codexFile();
  appendJsonl(file, [codex.meta(T0, CODEX_SESSION, world.projectDir, { model_provider: 'openai', model: 'gpt-6-astra' })], T0);
  const live = world.live();
  live.tracker.scan(true);
  assert.equal(shipModel(live.tracker.snapshot(), CODEX_SHIP_ID), 'gpt-6-astra');
  assert.equal(shipLocal(live.tracker.snapshot(), CODEX_SHIP_ID), false);
  live.take();

  world.clock.set(T0 + 5 * SEC);
  appendJsonl(file, [codex.turnContext(T0 + 5 * SEC, 'gpt-6.1-sol'), codex.event(T0 + 5 * SEC, 'task_started')], T0 + 5 * SEC);
  live.tracker.pollFiles();
  const events = live.take();
  assert.ok(ofType(events, 'ship-updated').some((event) => event.ship.id === CODEX_SHIP_ID && event.ship.model === 'gpt-6.1-sol'));
  assert.equal(shipModel(live.tracker.snapshot(), CODEX_SHIP_ID), 'gpt-6.1-sol');
});

test('history: local Claude and Codex sessions replay as local ships', async (t) => {
  const world = createWorld(t);
  const dir = world.projectDir;
  appendJsonl(world.claudeFile(), [
    claude.prompt(dir, T0),
    withModel(claude.tool(dir, T0 + 5 * SEC, 'toolu_read', 'Read', { file_path: path.join(dir, 'a.js') }), 'qwen3-coder:30b'),
    claude.turnDone(dir, T0 + MIN),
  ]);
  appendJsonl(world.codexFile(), [
    codex.meta(T0 + 2 * SEC, CODEX_SESSION, dir, { model_provider: 'lmstudio', model: 'gpt-oss:20b' }),
    codex.turnContext(T0 + 11 * SEC, 'gpt-oss:120b'),
    codex.event(T0 + 12 * SEC, 'task_started'),
  ]);
  const replay = world.replay();
  await replay.source.index();
  const snapshot = await replay.source.seek(T0 + MIN);
  assert.equal(shipLocal(snapshot, SHIP_ID), true);
  assert.equal(shipModel(snapshot, SHIP_ID), 'qwen3-coder:30b');
  assert.equal(shipLocal(snapshot, CODEX_SHIP_ID), true);
  assert.equal(shipModel(snapshot, CODEX_SHIP_ID), 'gpt-oss:120b');
});

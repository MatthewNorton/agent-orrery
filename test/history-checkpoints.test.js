'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHistoryModel } = require('../src/main/history/model');
const { planCheckpointTimes } = require('../src/main/history/checkpoint-plan');
const { createCheckpointStore } = require('../src/main/history/checkpoints');
const {
  SEC, MIN, T0, SLUG, CLAUDE_SESSION, iso, appendJsonl, createWorld, claude, codex,
} = require('./support/transcripts');

const OTHER_SLUG = 'C--workspace-other';
const CODEX_IDS = ['019f0000-0000-7000-8000-000000000401', '019f0000-0000-7000-8000-000000000402'];

// Three Claude and two Codex sessions over two projects, with idle gaps and drones.
function writeRichHistory(world) {
  const other = path.join(world.root, 'workspace', 'other');
  const dirs = [world.projectDir, other];
  fs.mkdirSync(path.join(other, 'src'), { recursive: true });
  for (let session = 0; session < 3; session++) {
    const dir = dirs[session % 2];
    let ts = T0 + session * 20 * MIN;
    const records = [claude.prompt(dir, ts)];
    for (let index = 0; index < 30; index++) {
      ts += index === 15 ? 8 * MIN : 45 * SEC;
      const id = `toolu_${session}_${index}`;
      const name = index % 7 === 3 ? 'Task' : index % 2 ? 'Edit' : 'Read';
      records.push(claude.tool(dir, ts, id, name, { file_path: path.join(dir, index % 3 ? 'src' : 'docs', `f${index}.js`) }));
      records.push(claude.result(dir, ts + 5 * SEC, id));
    }
    records.push(claude.turnDone(dir, ts + 10 * SEC));
    appendJsonl(world.claudeFile(session % 2 ? OTHER_SLUG : SLUG, `${CLAUDE_SESSION.slice(0, -1)}${session}`), records);
  }
  CODEX_IDS.forEach((id, session) => {
    let ts = T0 + 10 * MIN + session * 25 * MIN;
    const records = [codex.meta(ts, id, dirs[session])];
    for (let index = 0; index < 20; index++) {
      ts += index === 10 ? 9 * MIN : 50 * SEC;
      records.push(codex.event(ts, 'task_started'), codex.patchCall(ts + SEC, `call-${session}-${index}`),
        codex.patched(ts + 2 * SEC, `call-${session}-${index}`, [path.join(dirs[session], 'lib', `g${index}.js`)]),
        codex.patchOutput(ts + 3 * SEC, `call-${session}-${index}`), codex.event(ts + 4 * SEC, 'task_complete'));
    }
    appendJsonl(world.codexFile(id), records);
  });
}

function views(source) {
  const snapshot = source.snapshot();
  return {
    snapshot,
    status: source.status(),
    systems: snapshot.projects.map((project) => [source.getSystem(project.id),
      source.getSystem(project.id).planets.map((planet) => source.getPlanet(project.id, planet.name))]),
  };
}

function internals(source) {
  const state = source._model.state;
  return {
    model: JSON.stringify({
      projects: [...state.projects], projectIdByPath: [...state.projectIdByPath],
      ships: [...state.ships].map(([id, ship]) => [id, { ...ship, pending: [...ship.pending] }]),
      feed: state.feed, runtimeBySource: [...state.runtimeBySource], providerCounters: [...state.providerCounters],
      seenBuildSignals: [...state.seenBuildSignals], eventSequence: state.eventSequence,
    }),
    cursors: [...source._sourceCursors].sort((a, b) => a[0].localeCompare(b[0])).map(([key, cursor]) => [key, {
      unread: cursor.buffer.length > cursor.bufferStart ? cursor.bufferOffset : cursor.readOffset,
      adapterState: cursor.adapterState, claudeSessionEmitted: cursor.claudeSessionEmitted,
      lastEffectiveTs: cursor.lastEffectiveTs, blockedUntil: cursor.blockedUntil, done: cursor.done, partial: cursor.partial,
      pending: cursor.pendingRecords.map((record) => [record.offset, record.ordinal, record.ts, JSON.stringify(record.signal)]),
    }]),
    partial: source._partial,
  };
}

// A source with checkpoints and a cold twin (empty plan) over the same history.
async function twins(t, write = writeRichHistory, options = {}) {
  const world = createWorld(t);
  write(world);
  const pair = [world.replay(options), world.replay(options)].map(({ source }) => {
    const batches = [];
    source.on('events', (batch) => batches.push(batch));
    return { source, batches };
  });
  for (const { source } of pair) await source.index();
  pair[1].source._checkpoints.reset([]);
  return { world, warm: pair[0], cold: pair[1] };
}

function assertSame(warm, cold, label) {
  assert.deepEqual(views(warm.source), views(cold.source), label);
  assert.deepEqual(internals(warm.source), internals(cold.source), label);
  assert.deepEqual(warm.batches.splice(0), cold.batches.splice(0), label);
}

async function both(pair, fn) {
  for (const side of pair) await fn(side.source);
}

test('checkpoints: planned times split the indexed bytes evenly inside the range', () => {
  const entries = [
    { startMs: 0, endMs: 1000, size: 1000 },
    { startMs: 500, endMs: 1500, size: 3000 },
    { startMs: 2000, endMs: 2000, size: 1000 },
  ];
  // Bytes by t: A gives t, B adds 3(t - 500) from 500; goals are 1000, 2000, 3000 and 4000.
  const times = planCheckpointTimes(entries, 0, 2000, 4);
  assert.deepEqual(times, [625, 875, 1167, 1500]);
  assert.deepEqual(planCheckpointTimes([], 0, 10), []);
  assert.deepEqual(planCheckpointTimes(entries, 5, 5), []);
  assert.deepEqual(planCheckpointTimes(entries, null, null), []);
});

test('checkpoints: the byte budget thins evenly and drops evicted times from the plan', () => {
  const state = createHistoryModel({ batchSize: () => 1, onBatch() {}, preferredProjectId: () => undefined }).state;
  const store = createCheckpointStore({ maxBytes: 350, measure: () => 100 });
  store.reset([10, 20, 30, 40, 50, 60, 70]);
  for (const time of [10, 20, 30, 40, 50, 60, 70]) store.capture(time, state, new Map());
  assert.deepEqual(store.checkpoints.map((checkpoint) => checkpoint.time), [20, 40, 60]);
  assert.deepEqual(store.stats(), { planned: 3, count: 3, bytes: 300, restores: 0, stale: 0, evicted: 4 });
  assert.deepEqual(store.boundaries(-Infinity, Infinity), [], 'evicted times are not captured again');
  store.capture(35, state, new Map());
  assert.equal(store.stats().count, 3, 'only planned times are captured');

  const counted = createCheckpointStore({ maxCount: 2, measure: () => 1 });
  counted.reset([1, 2, 3]);
  for (const time of [1, 2, 3]) counted.capture(time, state, new Map());
  assert.deepEqual(counted.checkpoints.map((checkpoint) => checkpoint.time), [2, 3], 'ties go to the earliest');
});

test('checkpoints: the latest usable checkpoint honors stale marks', () => {
  const state = createHistoryModel({ batchSize: () => 1, onBatch() {}, preferredProjectId: () => undefined }).state;
  const store = createCheckpointStore({ measure: () => 1 });
  store.reset([10, 20, 30]);
  for (const time of [10, 20, 30]) store.capture(time, state, new Map());
  assert.equal(store.latest(5), null);
  assert.equal(store.latest(25).time, 20);
  store.invalidate(15, 28);
  assert.equal(store.latest(25).time, 20, 'still serves targets before the stale point');
  assert.equal(store.latest(29).time, 10);
  assert.equal(store.latest(35).time, 30);
  assert.equal(store.stats().stale, 1);
});

test('checkpoints: a seek served from a checkpoint equals a cold seek, then and afterwards', async (t) => {
  const { warm, cold } = await twins(t);
  const { minTs, maxTs } = warm.source.status();
  const at = (fraction) => minTs + Math.round((maxTs - minTs) * fraction);
  const plan = warm.source._checkpoints.boundaries(-Infinity, Infinity);
  assert.ok(plan.length >= 16, `${plan.length} planned times`);

  await both([warm, cold], (source) => source.seek(maxTs));
  assertSame(warm, cold, 'seek end');
  assert.equal(warm.source._checkpoints.stats().count, plan.length);

  const targets = [at(0.5), at(0.25), at(0.75), at(0.1), at(0.9), Math.floor((minTs + plan[0]) / 2),
    ...plan, ...plan.filter((_, index) => index % 5 === 0).flatMap((time) => [time - 1, time + 1])];
  for (const target of targets) {
    await both([warm, cold], (source) => source.seek(target));
    assertSame(warm, cold, `seek ${target - minTs}`);
    await both([warm, cold], (source) => source.advanceTo(target + 3 * MIN, { emit: true }));
    assertSame(warm, cold, `advance after seek ${target - minTs}`);
  }
  assert.ok(warm.source._checkpoints.stats().restores >= plan.length);
  assert.equal(warm.source._checkpoints.stats().stale, 0);
});

test('checkpoints: play ticks and a backward scrub match the cold twin', async (t) => {
  const clock = { wall: T0 + 60 * MIN };
  const sides = [];
  const options = {
    now: () => clock.wall,
    get scheduler() {
      const timers = [];
      sides.push(timers);
      return { setTimeout: (fn) => timers.push(fn), clearTimeout() {} };
    },
  };
  const { warm, cold } = await twins(t, writeRichHistory, options);
  const { minTs, maxTs } = warm.source.status();
  await both([warm, cold], (source) => source.seek(maxTs));
  await both([warm, cold], (source) => source.seek(minTs + (maxTs - minTs) * 0.4));
  assertSame(warm, cold, 'seek 40%');
  for (const { source } of [warm, cold]) {
    source.setSpeed(100);
    source.play();
  }
  for (let tick = 0; tick < 4; tick++) {
    clock.wall += 5 * SEC;
    for (const timers of sides) await timers.at(-1)();
    assertSame(warm, cold, `tick ${tick + 1}`);
  }
  for (const { source } of [warm, cold]) source.pause();
  await both([warm, cold], (source) => source.seek(minTs + (maxTs - minTs) * 0.3));
  assertSame(warm, cold, 'backward seek after play');
  assert.ok(warm.source._checkpoints.stats().restores > 0);
});

// A quiet line stamped ten minutes ahead hides an earlier edit from a seek that stops at it.
function writeOutOfOrder(world) {
  const dir = world.projectDir;
  appendJsonl(world.claudeFile(), [
    claude.prompt(dir, T0),
    claude.tool(dir, T0 + 10 * SEC, 'toolu_a', 'Edit', { file_path: path.join(dir, 'src', 'a.js') }),
    { type: 'system', subtype: 'note', timestamp: iso(T0 + 10 * MIN), cwd: dir },
    claude.tool(dir, T0 + 20 * SEC, 'toolu_b', 'Write', { file_path: path.join(dir, 'docs', 'b.md') }),
    claude.prompt(dir, T0 + 11 * MIN),
    claude.tool(dir, T0 + 12 * MIN, 'toolu_c', 'Edit', { file_path: path.join(dir, 'lib', 'c.js') }),
  ]);
}

test('checkpoints: a continuation that would apply an earlier record runs cold instead', async (t) => {
  const { warm, cold } = await twins(t, writeOutOfOrder);
  const store = warm.source._checkpoints;
  store.reset([T0 + 30 * SEC]);
  const end = warm.source.status().maxTs;
  await both([warm, cold], (source) => source.seek(end));
  assertSame(warm, cold, 'seek end');
  assert.equal(store.stats().stale, 1, 'the step past the quiet line found the earlier edit');
  assert.equal(store.checkpoints[0].invalidFrom, end);

  await both([warm, cold], (source) => source.seek(T0 + 5 * MIN));
  assertSame(warm, cold, 'inside the window, served from the checkpoint');
  assert.equal(store.stats().restores, 1);
  await both([warm, cold], (source) => source.seek(T0 + 10 * MIN + SEC));
  assertSame(warm, cold, 'past the quiet line');
  assert.equal(store.stats().stale, 2);
  assert.equal(store.latest(T0 + 10 * MIN + SEC), null);
  assert.equal(cold.source.snapshot().projects[0].totalBuilds, 2);
});

test('checkpoints: index() replans and stop() drops every checkpoint', async (t) => {
  const { warm } = await twins(t);
  const store = warm.source._checkpoints;
  await warm.source.seek(warm.source.status().maxTs);
  const planned = store.stats().planned;
  assert.ok(store.stats().count > 0);
  await warm.source.index();
  assert.deepEqual([store.stats().count, store.stats().planned], [0, planned]);
  await warm.source.seek(warm.source.status().maxTs);
  assert.ok(store.stats().count > 0);
  warm.source.stop();
  assert.deepEqual([store.stats().count, store.stats().planned], [0, 0]);
});

test('checkpoints: a seek cancelled mid-restore leaves the checkpoints intact', async (t) => {
  const { warm, cold } = await twins(t);
  const { minTs, maxTs } = warm.source.status();
  await both([warm, cold], (source) => source.seek(maxTs));
  const store = warm.source._checkpoints;
  const before = store.stats();
  // Claude session 3 edits every 45 s from T0 + 40 min, so this continuation has to read.
  const target = T0 + 45 * MIN;

  const open = warm.source._openStreamHandle.bind(warm.source);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let started;
  const reading = new Promise((resolve) => { started = resolve; });
  let held = false;
  warm.source._openStreamHandle = async (entry, cursor, handles) => {
    const handle = await open(entry, cursor, handles);
    if (held) return handle;
    held = true;
    const read = handle.read.bind(handle);
    handle.read = async (...args) => {
      started();
      await gate;
      return read(...args);
    };
    return handle;
  };
  const cancelled = warm.source.seek(target).then(() => null, (error) => error);
  await Promise.race([reading, new Promise((_, reject) => setTimeout(() => reject(new Error('no read to hold')), 5000))]);
  assert.equal(store.stats().restores, before.restores + 1, 'the cancelled seek restored a checkpoint');
  await both([warm, cold], (source) => source.seek(minTs + Math.round((maxTs - minTs) * 0.2)));
  release();
  assert.equal((await cancelled)?.code, 'ERR_REPLAY_CANCELLED');
  assertSame(warm, cold, 'the newer seek');
  assert.equal(store.stats().count, before.count);

  await both([warm, cold], (source) => source.seek(target));
  assertSame(warm, cold, 'the restored checkpoint was not touched by the cancelled seek');
});

test('checkpoints: a capturing pass cancelled midway stores nothing it did not finish', async (t) => {
  const { warm, cold } = await twins(t);
  const { maxTs } = warm.source.status();
  const store = warm.source._checkpoints;
  let calls = 0;
  const open = warm.source._openStreamHandle.bind(warm.source);
  warm.source._openStreamHandle = async (...args) => {
    calls++;
    if (calls === 12) warm.source.pause();
    return open(...args);
  };
  const error = await warm.source.seek(maxTs).then(() => null, (failure) => failure);
  assert.equal(error?.code, 'ERR_REPLAY_CANCELLED');
  const partial = store.stats().count;
  assert.ok(partial < store.stats().planned);
  warm.source._openStreamHandle = open;
  await both([warm, cold], (source) => source.seek(maxTs));
  assertSame(warm, cold, 'seek end after the cancelled pass');
  assert.equal(store.stats().count, store.stats().planned);
});

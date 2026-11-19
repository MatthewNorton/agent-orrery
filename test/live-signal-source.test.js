'use strict';

// src/main/live/signal-source.js, through the Tracker: Signal watch directories, files known by
// stat alone. Part of the characterization of the live model in tracker.test.js: it pins behaviour
// as it is.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { canonicalProjectPath, readGenericWatchConfig } = require('../src/main/provider-adapters');
const { SEC, MIN, T0, hex8, setMtime, createWorld, pick } = require('./support/transcripts');
const { sweepAt } = require('./support/live-session');

function signalWorld(t, { mtime = T0, extensions } = {}) {
  const world = createWorld(t);
  const signalDir = path.join(world.root, 'signals');
  const signalFile = path.join(signalDir, 'private.log');
  fs.mkdirSync(signalDir, { recursive: true });
  fs.writeFileSync(signalFile, 'PRIVATE_GENERIC_BYTES');
  setMtime(signalFile, mtime);
  fs.mkdirSync(path.dirname(world.providerConfigPath), { recursive: true });
  fs.writeFileSync(world.providerConfigPath, JSON.stringify({
    watch: [{ directory: signalDir, projectPath: world.projectDir, label: 'Fixture', extensions }],
  }));
  const sourceId = `watch-${hex8(canonicalProjectPath(signalDir))}`;
  const shipIdOf = (file) => `ship:generic:${sourceId}:${hex8(canonicalProjectPath(file))}`;
  return { world, signalDir, signalFile, shipId: shipIdOf(signalFile), shipIdOf };
}

// Records (rather than throws, which the tracker would swallow) any read of watched files.
function recordSignalReads(t, signalDir) {
  const reads = [];
  const inside = (file) => typeof file === 'string' && path.resolve(file).startsWith(signalDir + path.sep);
  const readFileSync = fs.readFileSync;
  const openSync = fs.openSync;
  const createReadStream = fs.createReadStream;
  t.mock.method(fs, 'readFileSync', function (file, ...args) {
    if (inside(file)) reads.push(['readFileSync', file]);
    return readFileSync.call(this, file, ...args);
  });
  t.mock.method(fs, 'openSync', function (file, flags, ...args) {
    if (inside(file) && (flags === undefined || /^r/.test(String(flags)))) reads.push(['openSync', file]);
    return openSync.call(this, file, flags, ...args);
  });
  t.mock.method(fs, 'createReadStream', function (file, ...args) {
    if (inside(file)) reads.push(['createReadStream', file]);
    return createReadStream.call(this, file, ...args);
  });
  return reads;
}

// Ported from kit/done/multi-provider/edge-validation.mjs.
test('signal: a watched file docks a generic ship from stat alone; its contents are never read', (t) => {
  const { world, signalDir, signalFile, shipId } = signalWorld(t);
  const reads = recordSignalReads(t, signalDir);
  fs.closeSync(fs.openSync(signalFile, 'r'));
  assert.equal(reads.length, 1, 'the read guard sees a direct read');
  reads.length = 0;
  const { tracker, take } = world.live();
  const projectId = `project:${hex8(canonicalProjectPath(world.projectDir))}`;

  tracker.scan(true);
  const startup = take();
  assert.deepEqual(startup.map((event) => event.type), ['project-added', 'ship-spawned', 'feed']);
  assert.deepEqual(startup[1].ship, {
    id: shipId, name: 'Signal-1', project: projectId, kind: 'main', provider: 'generic',
    status: 'Working', detail: null, lastEvent: T0, attention: null, attentionSince: null,
    builds: 0, local: false, model: null, taskId: null, turnOutcome: null,
  });

  world.clock.set(T0 + 5 * SEC);
  fs.appendFileSync(signalFile, 'MORE_PRIVATE_BYTES');
  setMtime(signalFile, T0 + 5 * SEC);
  tracker.scan(false);
  const changed = take();
  assert.deepEqual(changed.map((event) => event.type), ['ship-updated', 'activity']);
  assert.deepEqual(pick(['project', 'shipId', 'tool', 'status', 'detail', 'ts'])(changed[1]),
    { project: projectId, shipId, tool: 'signal', status: 'Working', detail: null, ts: T0 + 5 * SEC });

  tracker.scan(false);
  assert.deepEqual(take(), [], 'an unchanged file emits nothing');

  fs.rmSync(signalFile);
  world.clock.set(T0 + 6 * SEC);
  tracker.scan(false);
  const gone = take();
  assert.deepEqual(gone.map((event) => event.type), ['ship-departed', 'feed']);
  assert.deepEqual(pick(['shipId', 'ts'])(gone[0]), { shipId, ts: T0 + 6 * SEC });
  assert.equal(gone[1].entry.text, 'Signal-1 signal disappeared');

  assert.deepEqual(reads, []);
});

// Docks a fresh .log and a fresh .txt file under `extensions`; returns which got a ship.
function dockedSignalFiles(t, extensions) {
  const { world, signalDir, signalFile, shipIdOf } = signalWorld(t, { extensions });
  const notes = path.join(signalDir, 'notes.txt');
  fs.writeFileSync(notes, 'PRIVATE_GENERIC_BYTES');
  setMtime(notes, T0);
  const { tracker } = world.live();
  tracker.scan(true);
  const docked = new Set(tracker.snapshot().ships.map((ship) => ship.id));
  return [signalFile, notes].filter((file) => docked.has(shipIdOf(file))).map((file) => path.basename(file));
}

test('signal: a watch entry\'s configured extensions choose which files dock a ship', (t) => {
  assert.deepEqual(dockedSignalFiles(t, ['.txt']), ['notes.txt']);
});

test('signal: a watch entry without a usable extensions list watches every default extension', (t) => {
  assert.deepEqual(dockedSignalFiles(t, ['.exe']), ['private.log', 'notes.txt']);
});

test('signal config: extensions keep the supported ones listed; absent or unusable lists mean all four', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'au-signal-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'providers.json');
  const parse = (extensions) => {
    fs.writeFileSync(file, JSON.stringify({ watch: [{ directory: root, extensions }] }));
    const { watch, warnings } = readGenericWatchConfig(file);
    return [watch[0].extensions, warnings];
  };
  const all = ['.json', '.jsonl', '.log', '.txt'];
  const warning = 'provider config lists no supported watch extensions; using .json, .jsonl, .log and .txt';
  assert.deepEqual(parse([' .TXT ', '.log', '.exe', 7, '.log']), [['.log', '.txt'], []]);
  assert.deepEqual(parse(undefined), [all, []]);
  for (const unusable of [[], ['.exe', 'log'], '.log', null]) {
    assert.deepEqual(parse(unusable), [all, [warning]], JSON.stringify(unusable));
  }
});

test('signal: a file idle 5-15 min docks no ship, so no sweep warps one out and no scan respawns it', (t) => {
  const { world } = signalWorld(t, { mtime: T0 - 7 * MIN });
  const session = { world, ...world.live() };
  for (const [round, expected] of [[0, ['project-added']], [1, []]]) {
    session.tracker.scan(false);
    assert.deepEqual(session.take().map((event) => event.type), expected, `scan ${round}`);
    assert.deepEqual(sweepAt(session, T0), [], `sweep ${round}`);
  }
});

test('signal: an idle Signal ship warps out once and returns, renamed, only when its file changes', (t) => {
  const { world, signalFile, shipId } = signalWorld(t);
  const session = { world, ...world.live() };
  session.tracker.scan(true);
  session.take();

  const gone = sweepAt(session, T0 + 5 * MIN + 1);
  assert.deepEqual(gone.map((event) => [event.type, event.shipId || event.entry.text]),
    [['ship-departed', shipId], ['feed', 'Signal-1 warped out']]);
  session.tracker.scan(false);
  assert.deepEqual(session.take(), [], 'an unchanged idle file stays undocked');

  world.clock.set(T0 + 6 * MIN);
  fs.appendFileSync(signalFile, 'MORE_PRIVATE_BYTES');
  setMtime(signalFile, T0 + 6 * MIN);
  session.tracker.scan(false);
  const back = session.take();
  assert.deepEqual(back.map((event) => event.type), ['ship-spawned', 'feed', 'ship-updated', 'activity']);
  assert.deepEqual(pick(['id', 'name'])(back[0].ship), { id: shipId, name: 'Signal-2' });
});

'use strict';

// src/main/live/ollama-source.js: a model loaded in the loopback Ollama server is a red local ship
// named for the server, docked by one GET /api/ps every poll and nothing else.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Tracker } = require('../src/main/tracker');
const { createLiveModel } = require('../src/main/live/model');
const { flush } = require('../src/main/live/events');
const { departIdleShips } = require('../src/main/live/ships');
const { readGenericWatchConfig } = require('../src/main/provider-adapters');
const {
  ollamaEndpoint, parseOllamaStatus, ollamaDetail, applyOllamaStatus, pollOllama,
} = require('../src/main/live/ollama-source');
const { SEC, MIN, hex8 } = require('./support/transcripts');

const T0 = Date.UTC(2026, 10, 16, 12, 0, 0);
const QWEN = 'qwen3.6:27b-q4_K_M';

// Temp folders for one test: an Ollama home, empty Claude and Codex roots, a state folder.
function world(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'au-ollama-'));
  for (const dir of ['ollama-home', 'claude', 'codex', 'state']) fs.mkdirSync(path.join(root, dir));
  const owned = [];
  t.after(() => {
    for (const tracker of owned) tracker.stop();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const base = {
    claudeProjectsDir: path.join(root, 'claude'), codexSessionsDir: path.join(root, 'codex'),
    providerConfigPath: path.join(root, 'state', 'providers.json'),
  };
  return {
    home: path.join(root, 'ollama-home'),
    configPath: base.providerConfigPath,
    statePath: path.join(root, 'state', 'universe-state.json'),
    base,
    tracker(options = {}) {
      const tracker = new Tracker(this.statePath, { ...base, ...options });
      owned.push(tracker);
      return tracker;
    },
  };
}

const closeServer = (server) => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });

// A throwaway Ollama: serves `payload` at /api/ps, records every request.
function fakeOllama(t) {
  const server = { payload: { models: [] }, hits: [], port: 0, http: null };
  server.http = http.createServer((req, res) => {
    server.hits.push(`${req.method} ${req.url}`);
    if (req.url !== '/api/ps') { res.statusCode = 404; res.end(); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(server.payload));
  });
  t.after(() => closeServer(server.http));
  return new Promise((resolve) => server.http.listen(0, '127.0.0.1', () => {
    server.port = server.http.address().port;
    resolve(server);
  }));
}

const psModel = (name, size, sizeVram, expiresAt) => ({ name, size, size_vram: sizeVram, expires_at: new Date(expiresAt).toISOString() });
const types = (events) => events.map((event) => event.type === 'feed' ? `feed:${event.entry.kind}:${event.entry.text}` : event.type);

test('ollama endpoint: loopback http in Ollama\'s own syntax, config over option over OLLAMA_HOST, anything else refused', () => {
  const cases = [
    [{}, 'http://127.0.0.1:11434'],
    [{ env: '0.0.0.0:11434' }, 'http://127.0.0.1:11434'],
    [{ env: 'http://localhost:11435/' }, 'http://127.0.0.1:11435'],
    [{ env: '127.0.0.1' }, 'http://127.0.0.1:11434'],
    [{ env: '[::1]:11434' }, 'http://[::1]:11434'],
    [{ env: '::1' }, 'http://[::1]:11434'],
    [{ config: { host: '127.0.0.1:11500' }, option: '127.0.0.1:11600', env: '0.0.0.0:11434' }, 'http://127.0.0.1:11500'],
    [{ option: '127.0.0.1:11600', env: '0.0.0.0:11434' }, 'http://127.0.0.1:11600'],
    [{ config: { host: null }, env: ' 127.0.0.1:11436 ' }, 'http://127.0.0.1:11436'],
    [{ config: false, option: '127.0.0.1:11600' }, 'disabled'],
  ];
  for (const [input, expected] of cases) {
    const result = ollamaEndpoint(input);
    assert.equal(result.disabled ? 'disabled' : result.origin, expected, JSON.stringify(input));
  }
  for (const host of ['192.168.1.20:11434', 'https://127.0.0.1:11434', 'http://127.0.0.1:11434/api',
    'http://user@127.0.0.1:11434', '127.0.0.1:99999', '127.0.0.1:0', 'ollama.example.com', 'http://127.0.0.1?x=1']) {
    const result = ollamaEndpoint({ env: host });
    assert.match(result.warning || '', /not a loopback http address/, host);
    assert.equal(result.origin, undefined, host);
  }
  assert.ok(!ollamaEndpoint({ env: 'evil\u0007host' }).warning.includes('\u0007'), 'control characters leave the warning');
  assert.deepEqual(ollamaEndpoint({ config: 'yes' }), { warning: 'provider config ollama entry must be false or an object' });
  assert.equal(ollamaEndpoint({ config: { home: 'relative/ollama' } }).home, null, 'a home must be absolute');
  assert.equal(ollamaEndpoint({ config: { home: os.tmpdir() } }).home, os.tmpdir());
});

test('ollama status: four fields per model with defaults, names cleaned, 32 at most; any other shape is null', () => {
  const parsed = parseOllamaStatus(JSON.stringify({ models: [
    { name: 'a'.repeat(100) + '\u0007', size: 1, size_vram: 0, expires_at: new Date(T0).toISOString() },
    { size: 1 },
    { model: QWEN, size: 23e9, size_vram: 'no', expires_at: 'not a date' },
    { name: QWEN, size: 1 },
    ...Array.from({ length: 40 }, (_, index) => psModel(`m${index}:latest`, 1e9, 0, T0)),
  ] }));
  assert.equal(parsed.models.length, 32);
  assert.equal(parsed.models[0].name.length, 64);
  assert.doesNotMatch(parsed.models[0].name, /\p{C}/u);
  assert.deepEqual(parsed.models[0].expiresAt, T0);
  assert.deepEqual(parsed.models[1], { name: QWEN, size: 23e9, sizeVram: 0, expiresAt: 0 }, 'model falls back to the model field; bad numbers and dates are 0');
  assert.equal(parsed.models.filter((entry) => entry.name === QWEN).length, 1, 'duplicates keep the first');
  for (const text of ['not json', JSON.stringify({ models: 'x' }), JSON.stringify([]), `{"models":[${'x'.repeat(300 * 1024)}]}`, 7]) {
    assert.equal(parseOllamaStatus(text), null);
  }
  assert.deepEqual(parseOllamaStatus('{"models":[]}'), { models: [] });

  assert.equal(ollamaDetail(23e9, 0), '23.0 GB · 100% CPU');
  assert.equal(ollamaDetail(4e9, 4e9), '4.0 GB · 100% GPU');
  assert.equal(ollamaDetail(10e9, 6e9), '10.0 GB · 40%/60% CPU/GPU');
  assert.equal(ollamaDetail(0, 0), null);
});

test('ollama reducer: loaded models dock, served requests are activity, unloaded models and a dead server depart', (t) => {
  t.mock.method(console, 'warn', () => {});
  const w = world(t);
  const batches = [];
  const model = createLiveModel(w.statePath, {
    ...w.base, ollama: { home: w.home, fetch: () => Promise.reject(new Error('the reducer needs no network')) },
  }, (batch) => batches.push(...batch));
  const take = () => { flush(model); return batches.splice(0); };
  const up = (models) => ({ reachable: true, models });
  const m = (name, size, sizeVram, expiresAt) => ({ name, size, sizeVram, expiresAt });

  applyOllamaStatus(model, up([m(QWEN, 23e9, 0, T0 + 5 * MIN)]), T0);
  let events = take();
  const project = events.filter((event) => event.type === 'project-updated').pop().project;
  assert.deepEqual([project.id, project.name, project.exists], ['project:ollama', 'Ollama', true]);
  const ship = events.find((event) => event.type === 'ship-spawned').ship;
  assert.deepEqual(ship, {
    id: `ship:local:ollama-${hex8(QWEN)}`, name: 'Ollama-1', project: 'project:ollama',
    kind: 'main', provider: 'local', status: 'Working', detail: '23.0 GB · 100% CPU', lastEvent: T0,
    attention: null, attentionSince: null, builds: 0, local: true, model: QWEN, taskId: null, turnOutcome: null,
  });
  assert.ok(types(events).includes('feed:spawn:Ollama-1 entered Ollama'));

  applyOllamaStatus(model, up([m(QWEN, 23e9, 0, T0 + 5 * MIN)]), T0 + 5 * SEC);
  assert.deepEqual(take(), [], 'nothing changed, nothing said');

  applyOllamaStatus(model, up([m(QWEN, 23e9, 0, T0 + 5 * MIN + 10 * SEC)]), T0 + 10 * SEC);
  events = take();
  assert.deepEqual(types(events), ['ship-updated', 'activity'], 'expires_at advanced: a request was served');
  assert.equal(events[0].ship.lastEvent, T0 + 10 * SEC);
  assert.deepEqual([events[1].tool, events[1].status, events[1].shipId, events[1].ts], ['ollama', 'Working', ship.id, T0 + 10 * SEC]);

  applyOllamaStatus(model, up([m(QWEN, 23e9, 12e9, T0 + 5 * MIN + 10 * SEC)]), T0 + 12 * SEC);
  events = take();
  assert.deepEqual([types(events), events[0].ship.detail], [['ship-updated'], '23.0 GB · 48%/52% CPU/GPU'], 'a moved model is a detail change alone');

  applyOllamaStatus(model, up([m(QWEN, 23e9, 12e9, T0 + 5 * MIN + 10 * SEC), m('gemma4:e4b', 4e9, 4e9, T0 + 5 * MIN + 15 * SEC)]), T0 + 15 * SEC);
  const second = take().find((event) => event.type === 'ship-spawned').ship;
  assert.deepEqual([second.name, second.detail, second.model], ['Ollama-2', '4.0 GB · 100% GPU', 'gemma4:e4b']);

  applyOllamaStatus(model, up([m('gemma4:e4b', 4e9, 4e9, T0 + 5 * MIN + 15 * SEC)]), T0 + 20 * SEC);
  events = take();
  assert.deepEqual(types(events), ['ship-departed', 'feed:depart:Ollama-1 unloaded']);
  assert.equal(events[0].shipId, ship.id);

  applyOllamaStatus(model, { reachable: false }, T0 + 25 * SEC);
  assert.deepEqual(types(take()), ['feed:info:Ollama server offline', 'ship-departed', 'feed:depart:Ollama-2 unloaded']);
  applyOllamaStatus(model, { reachable: false }, T0 + 26 * SEC);
  assert.deepEqual(take(), [], 'still offline, nothing more');

  applyOllamaStatus(model, up([m('gemma4:e4b', 4e9, 4e9, T0 + 5 * MIN + 30 * SEC)]), T0 + 30 * SEC);
  events = take();
  assert.deepEqual(types(events), ['feed:info:Ollama server online', 'ship-spawned', 'feed:spawn:Ollama-3 entered Ollama']);

  // Idle: the sweep warps the ship out; it docks again only when the model serves another request.
  const idleAt = T0 + 30 * SEC + 6 * MIN;
  departIdleShips(model, idleAt);
  assert.deepEqual(types(take()), ['ship-departed', 'feed:depart:Ollama-3 warped out']);
  applyOllamaStatus(model, up([m('gemma4:e4b', 4e9, 4e9, T0 + 5 * MIN + 30 * SEC)]), idleAt + 5 * SEC);
  assert.deepEqual(take(), [], 'the same expires_at does not re-dock');
  applyOllamaStatus(model, up([m('gemma4:e4b', 4e9, 4e9, idleAt + 10 * SEC + 5 * MIN)]), idleAt + 10 * SEC);
  assert.equal(take().find((event) => event.type === 'ship-spawned').ship.name, 'Ollama-4');
  assert.equal(console.warn.mock.callCount(), 0, 'an existing home folder warns about nothing');
});

test('ollama reducer: a missing home folder warns once and the system renders derelict', (t) => {
  t.mock.method(console, 'warn', () => {});
  const w = world(t);
  const home = path.join(w.home, 'missing');
  const batches = [];
  const model = createLiveModel(w.statePath, { ...w.base, ollama: { home, fetch: null } }, (batch) => batches.push(...batch));
  applyOllamaStatus(model, { reachable: true, models: [{ name: QWEN, size: 1e9, sizeVram: 0, expiresAt: T0 }] }, T0);
  applyOllamaStatus(model, { reachable: true, models: [{ name: QWEN, size: 1e9, sizeVram: 0, expiresAt: T0 }] }, T0 + SEC);
  flush(model);
  assert.equal(batches.find((event) => event.type === 'project-added').project.exists, false);
  assert.equal(batches.filter((event) => event.type === 'feed' && event.entry.kind === 'warning').length, 1);
  assert.deepEqual([...model.providerWarnings], [`Ollama home folder ${home} not found; set ollama.home in providers.json`]);
  assert.equal(model.ships.size, 1, 'the ship docks all the same');
});

test('ollama poll: one GET /api/ps per poll through the Tracker; the ship follows the server', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const w = world(t);
  const server = await fakeOllama(t);
  server.payload = { models: [psModel(QWEN, 23e9, 0, Date.now() + 5 * MIN)] };
  const options = { ollama: { host: `127.0.0.1:${server.port}`, home: w.home } };
  const localShips = (tracker) => tracker.snapshot().ships.filter((ship) => ship.provider === 'local');

  const first = w.tracker(options);
  assert.deepEqual(await first.pollOllama(), { polled: true, reachable: true });
  assert.deepEqual(server.hits, ['GET /api/ps']);
  assert.deepEqual(localShips(first).map((ship) => [ship.name, ship.model, ship.local]), [['Ollama-1', QWEN, true]]);
  assert.equal(first.snapshot().projects.find((project) => project.id === 'project:ollama').name, 'Ollama');

  server.payload = { models: [] };
  await first.pollOllama();
  assert.equal(localShips(first).length, 0, 'an empty list departs the ship');
  first.saveState();
  first.stop();

  // A new run restores the project from the state file under its folder name; the first answer renames it.
  const second = w.tracker(options);
  const restored = () => second.snapshot().projects.find((project) => project.id === 'project:ollama');
  assert.equal(restored().name, path.basename(w.home));
  const activityBefore = restored().lastActivity;
  await second.pollOllama();
  assert.deepEqual([restored().name, restored().lastActivity, localShips(second).length], ['Ollama', activityBefore, 0], 'renamed; an idle server is no activity and no ship');
  server.payload = { models: [psModel(QWEN, 23e9, 0, Date.now() + 5 * MIN)] };
  await second.pollOllama();
  assert.equal(localShips(second).length, 1);

  // The server dies: one failure keeps the ship and backs off, the second takes it offline.
  await closeServer(server.http);
  const before = Date.now();
  assert.deepEqual(await second.pollOllama(), { polled: true, reachable: true });
  assert.equal(second.model.ollama.failures, 1);
  assert.ok(second.model.ollama.nextPollAt > before);
  assert.equal(localShips(second).length, 1);
  assert.equal((await second.pollOllama()).polled, false, 'backoff skips the next poll');
  second.model.ollama.nextPollAt = 0;
  assert.deepEqual(await second.pollOllama(), { polled: true, reachable: false });
  assert.equal(localShips(second).length, 0);
  assert.equal(second.snapshot().feed.filter((entry) => entry.text === 'Ollama server offline').length, 1);
  second.stop();
});

test('ollama poll: providers.json refuses a LAN host with one warning, turns the source off silently, and needs no watch array', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const w = world(t);
  const server = await fakeOllama(t);
  fs.writeFileSync(w.configPath, JSON.stringify({ ollama: { host: '10.0.0.5:11434' } }));
  const tracker = w.tracker({ ollama: { host: `127.0.0.1:${server.port}`, home: w.home } });
  assert.equal((await tracker.pollOllama()).polled, false);
  assert.equal((await tracker.pollOllama()).polled, false);
  assert.deepEqual(server.hits, []);
  assert.equal(console.warn.mock.callCount(), 1);
  assert.match(console.warn.mock.calls[0].arguments[0], /^\[providers\] Ollama host "10\.0\.0\.5:11434" is not a loopback/);

  fs.writeFileSync(w.configPath, JSON.stringify({ ollama: false }));
  assert.equal((await tracker.pollOllama()).polled, false);
  assert.deepEqual(server.hits, []);
  assert.equal(console.warn.mock.callCount(), 1, 'off is not a warning');
  assert.deepEqual(readGenericWatchConfig(w.configPath), { watch: [], warnings: [], ollama: false }, 'the entry comes through as written, no watch needed');

  fs.writeFileSync(w.configPath, JSON.stringify({ ollama: 'yes' }));
  assert.equal((await tracker.pollOllama()).polled, false);
  assert.equal(console.warn.mock.calls[1].arguments[0], '[providers] provider config ollama entry must be false or an object');

  // A relative home is ignored; an absolute one becomes the system's folder.
  server.payload = { models: [psModel(QWEN, 23e9, 0, Date.now() + 5 * MIN)] };
  fs.writeFileSync(w.configPath, JSON.stringify({ ollama: { home: 'relative/ollama' } }));
  assert.deepEqual(await tracker.pollOllama(), { polled: true, reachable: true });
  assert.equal(tracker.snapshot().projects.find((project) => project.id === 'project:ollama').path, w.home);
  const otherHome = path.join(path.dirname(w.home), 'other-home');
  fs.mkdirSync(otherHome);
  fs.writeFileSync(w.configPath, JSON.stringify({ ollama: { home: otherHome } }));
  const moved = w.tracker({ statePath: path.join(path.dirname(w.statePath), 'other-state.json'), ollama: { host: `127.0.0.1:${server.port}` } });
  await moved.pollOllama();
  assert.equal(moved.snapshot().projects.find((project) => project.id === 'project:ollama').path, otherHome);
  assert.equal(console.warn.mock.callCount(), 2);
});

test('ollama poll: stop() aborts a poll in flight, and a Tracker without the option never touches the socket', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const w = world(t);
  const hanging = http.createServer(() => { /* never answers */ });
  await new Promise((resolve) => hanging.listen(0, '127.0.0.1', resolve));
  t.after(() => closeServer(hanging));
  const tracker = w.tracker({ ollama: { host: `127.0.0.1:${hanging.address().port}`, home: w.home } });
  const pending = tracker.pollOllama();
  assert.deepEqual(await tracker.pollOllama(), { polled: false, reachable: null }, 'one request at a time');
  const stopAt = Date.now();
  tracker.stop();
  assert.deepEqual(await pending, { polled: true, reachable: null });
  assert.ok(Date.now() - stopAt < 500, 'the abort settled the poll');
  assert.equal(tracker.model.ollama.failures, 1);

  const server = await fakeOllama(t);
  const saved = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = `127.0.0.1:${server.port}`;
  t.after(() => { if (saved === undefined) delete process.env.OLLAMA_HOST; else process.env.OLLAMA_HOST = saved; });
  const plain = w.tracker();
  plain.start();
  await new Promise((resolve) => setTimeout(resolve, 200));
  plain.stop();
  assert.equal(plain.model.ollama, null);
  assert.deepEqual(server.hits, []);
  assert.deepEqual(await plain.pollOllama(), { polled: false, reachable: null });
});

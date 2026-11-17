// Gate for kit 17, local model ships (Ollama adapter). Exit 0 = PASS, 1 = FAIL.
// Usage: node kit/todo/17-ollama-source/grade-ollama.mjs [--fixtures-only] [--no-regression] [--killswitch]
// O1 layout, O2 endpoint table, O3 reducer fixtures, O4 real sockets through the Tracker,
// O5 provider key behaviour (main + renderer in a vm sandbox), O6 rendered proof (Electron), O7 docs,
// O8 regression gates.
// --killswitch runs O0 alone: a 90 s live poll of the real server that proves expires_at advances.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const FIXTURES_ONLY = argv.includes('--fixtures-only');
const NO_REGRESSION = argv.includes('--no-regression');
const failures = [];
const notes = [];
const T0 = 1_800_000_000_000;
const SEC = 1000;
const MIN = 60 * SEC;
const LOCAL_RED = '#ff3344';
const ERROR_RE = /Uncaught|ReferenceError|TypeError|SyntaxError|is not defined|Failed to load resource|boot-failure/i;
const PUBLIC_SHIP_KEYS = ['attention', 'attentionSince', 'builds', 'detail', 'id', 'kind', 'lastEvent', 'local',
  'model', 'name', 'project', 'provider', 'status', 'taskId', 'turnOutcome'];

function fail(id, message) { failures.push(`${id}: ${message}`); }
function check(id, condition, message) { if (!condition) fail(id, message); return Boolean(condition); }
function same(id, actual, expected, label) {
  try { assert.deepStrictEqual(actual, expected); } catch {
    fail(id, `${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
}
function read(rel) {
  const file = path.join(root, rel);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}
function report() {
  console.log('\n============= OLLAMA GRADE =============');
  for (const note of notes) console.log(`INFO  ${note}`);
  if (failures.length) {
    for (const item of failures) console.log(`FAIL  ${item}`);
    process.exit(1);
  }
  console.log('PASS  O1-O8 local model source checks green');
  process.exit(0);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function tmp(name) { return fs.mkdtempSync(path.join(os.tmpdir(), `orrery-ollama-${name}-`)); }
function world(name) {
  const base = tmp(name);
  const home = path.join(base, 'ollama-home');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(base, 'claude'), { recursive: true });
  fs.mkdirSync(path.join(base, 'codex'), { recursive: true });
  fs.mkdirSync(path.join(base, 'state'), { recursive: true });
  return {
    base, home,
    statePath: path.join(base, 'state', 'universe-state.json'),
    configPath: path.join(base, 'state', 'providers.json'),
    dirs: { claudeProjectsDir: path.join(base, 'claude'), codexSessionsDir: path.join(base, 'codex') },
  };
}
const psModel = (name, size, sizeVram, expiresAt) => ({ name, size, size_vram: sizeVram, expires_at: new Date(expiresAt).toISOString() });

// ---- O0: kill-switch against the real server ----
if (argv.includes('--killswitch')) {
  const host = (process.env.OLLAMA_HOST || '127.0.0.1:11434').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const url = `http://${host}/api/ps`;
  const seen = new Map();
  let advances = 0;
  let last = null;
  console.log(`O0 polling ${url} every 2 s for 90 s; send two messages in the Ollama app now`);
  const until = Date.now() + 90 * SEC;
  while (Date.now() < until) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      const body = await response.json();
      for (const entry of body.models || []) {
        const name = entry.name || entry.model;
        const expires = Date.parse(entry.expires_at) || 0;
        const previous = seen.get(name);
        if (previous === undefined) console.log(`  ${new Date().toISOString()} loaded   ${name} expires ${entry.expires_at}`);
        else if (expires > previous) { advances++; console.log(`  ${new Date().toISOString()} advanced ${name} expires ${entry.expires_at}`); }
        seen.set(name, expires);
      }
      if ((body.models || []).length) last = body;
    } catch (error) {
      console.log(`  ${new Date().toISOString()} unreachable: ${error.message}`);
    }
    await sleep(2000);
  }
  if (last) {
    const out = path.join(root, '.shots', 'ollama');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'killswitch.json'), JSON.stringify(last, null, 2));
    notes.push(`recorded /api/ps shape to ${path.join(out, 'killswitch.json')}`);
  }
  if (advances < 2) fail('O0', `expires_at advanced ${advances} time(s); need 2 (is OLLAMA_KEEP_ALIVE infinite? was a message sent?)`);
  else notes.push(`O0 expires_at advanced ${advances} times for ${seen.size} model(s)`);
  report();
}

// ---- O1: layout ----
const SOURCE_REL = 'src/main/live/ollama-source.js';
if (!fs.existsSync(path.join(root, SOURCE_REL))) {
  fail('O1', `${SOURCE_REL} missing — not implemented yet (expected baseline failure)`);
  report();
}
const sourceText = read(SOURCE_REL);
check('O1', sourceText.split(/\r?\n/)[0].trim() === '// @ts-check', 'ollama-source.js does not start with // @ts-check');
check('O1', sourceText.split(/\r?\n/).length <= 400, 'ollama-source.js is over 400 lines');
check('O1', !/^let\s/m.test(sourceText), 'ollama-source.js has module-level let');
check('O1', /ollama/i.test(read('src/main/live/model.js')), 'live/model.js does not know options.ollama');

let source; let Tracker; let createLiveModel; let flush; let departIdleShips; let ensureProviderShip; let adapters; let liveShip;
try {
  source = require(path.join(root, SOURCE_REL));
  ({ Tracker } = require(path.join(root, 'src', 'main', 'tracker.js')));
  ({ createLiveModel } = require(path.join(root, 'src', 'main', 'live', 'model.js')));
  ({ flush } = require(path.join(root, 'src', 'main', 'live', 'events.js')));
  ({ departIdleShips, ensureProviderShip } = require(path.join(root, 'src', 'main', 'live', 'ships.js')));
  adapters = require(path.join(root, 'src', 'main', 'provider-adapters.js'));
  ({ liveShip } = require(path.join(root, 'src', 'main', 'universe', 'public-shape.js')));
} catch (error) {
  fail('O1', `module load failed: ${error.stack || error}`);
  report();
}
for (const name of ['ollamaEndpoint', 'parseOllamaStatus', 'ollamaDetail', 'applyOllamaStatus', 'pollOllama', 'stopOllama']) {
  check('O1', typeof source[name] === 'function', `${name} is not exported from ollama-source.js`);
}
check('O1', typeof Tracker.prototype.pollOllama === 'function', 'Tracker.prototype.pollOllama is missing');
check('O1', typeof ensureProviderShip === 'function', 'live/ships.js does not export ensureProviderShip');
if (failures.length) report();

// ---- O2: endpoint table ----
const endpointCases = [
  [{}, 'http://127.0.0.1:11434'],
  [{ env: '0.0.0.0:11434' }, 'http://127.0.0.1:11434'],
  [{ env: 'http://localhost:11435/' }, 'http://127.0.0.1:11435'],
  [{ env: '127.0.0.1' }, 'http://127.0.0.1:11434'],
  [{ env: '[::1]:11434' }, 'http://[::1]:11434'],
  [{ config: { host: '127.0.0.1:11500' }, option: '127.0.0.1:11600', env: '0.0.0.0:11434' }, 'http://127.0.0.1:11500'],
  [{ option: '127.0.0.1:11600', env: '0.0.0.0:11434' }, 'http://127.0.0.1:11600'],
  [{ config: false, option: '127.0.0.1:11600', env: '0.0.0.0:11434' }, 'disabled'],
  [{ env: '192.168.1.20:11434' }, 'warning'],
  [{ env: 'https://127.0.0.1:11434' }, 'warning'],
  [{ env: 'http://127.0.0.1:11434/api' }, 'warning'],
  [{ env: 'http://user@127.0.0.1:11434' }, 'warning'],
  [{ env: '127.0.0.1:99999' }, 'warning'],
  [{ env: 'ollama.example.com' }, 'warning'],
];
for (const [input, expected] of endpointCases) {
  let result;
  try { result = source.ollamaEndpoint(input); } catch (error) { fail('O2', `${JSON.stringify(input)} threw ${error.message}`); continue; }
  const actual = result && result.disabled === true ? 'disabled'
    : result && typeof result.warning === 'string' && result.warning ? 'warning'
      : result && typeof result.origin === 'string' ? result.origin : JSON.stringify(result);
  if (actual !== expected) fail('O2', `${JSON.stringify(input)} -> ${actual}, expected ${expected}`);
}
same('O2', source.ollamaDetail(10e9, 6e9), '10.0 GB · 40%/60% CPU/GPU', 'mixed split detail');
same('O2', source.ollamaDetail(0, 0), null, 'unknown size detail');

// ---- O3: reducer fixtures ----
{
  const w = world('reducer');
  const batches = [];
  const model = createLiveModel(w.statePath, {
    ...w.dirs, providerConfigPath: w.configPath,
    ollama: { home: w.home, fetch: () => Promise.reject(new Error('O3 uses no network')) },
  }, (batch) => batches.push(...batch));
  const take = () => { flush(model); return batches.splice(0); };
  const reachable = (models) => ({ reachable: true, models });
  const m = (name, size, sizeVram, expiresAt) => ({ name, size, sizeVram, expiresAt });
  const canonical = adapters.canonicalProjectPath;
  const types = (events) => events.map((event) => event.type === 'feed' ? `feed:${event.entry.kind}:${event.entry.text}` : event.type);

  source.applyOllamaStatus(model, reachable([m('qwen3.6:27b-q4_K_M', 23e9, 0, T0 + 5 * MIN)]), T0);
  let events = take();
  const projectEvents = events.filter((event) => /^project-(added|updated)$/.test(event.type) && event.project && event.project.id === 'project:ollama');
  if (check('O3', projectEvents.length > 0, `step 1: no project event for project:ollama in ${JSON.stringify(types(events))}`)) {
    const project = projectEvents[projectEvents.length - 1].project;
    same('O3', project.name, 'Ollama', 'step 1: project name');
    same('O3', canonical(project.path), canonical(w.home), 'step 1: project path');
  }
  const spawned = events.find((event) => event.type === 'ship-spawned');
  if (check('O3', Boolean(spawned), `step 1: no ship-spawned in ${JSON.stringify(types(events))}`)) {
    const s = spawned.ship;
    same('O3', [s.provider, s.name, s.kind, s.local, s.model, s.status, s.detail, s.attention, s.builds, s.lastEvent, s.project],
      ['local', 'Ollama-1', 'main', true, 'qwen3.6:27b-q4_K_M', 'Working', '23.0 GB · 100% CPU', null, 0, T0, 'project:ollama'], 'step 1: spawned ship');
    check('O3', /^ship:local:ollama-[0-9a-f]{8}$/.test(s.id), `step 1: ship id ${s.id} is not ship:local:ollama-<hex8>`);
    same('O3', Object.keys(s).sort(), PUBLIC_SHIP_KEYS, 'step 1: public ship keys');
  }
  check('O3', events.some((event) => event.type === 'feed' && event.entry.kind === 'spawn' && event.entry.text === 'Ollama-1 entered Ollama'),
    `step 1: missing feed "Ollama-1 entered Ollama" in ${JSON.stringify(types(events))}`);
  const shipId = spawned ? spawned.ship.id : null;

  source.applyOllamaStatus(model, reachable([m('qwen3.6:27b-q4_K_M', 23e9, 0, T0 + 5 * MIN)]), T0 + 5 * SEC);
  same('O3', types(take()), [], 'step 2: unchanged status queues nothing');

  source.applyOllamaStatus(model, reachable([m('qwen3.6:27b-q4_K_M', 23e9, 0, T0 + 5 * MIN + 10 * SEC)]), T0 + 10 * SEC);
  events = take();
  same('O3', types(events).sort(), ['activity', 'ship-updated'], 'step 3: expires_at advance');
  const updated = events.find((event) => event.type === 'ship-updated');
  const activity = events.find((event) => event.type === 'activity');
  if (updated) same('O3', updated.ship.lastEvent, T0 + 10 * SEC, 'step 3: lastEvent');
  if (activity) same('O3', [activity.tool, activity.status, activity.shipId, activity.ts, activity.project],
    ['ollama', 'Working', shipId, T0 + 10 * SEC, 'project:ollama'], 'step 3: activity');

  source.applyOllamaStatus(model, reachable([
    m('qwen3.6:27b-q4_K_M', 23e9, 0, T0 + 5 * MIN + 10 * SEC), m('gemma4:e4b', 4e9, 4e9, T0 + 5 * MIN + 15 * SEC),
  ]), T0 + 15 * SEC);
  events = take();
  const second = events.find((event) => event.type === 'ship-spawned');
  if (check('O3', Boolean(second), 'step 4: second model did not spawn')) {
    same('O3', [second.ship.name, second.ship.detail, second.ship.model, second.ship.provider],
      ['Ollama-2', '4.0 GB · 100% GPU', 'gemma4:e4b', 'local'], 'step 4: second ship');
  }
  const secondId = second ? second.ship.id : null;

  source.applyOllamaStatus(model, reachable([m('gemma4:e4b', 4e9, 4e9, T0 + 5 * MIN + 15 * SEC)]), T0 + 20 * SEC);
  events = take();
  same('O3', types(events).sort(), ['feed:depart:Ollama-1 unloaded', 'ship-departed'], 'step 5: first model unloaded');
  const departed = events.find((event) => event.type === 'ship-departed');
  if (departed) same('O3', departed.shipId, shipId, 'step 5: departed ship id');
  check('O3', model.ships.has(secondId), 'step 5: second ship was touched');

  source.applyOllamaStatus(model, { reachable: false }, T0 + 25 * SEC);
  same('O3', types(take()).sort(), ['feed:depart:Ollama-2 unloaded', 'feed:info:Ollama server offline', 'ship-departed'], 'step 6: server offline');
  source.applyOllamaStatus(model, { reachable: false }, T0 + 26 * SEC);
  same('O3', types(take()), [], 'step 6: repeated offline queues nothing');

  source.applyOllamaStatus(model, reachable([m('gemma4:e4b', 4e9, 4e9, T0 + 5 * MIN + 30 * SEC)]), T0 + 30 * SEC);
  events = take();
  const kinds = types(events);
  check('O3', kinds.indexOf('feed:info:Ollama server online') >= 0 && kinds.indexOf('ship-spawned') > kinds.indexOf('feed:info:Ollama server online'),
    `step 7: expected online line then spawn, got ${JSON.stringify(kinds)}`);
  const third = events.find((event) => event.type === 'ship-spawned');
  if (third) same('O3', third.ship.name, 'Ollama-3', 'step 7: third ship name');

  const idleAt = T0 + 30 * SEC + 6 * MIN;
  departIdleShips(model, idleAt);
  check('O3', types(take()).includes('ship-departed'), 'step 8: idle sweep did not depart Ollama-3');
  source.applyOllamaStatus(model, reachable([m('gemma4:e4b', 4e9, 4e9, T0 + 5 * MIN + 30 * SEC)]), idleAt + 5 * SEC);
  same('O3', types(take()), [], 'step 8: same expires_at after the sweep must not re-dock');
  source.applyOllamaStatus(model, reachable([m('gemma4:e4b', 4e9, 4e9, idleAt + 10 * SEC + 5 * MIN)]), idleAt + 10 * SEC);
  events = take();
  const fourth = events.find((event) => event.type === 'ship-spawned');
  if (check('O3', Boolean(fourth), 'step 8: advanced expires_at after the sweep did not re-dock')) same('O3', fourth.ship.name, 'Ollama-4', 'step 8: fourth ship name');

  const longName = 'a'.repeat(100) + '\u0007';
  const parsed = source.parseOllamaStatus(JSON.stringify({ models: [
    { name: longName, size: 1, size_vram: 0, expires_at: new Date(T0).toISOString() },
    { size: 1 },
    ...Array.from({ length: 40 }, (_, index) => psModel(`m${index}:latest`, 1e9, 0, T0)),
  ] }));
  if (check('O3', parsed && Array.isArray(parsed.models), 'step 9: parseOllamaStatus returned no models')) {
    same('O3', parsed.models[0].name.length, 64, 'step 9: long name cut to 64');
    check('O3', !/[\u0000-\u001f\u007f]/.test(parsed.models[0].name), 'step 9: control character kept in a model name');
    check('O3', parsed.models.every((entry) => typeof entry.name === 'string' && entry.name), 'step 9: nameless entry kept');
    check('O3', parsed.models.length <= 32, `step 9: ${parsed.models.length} models kept, limit is 32`);
  }
  same('O3', source.parseOllamaStatus(JSON.stringify({ models: 'x' })), null, 'step 9: models not an array');
  same('O3', source.parseOllamaStatus('{"models":[' + 'x'.repeat(300 * 1024) + ']}'), null, 'step 9: oversize body');
  same('O3', source.parseOllamaStatus('not json'), null, 'step 9: non-JSON');

  // Step 10: a caller that passes no facts gets today's ship.
  const codexShip = ensureProviderShip(model, 'codex', 'project:ollama', 'sess-1', 'main', T0, null);
  const codexSpawn = take().find((event) => event.type === 'ship-spawned');
  if (check('O3', codexShip && codexSpawn, 'step 10: ensureProviderShip without facts spawned nothing')) {
    same('O3', [codexSpawn.ship.provider, codexSpawn.ship.name, codexSpawn.ship.local, codexSpawn.ship.model],
      ['codex', 'Codex-1', false, null], 'step 10: untouched caller');
  }
  fs.rmSync(w.base, { recursive: true, force: true });
}

// ---- O5: provider key behaviour, main and renderer ----
same('O5', adapters.normalizeProvider('local'), 'local', 'normalizeProvider local');
same('O5', adapters.normalizeProvider(' Local '), 'local', 'normalizeProvider trims and folds');
same('O5', adapters.normalizeProvider('ollama'), 'generic', 'ollama must not be a provider key');
check('O5', /export type Provider = [^;]*'local'/.test(read('src/types/contract.d.ts')), "contract.d.ts Provider lacks 'local'");
{
  // Classic renderer scripts: run them the way test/shared-hash.test.js runs util.js.
  const sandbox = { window: {}, BABYLON: {} };
  let AUR = null;
  try {
    for (const rel of ['src/renderer/util.js', 'src/renderer/util-scene.js']) {
      vm.runInNewContext(read(rel), sandbox, { filename: rel });
    }
    AUR = sandbox.window.AUR;
  } catch (error) {
    fail('O5', `renderer util scripts failed to load in a sandbox: ${error.message}`);
  }
  if (AUR) {
    same('O5', AUR.providerKey('local'), 'local', 'providerKey(local)');
    same('O5', AUR.providerKey(' Local '), 'local', 'providerKey folds case and space');
    // Sandbox objects have the sandbox's prototypes; spread them into this realm before deepStrictEqual.
    same('O5', { ...AUR.providerMeta('local') }, { key: 'local', label: 'Local', color: LOCAL_RED }, 'providerMeta(local)');
    same('O5', AUR.PROVIDERS.local && AUR.PROVIDERS.local.color, AUR.LOCAL_MODEL.color, 'PROVIDERS.local shares the LOCAL_MODEL colour');
    same('O5', AUR.isSignalEntity({ provider: 'local', local: true }), false, 'a local ship is a hull, not a signal marker');
    same('O5', AUR.shipColor({ provider: 'local', local: true }), LOCAL_RED, 'shipColor(local)');
    same('O5', AUR.modelLabel({ provider: 'local', local: true, model: 'qwen3.6:27b' }), 'qwen3.6:27b', 'modelLabel for a local-provider ship is the bare model');
    same('O5', AUR.modelLabel({ provider: 'codex', local: true, model: 'x' }), 'Local · x', 'modelLabel for a local Codex session keeps the prefix');
    same('O5', AUR.modelLabel({ provider: 'local', local: true, model: null }), '', 'modelLabel without a model');
    const mesh = (providerKey) => ({
      metadata: { isShip: true, providerKey, shipId: `s-${providerKey}`, projectId: 'p', kind: 'main', providerTint: LOCAL_RED },
      material: { emissiveColor: { toHexString: () => LOCAL_RED.toUpperCase() } },
    });
    let stats = null;
    try { stats = AUR.sceneProviderStats({ meshes: [mesh('claude'), mesh('local')] }); } catch (error) { fail('O5', `sceneProviderStats threw ${error.message}`); }
    if (stats) {
      same('O5', { ...stats.providerCounts }, { claude: 1, codex: 0, generic: 0, local: 1 }, 'sceneProviderStats counts local');
      check('O5', Object.values(stats.providerCounts).every(Number.isFinite), 'sceneProviderStats has a NaN count');
      same('O5', stats.distinctColorCount, 1, 'sceneProviderStats distinct colours');
    }
  }
}

// ---- O7: docs ----
const spec = read('kit/SPEC.md');
check('O7', /provider:\s*'claude'\|'codex'\|'generic'\|'local'/.test(spec), "SPEC §3 Ship.provider line lacks 'local'");
check('O7', /\/api\/ps/.test(spec), 'SPEC §3 does not mention /api/ps');
const providerDoc = read('docs/MULTI-PROVIDER.md');
check('O7', /^## Local model servers/m.test(providerDoc), 'docs/MULTI-PROVIDER.md lacks a "## Local model servers" section');
for (const needle of ['Ollama', '/api/ps', '"ollama": false', 'OLLAMA_HOST', 'LM Studio', /loopback/i, /never[^.]*(read|chat)/i]) {
  const ok = needle instanceof RegExp ? needle.test(providerDoc) : providerDoc.includes(needle);
  check('O7', ok, `docs/MULTI-PROVIDER.md does not mention ${needle}`);
}
check('O7', /ollama/i.test(read('SECURITY.md')) && /loopback/i.test(read('SECURITY.md')), 'SECURITY.md scope does not name Ollama and loopback');
check('O7', /ollama/i.test(read('README.md')), 'README.md does not mention Ollama');
check('O7', /ollama-source/.test(read('AGENTS.md')) && /`local`/.test(read('AGENTS.md')), 'AGENTS.md does not name ollama-source and the `local` provider');

// ---- O4: real sockets through the Tracker ----
async function sockets() {
  let payload = { models: [psModel('qwen3.6:27b-q4_K_M', 23e9, 0, Date.now() + 5 * MIN)] };
  let bigBody = false;
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (req.method === 'GET' && req.url === '/api/ps') {
      res.setHeader('content-type', 'application/json');
      res.end(bigBody ? `{"models":[${JSON.stringify({ name: 'x'.repeat(300 * 1024) })}]}` : JSON.stringify(payload));
    } else { res.statusCode = 404; res.end(); }
  });
  const hanging = http.createServer(() => { /* never answers */ });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => hanging.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const hangPort = hanging.address().port;
  const warns = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warns.push(args.join(' ')); };
  const trackers = [];
  const make = (w, extra = {}) => {
    const tracker = new Tracker(w.statePath, { ...w.dirs, providerConfigPath: w.configPath, ...extra });
    trackers.push(tracker);
    return tracker;
  };
  const localShips = (tracker) => tracker.snapshot().ships.filter((ship) => ship.provider === 'local');
  try {
    const w = world('sockets');
    const options = { ollama: { host: `127.0.0.1:${port}`, home: w.home } };
    const t1 = make(w, options);
    same('O4', await t1.pollOllama(), { polled: true, reachable: true }, '4.1 first poll');
    same('O4', localShips(t1).length, 1, '4.1 one local ship');
    same('O4', hits, ['GET /api/ps'], '4.1 exactly one GET /api/ps');
    payload = { models: [] };
    await t1.pollOllama();
    same('O4', localShips(t1).length, 0, '4.2 empty models departs the ship');
    t1.saveState();
    t1.stop();

    payload = { models: [psModel('qwen3.6:27b-q4_K_M', 23e9, 0, Date.now() + 5 * MIN)] };
    const t2 = make(w, options);
    await t2.pollOllama();
    const project = t2.snapshot().projects.find((item) => item.id === 'project:ollama');
    check('O4', project && project.name === 'Ollama', `4.3 after restore the project is ${JSON.stringify(project && project.name)}`);
    same('O4', localShips(t2).length, 1, '4.3 ship after restore');

    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    const before = Date.now();
    const first = await t2.pollOllama();
    check('O4', first.polled === true && t2.model.ollama.failures === 1 && t2.model.ollama.nextPollAt > before,
      `4.4 first failure: ${JSON.stringify(first)} failures=${t2.model.ollama.failures}`);
    same('O4', localShips(t2).length, 1, '4.4 one failure keeps the ship');
    same('O4', (await t2.pollOllama()).polled, false, '4.4 backoff skips the next poll');
    t2.model.ollama.nextPollAt = 0;
    const secondFailure = await t2.pollOllama();
    same('O4', secondFailure.reachable, false, '4.4 second failure flips reachable');
    same('O4', localShips(t2).length, 0, '4.4 second failure departs the ship');
    t2.stop();

    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    hits.length = 0;
    const w5 = world('config');
    fs.writeFileSync(w5.configPath, JSON.stringify({ watch: [], ollama: { host: '10.0.0.5:11434' } }));
    const t3 = make(w5, { ollama: { host: `127.0.0.1:${port}`, home: w5.home } });
    same('O4', (await t3.pollOllama()).polled, false, '4.5 non-loopback config is not polled');
    same('O4', hits.length, 0, '4.5 non-loopback config made a request');
    same('O4', warns.filter((line) => /\[providers\]/.test(line)).length, 1, '4.5 exactly one [providers] warning');
    fs.writeFileSync(w5.configPath, JSON.stringify({ ollama: false }));
    same('O4', (await t3.pollOllama()).polled, false, '4.5 "ollama": false is not polled');
    same('O4', hits.length, 0, '4.5 disabled config made a request');
    same('O4', warns.filter((line) => /\[providers\]/.test(line)).length, 1, '4.5 disabled config warned');
    t3.stop();

    bigBody = true;
    const w6 = world('big');
    const t4 = make(w6, { ollama: { host: `127.0.0.1:${port}`, home: w6.home } });
    await t4.pollOllama();
    check('O4', t4.model.ollama.failures === 1 && localShips(t4).length === 0, '4.6 oversize body must count as a failure with no ship');
    bigBody = false;
    t4.stop();

    const w7 = world('hang');
    const t5 = make(w7, { ollama: { host: `127.0.0.1:${hangPort}`, home: w7.home } });
    const started = Date.now();
    await t5.pollOllama();
    const took = Date.now() - started;
    check('O4', took < 4000 && t5.model.ollama.failures === 1, `4.7 hanging server: settled in ${took} ms, failures=${t5.model.ollama.failures}`);
    t5.stop();

    const t6 = make(w7, { ollama: { host: `127.0.0.1:${hangPort}`, home: w7.home } });
    const pending = t6.pollOllama();
    const stopAt = Date.now();
    t6.stop();
    await pending;
    check('O4', Date.now() - stopAt < 500, `4.8 stop() did not abort the in-flight poll (${Date.now() - stopAt} ms)`);

    hits.length = 0;
    const w9 = world('isolated');
    const savedHost = process.env.OLLAMA_HOST;
    process.env.OLLAMA_HOST = `127.0.0.1:${port}`;
    const t7 = make(w9);
    t7.start();
    await sleep(300);
    t7.stop();
    if (savedHost === undefined) delete process.env.OLLAMA_HOST; else process.env.OLLAMA_HOST = savedHost;
    same('O4', hits.length, 0, '4.9 a Tracker without options.ollama contacted the server');
    same('O4', await t7.pollOllama(), { polled: false, reachable: null }, '4.9 pollOllama without options.ollama');
    for (const folder of [w, w5, w6, w7, w9]) fs.rmSync(folder.base, { recursive: true, force: true });
  } catch (error) {
    fail('O4', error.stack || String(error));
  } finally {
    console.warn = originalWarn;
    for (const tracker of trackers) { try { tracker.stop(); } catch { /* already stopped */ } }
    server.closeAllConnections();
    hanging.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => hanging.close(() => resolve()));
  }
}
await sockets();

if (FIXTURES_ONLY) { notes.push('fixtures only: O6 and O8 skipped'); report(); }

// ---- O6: rendered proof through the provider harness ----
async function terminateTree(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('exit', resolve); killer.once('error', resolve);
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') child.kill('SIGKILL'); }
  }
}
{
  const outRoot = path.join(root, '.shots', 'ollama');
  fs.mkdirSync(outRoot, { recursive: true });
  const outDir = fs.mkdtempSync(path.join(outRoot, 'run-'));
  const electron = process.platform === 'win32'
    ? path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
    : path.join(root, 'node_modules', '.bin', 'electron');
  const startedAt = Date.now();
  const child = spawn(electron, ['.', '--provider-test', `--provider-output=${outDir}`], {
    cwd: root, windowsHide: true, detached: process.platform !== 'win32',
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  let timer;
  const code = await Promise.race([
    new Promise((resolve) => { child.once('exit', resolve); child.once('error', () => resolve('spawn-error')); }),
    new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), 90_000); }),
  ]).finally(() => clearTimeout(timer));
  if (code === 'timeout') await terminateTree(child);
  if (code !== 0) fail('O6', `provider harness exited with ${code}: ${output.split(/\r?\n/).filter(Boolean).slice(-6).join(' | ')}`);
  const rendererErrors = output.split(/\r?\n/).filter((line) => ERROR_RE.test(line));
  if (rendererErrors.length) fail('O6', `renderer errors: ${rendererErrors.slice(0, 4).join(' | ')}`);
  const resultPath = path.join(outDir, 'result.json');
  if (!fs.existsSync(resultPath)) fail('O6', 'missing provider result.json');
  else {
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    const metrics = result.providerMetrics || {};
    check('O6', result.passed === true, `harness passed=${result.passed}: ${result.error || ''}`);
    for (const key of ['publicProviderCounts', 'meshProviderCounts', 'rowProviderCounts']) {
      check('O6', (metrics[key] || {}).local >= 1, `${key}.local < 1 (${JSON.stringify(metrics[key])})`);
    }
    const hull = (metrics.visuals || []).find((visual) => visual.providerKey === 'local');
    check('O6', hull && hull.assetHullId && hull.visualKind !== 'signal-marker', `no local hull visual: ${JSON.stringify(hull)}`);
    check('O6', (result.sidebarProviderTags || metrics.sidebarProviderTags || []).includes('LOCAL'), 'sidebar lacks the LOCAL tag');
    check('O6', (metrics.modelTags || []).includes('fixture-local:7b'), `modelTags lack "fixture-local:7b": ${JSON.stringify(metrics.modelTags)}`);
    check('O6', metrics.distinctProviderColors >= 4, `distinctProviderColors=${metrics.distinctProviderColors}, need 4`);
    check('O6', (result.rendererErrors || []).length === 0, 'renderer errors recorded by the harness');
  }
  const shot = path.join(outDir, 'universe.png');
  check('O6', fs.existsSync(shot) && fs.statSync(shot).mtimeMs >= startedAt && fs.statSync(shot).size > 30 * 1024,
    'universe.png is missing, stale or blank');
  notes.push(`rendered artifacts ${outDir}`);
}

// ---- O8: regression gates ----
if (!NO_REGRESSION) {
  const grade = spawnSync(process.execPath, [path.join(root, 'kit', 'grade.mjs')], { cwd: root, stdio: 'inherit' });
  check('O8', grade.status === 0, `node kit/grade.mjs exited ${grade.status}`);
  const typecheck = spawnSync('npm run typecheck', { cwd: root, stdio: 'inherit', shell: true });
  check('O8', typecheck.status === 0, `npm run typecheck exited ${typecheck.status}`);
} else notes.push('regression skipped (--no-regression)');

report();

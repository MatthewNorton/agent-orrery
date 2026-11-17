// @ts-check
'use strict';

// Local model ships, Ollama adapter. A model loaded in the loopback Ollama server is a red hull
// named for the server (Ollama-1, Ollama-2, ...) in the server's own system, its home folder,
// whatever client is driving it. The one request is GET /api/ps: the loaded models, their memory
// split and expires_at, never a chat. Ollama sets expires_at again, from the request's own
// keep_alive, each time a model completes a request, so a change between two polls means "a
// request was just served"; while a request runs the unload timer is stopped and expires_at is
// left as it was, so a model still listed past its expiry is serving one now.

const { readGenericWatchConfig } = require('../provider-adapters');
const { localAbsolutePath } = require('../path-safety');
const { hex8 } = require('../shared/hash');
const { plainObject, firstTrimmed } = require('../transcripts/fields');
const { modelName } = require('../transcripts/model');
const { liveShip } = require('../universe/public-shape');
const { queue, pushFeed, flush } = require('./events');
const { ensureProjectForPath, announceProjectUpdated } = require('./projects');
const { ensureProviderShip, departShip } = require('./ships');
const { warnOnce } = require('./drift');

/** @import { LiveModel, LiveProject, OllamaModel, OllamaState, OllamaStatus } from '../../types/live-model' */

const DEFAULT_HOST = '127.0.0.1:11434';
const DEFAULT_PORT = 11434;
// Security: a Map, so a host spelled like an Object.prototype key cannot look up anything.
const LOOPBACK = new Map([
  ['127.0.0.1', '127.0.0.1'], ['localhost', '127.0.0.1'], ['0.0.0.0', '127.0.0.1'], ['::1', '[::1]'], ['[::1]', '[::1]'],
]);
const HOST_RE = /^(?:(https?):\/\/)?(\[[^\]]*\]|::1|[^:/?#@[\]]+)(?::(\d{1,5}))?\/*$/;
const PROJECT_ID = 'project:ollama';
const LABEL = 'Ollama';
const REQUEST_TIMEOUT_MS = 3000;
const BODY_LIMIT = 256 * 1024;
const MODEL_LIMIT = 32;
const BACKOFF_MS = [15_000, 30_000, 60_000];

/**
 * Where the server is asked, from the providers.json `ollama` entry as written, the Tracker option
 * and OLLAMA_HOST, in that order of precedence, plus the home folder the entry names. Ollama's own
 * host syntax: `host`, `host:port`, `http://host[:port]`.
 * @param {{ config?: unknown, option?: unknown, env?: unknown }} [sources]
 * @returns {{ origin: string, home: string | null } | { disabled: true } | { warning: string }}
 */
function ollamaEndpoint({ config, option, env } = {}) {
  if (config === false) return { disabled: true };
  if (config !== undefined && !plainObject(config)) return { warning: 'provider config ollama entry must be false or an object' };
  const entry = plainObject(config) ? config : {};
  for (const key of ['host', 'home']) {
    if (entry[key] != null && typeof entry[key] !== 'string') return { warning: `provider config ollama.${key} must be a string` };
  }
  const value = firstTrimmed(typeof entry.host === 'string' ? entry.host.slice(0, 128) : null, option, env) || DEFAULT_HOST;
  // Security: the only place a request to a local model server is addressed. Only http on a
  // loopback host is accepted; a LAN host, https, a path, a query or userinfo is refused here.
  const match = HOST_RE.exec(value);
  const host = match && match[1] !== 'https' ? LOOPBACK.get(match[2].toLowerCase()) : undefined;
  const port = match && match[3] ? Number(match[3]) : DEFAULT_PORT;
  if (!host || port < 1 || port > 65535) {
    const shown = value.replace(/\p{C}/gu, '').slice(0, 64);
    return { warning: `Ollama host "${shown}" is not a loopback http address; local model ships are off until ollama.host in providers.json or OLLAMA_HOST is one` };
  }
  return { origin: `http://${host}:${port}`, home: localAbsolutePath(entry.home) };
}

/**
 * The loaded models a /api/ps body lists, or null when it is not that shape.
 * @param {unknown} text
 * @returns {{ models: OllamaModel[] } | null}
 */
function parseOllamaStatus(text) {
  if (typeof text !== 'string') return null;
  let body;
  try { body = JSON.parse(text); } catch { return null; }
  if (!plainObject(body) || !Array.isArray(body.models)) return null;
  /** @type {OllamaModel[]} */
  const models = [];
  const seen = new Set();
  for (const entry of body.models) {
    if (models.length >= MODEL_LIMIT) break;
    if (!plainObject(entry)) continue;
    const name = modelName(entry.name ?? entry.model);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    models.push({
      name,
      size: nonNegative(entry.size),
      sizeVram: nonNegative(entry.size_vram),
      expiresAt: typeof entry.expires_at === 'string' ? Date.parse(entry.expires_at) || 0 : 0,
    });
  }
  return { models };
}

/** @param {unknown} value */
function nonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The ship's detail: model size and where it sits, as `ollama ps` prints it.
 * @param {number} size
 * @param {number} sizeVram
 * @returns {string | null}
 */
function ollamaDetail(size, sizeVram) {
  if (!(size > 0)) return null;
  const gb = `${(size / 1e9).toFixed(1)} GB`;
  if (sizeVram <= 0) return `${gb} · 100% CPU`;
  if (sizeVram >= size) return `${gb} · 100% GPU`;
  const cpu = Math.round((size - sizeVram) / size * 100);
  return `${gb} · ${cpu}%/${100 - cpu}% CPU/GPU`;
}

/**
 * The reducer: one server status at one time becomes ships, activity and departures.
 * @param {LiveModel} model
 * @param {OllamaStatus} status
 * @param {number} now
 */
function applyOllamaStatus(model, status, now) {
  const state = model.ollama;
  if (!state) return;
  const feedProject = model.projects.has(PROJECT_ID) ? PROJECT_ID : '';
  if (!status.reachable) {
    if (state.reachable === true) pushFeed(model, 'info', 'Ollama server offline', feedProject);
    state.reachable = false;
    for (const name of [...state.loaded.keys()]) unload(model, name, now);
    return;
  }
  if (state.reachable === false) pushFeed(model, 'info', 'Ollama server online', feedProject);
  state.reachable = true;
  const present = new Set(status.models.map((entry) => entry.name));
  // A request served or running is the system's activity; a model merely resident is not, so the
  // system goes idle with its ships. The system appears once a model has loaded; one restored from
  // an earlier run takes the server's name as soon as the server answers.
  const active = status.models.some((entry) => { const request = requestState(state, entry, now); return request.served || request.busy; });
  const project = present.size || model.projects.has(PROJECT_ID) ? ollamaProject(model, active ? now : 0) : null;
  if (project) for (const entry of status.models) dock(model, project, entry, now);
  for (const name of [...state.loaded.keys()]) if (!present.has(name)) unload(model, name, now);
}

/** @param {string} name */
const sessionIdFor = (name) => `ollama-${hex8(name)}`;
/** @param {string} name */
const shipIdFor = (name) => `ship:local:${sessionIdFor(name)}`;

/**
 * What one listed model says of requests since the last poll.
 * @param {OllamaState} state
 * @param {OllamaModel} entry
 * @param {number} now
 */
function requestState(state, entry, now) {
  const seen = state.loaded.get(entry.name);
  return {
    // expires_at changed either way: a request with a shorter keep_alive moves it back.
    served: seen === undefined || entry.expiresAt !== seen,
    // Listed past its expiry: the unload timer is stopped because a request is running.
    busy: entry.expiresAt > 0 && entry.expiresAt <= now,
  };
}

/**
 * The server's system: its home folder, shown as Ollama whatever the folder is called.
 * @param {LiveModel} model
 * @param {number} activity 0 when nothing is loaded, so an idle server is not activity
 * @returns {LiveProject | null}
 */
function ollamaProject(model, activity) {
  const home = model.ollama.configHome || model.ollama.home;
  const project = ensureProjectForPath(model, home, PROJECT_ID, activity, 0);
  if (!project) return null;
  if (project.name !== LABEL) {
    project.name = LABEL;
    announceProjectUpdated(model, project);
  }
  if (!project.exists) warnOnce(model, `Ollama home folder ${home} not found; set ollama.home in providers.json`);
  return project;
}

/**
 * One loaded model: a new ship, a request served or still running, a changed memory split, or nothing.
 * @param {LiveModel} model
 * @param {LiveProject} project
 * @param {OllamaModel} entry
 * @param {number} now
 */
function dock(model, project, entry, now) {
  const state = model.ollama;
  const shipId = shipIdFor(entry.name);
  const { served, busy } = requestState(state, entry, now);
  const detail = ollamaDetail(entry.size, entry.sizeVram);
  let ship = model.ships.get(shipId);
  if (!ship) {
    // Warped out idle by the sweep: it docks again once the model serves, or is serving, a request.
    if (!served && !busy) return;
    ship = ensureProviderShip(model, 'local', project.id, sessionIdFor(entry.name), 'main', now, null,
      { local: true, model: entry.name, label: LABEL, detail });
    if (!ship) return;
  } else if (served || busy) {
    ship.lastEvent = now;
    ship.detail = detail;
    queue(model, { type: 'ship-updated', ship: liveShip(ship) });
    if (served) queue(model, { type: 'activity', project: project.id, shipId, tool: 'ollama', status: 'Working', detail, ts: now });
  } else if (ship.detail !== detail) {
    ship.detail = detail;
    queue(model, { type: 'ship-updated', ship: liveShip(ship) });
  }
  state.loaded.set(entry.name, entry.expiresAt);
}

/**
 * A model no longer loaded, or a server gone: its ship departs.
 * @param {LiveModel} model
 * @param {string} name
 * @param {number} now
 */
function unload(model, name, now) {
  model.ollama.loaded.delete(name);
  const ship = model.ships.get(shipIdFor(name));
  if (ship) departShip(model, ship, now, 'unloaded');
}

/**
 * One poll: GET /api/ps on the loopback server, then the reducer. A failed poll backs off
 * (15 s, 30 s, then 60 s); the second consecutive failure takes the server offline. Never throws.
 * @param {LiveModel} model
 * @returns {Promise<{ polled: boolean, reachable: boolean | null }>}
 */
async function pollOllama(model) {
  const state = model.ollama;
  if (!state) return { polled: false, reachable: null };
  if (state.inFlight || Date.now() < state.nextPollAt) return { polled: false, reachable: state.reachable };
  const endpoint = ollamaEndpoint({
    config: readGenericWatchConfig(model.providerConfigPath).ollama, option: state.host, env: process.env.OLLAMA_HOST,
  });
  if (!('origin' in endpoint)) {
    if ('warning' in endpoint) warnOnce(model, endpoint.warning);
    if (state.loaded.size) {
      applyOllamaStatus(model, { reachable: false }, Date.now());
      flush(model);
    }
    return { polled: false, reachable: state.reachable };
  }
  // providers.json may name the server's home folder, for an install that keeps none at ~/.ollama;
  // it is read every poll like the host, so removing the entry takes effect too.
  state.configHome = endpoint.home;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  state.inFlight = controller;
  let parsed = null;
  try {
    // Security: a redirect from whatever listens on the port must not turn this into a request elsewhere.
    const response = await state.fetch(`${endpoint.origin}/api/ps`, { signal: controller.signal, redirect: 'error' });
    const text = await readBody(response); // read on any status, so a failed response frees its socket
    if (response.ok && text !== null) parsed = parseOllamaStatus(text);
  } catch { /* unreachable, timed out, aborted or not a body: a failure, counted below */ }
  clearTimeout(timer);
  state.inFlight = null;

  const now = Date.now();
  try {
    if (parsed) {
      state.failures = 0;
      state.nextPollAt = 0;
      applyOllamaStatus(model, { reachable: true, models: parsed.models }, now);
    } else {
      state.failures += 1;
      state.nextPollAt = now + BACKOFF_MS[Math.min(state.failures, BACKOFF_MS.length) - 1];
      if (state.failures >= 2) applyOllamaStatus(model, { reachable: false }, now);
    }
    flush(model);
  } catch (error) {
    // The Tracker's interval drops the promise, and a rejection there would be unhandled.
    console.error('[ollama] poll failed:', error);
  }
  return { polled: true, reachable: state.reachable };
}

/**
 * Security: the body as text, read with a cap on bytes received: null once the listener has sent
 * more than BODY_LIMIT, however slowly, so a misbehaving process on the port cannot fill memory
 * before the parser's turn.
 * @param {Pick<Response, 'body'>} response
 * @returns {Promise<string | null>}
 */
async function readBody(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > BODY_LIMIT) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Aborts a poll in flight, so stop() does not wait on the server.
 * @param {LiveModel} model
 */
function stopOllama(model) {
  if (model.ollama && model.ollama.inFlight) model.ollama.inFlight.abort();
}

module.exports = { ollamaEndpoint, parseOllamaStatus, ollamaDetail, applyOllamaStatus, pollOllama, stopOllama };

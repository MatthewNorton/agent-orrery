// @ts-check
'use strict';

// Ships and drones: how they enter, which tool calls they hold open, and when they warp out.

const { normalizeProvider } = require('../provider-adapters');
const { liveShip } = require('../universe/public-shape');
const { createShipRecord, assignModel } = require('../universe/ships');
const { queue, pushFeed } = require('./events');
const { ACTIVE_WINDOW_MS } = require('./model');

/** @import { LiveModel, LiveProject, LiveShip } from '../../types/live-model' */

const DRONE_TIMEOUT_MS = 15 * 60 * 1000;
const ATTENTION_LINGER_MS = 60 * 60 * 1000;
const PENDING_LIMIT = 12;

/**
 * The ship of a Claude transcript. Claude ships and drones share one name counter.
 * @param {LiveModel} model
 * @param {string} projectId
 * @param {string} session
 * @param {boolean} sidechain
 * @param {number} ts
 * @returns {LiveShip}
 */
function ensureShip(model, projectId, session, sidechain, ts) {
  const id = `ship:${projectId}:${session}`;
  let ship = model.ships.get(id);
  if (!ship) {
    const project = model.projects.get(projectId);
    ship = createShipRecord({
      id, name: `Claude-${++model.shipCounter}`, provider: 'claude', project: projectId,
      kind: sidechain ? 'drone' : 'main', lastEvent: ts,
    });
    model.ships.set(id, ship);
    queue(model, { type: 'ship-spawned', ship: liveShip(ship) });
    pushFeed(model, 'spawn', `${ship.name} entered ${project ? project.name : projectId}`, projectId);
  }
  return ship;
}

/**
 * A drone for a Claude Task/Agent call; it docks again on the call's result.
 * @param {LiveModel} model
 * @param {LiveProject} project
 * @param {LiveShip} parent
 * @param {any} toolUseId
 * @param {number} ts
 */
function spawnDrone(model, project, parent, toolUseId, ts) {
  if (!toolUseId) return;
  const id = `drone:${toolUseId}`;
  if (model.ships.has(id)) return;
  const drone = createShipRecord({
    id, name: `Claude-${++model.shipCounter}`, provider: 'claude', project: project.id, kind: 'drone',
    parentName: parent.name, lastEvent: ts, local: parent.local === true, model: parent.model,
  });
  model.ships.set(id, drone);
  queue(model, { type: 'ship-spawned', ship: liveShip(drone) });
  pushFeed(model, 'spawn', `${parent.name} launched ${drone.name} in ${project.name}`, project.id);
}

/**
 * Announces a ship's model facts when they change.
 * @param {LiveModel} model
 * @param {LiveShip | null} ship
 * @param {{ local?: unknown, model?: unknown }} facts
 */
function setModel(model, ship, facts) {
  if (ship && assignModel(ship, facts)) queue(model, { type: 'ship-updated', ship: liveShip(ship) });
}

/**
 * The ship of a Codex or Signal session, named from its provider's own counter.
 * @param {LiveModel} model
 * @param {unknown} providerValue
 * @param {string} projectId
 * @param {string} sessionId
 * @param {string} kind
 * @param {number} ts
 * @param {string | null | undefined} parentSessionId
 * @returns {LiveShip | null}
 */
function ensureProviderShip(model, providerValue, projectId, sessionId, kind, ts, parentSessionId) {
  const provider = normalizeProvider(providerValue);
  if (!projectId || !sessionId || !model.projects.has(projectId)) return null;
  const id = `ship:${provider}:${sessionId}`;
  let ship = model.ships.get(id);
  if (!ship) {
    const labels = { claude: 'Claude', codex: 'Codex', signal: 'Signal' };
    const next = (model.providerCounters.get(provider) || 0) + 1;
    model.providerCounters.set(provider, next);
    const parent = parentSessionId ? model.ships.get(`ship:${provider}:${parentSessionId}`) : null;
    ship = createShipRecord({
      id, name: `${labels[provider] || 'Signal'}-${next}`, provider, project: projectId,
      kind: kind === 'drone' ? 'drone' : 'main', parentName: parent ? parent.name : null, lastEvent: ts,
    });
    model.ships.set(id, ship);
    queue(model, { type: 'ship-spawned', ship: liveShip(ship) });
    const project = model.projects.get(projectId);
    pushFeed(model, 'spawn', `${ship.name} entered ${project ? project.name : projectId}`, projectId);
  } else {
    ship.project = projectId;
    if (kind === 'drone') ship.kind = 'drone';
  }
  return ship;
}

/**
 * Opens a tool call on a ship; past the limit the oldest open call is forgotten.
 * @param {LiveModel} model
 * @param {LiveShip} ship
 * @param {any} pendingId
 * @param {any} tool
 * @param {number} ts
 */
function addPending(model, ship, pendingId, tool, ts) {
  ship.pending.set(pendingId, { tool, ts });
  model.pendingIndex.set(pendingId, ship.id);
  while (ship.pending.size > PENDING_LIMIT) {
    const oldestId = ship.pending.keys().next().value;
    ship.pending.delete(oldestId);
    if (model.pendingIndex.get(oldestId) === ship.id) model.pendingIndex.delete(oldestId);
  }
}

/**
 * Closes a provider tool call and announces its ship.
 * @param {LiveModel} model
 * @param {string} pendingId
 * @param {number} ts
 */
function clearPending(model, pendingId, ts) {
  const ownerId = model.pendingIndex.get(pendingId);
  if (!ownerId) return;
  const owner = model.ships.get(ownerId);
  if (owner) {
    owner.pending.delete(pendingId);
    owner.lastEvent = Math.max(owner.lastEvent, ts);
    queue(model, { type: 'ship-updated', ship: liveShip(owner) });
  }
  model.pendingIndex.delete(pendingId);
}

/**
 * Warps out every ship idle past its window. A ship asking a question or waiting for permission
 * stays up to an hour.
 * @param {LiveModel} model
 * @param {number} now
 */
function departIdleShips(model, now) {
  for (const [id, ship] of model.ships) {
    const needsAttention = ship.attention === 'question' || ship.attention === 'permission';
    if (ship.kind !== 'drone' && needsAttention && now - ship.lastEvent <= ATTENTION_LINGER_MS) {
      continue;
    }
    const timeout = ship.kind === 'drone' ? DRONE_TIMEOUT_MS : ACTIVE_WINDOW_MS;
    if (now - ship.lastEvent > timeout) {
      for (const toolUseId of ship.pending.keys()) {
        if (model.pendingIndex.get(toolUseId) === id) model.pendingIndex.delete(toolUseId);
      }
      model.ships.delete(id);
      queue(model, { type: 'ship-departed', shipId: id, ts: now });
      pushFeed(model, 'depart', `${ship.name} warped out`, ship.project);
    }
  }
}

module.exports = {
  ensureShip,
  spawnDrone,
  setModel,
  ensureProviderShip,
  addPending,
  clearPending,
  departIdleShips,
};

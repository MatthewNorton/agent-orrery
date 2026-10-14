// @ts-check
'use strict';

// The project and ship shapes the renderer receives. Live and history differ on purpose;
// test/tracker-replay-parity.test.js lists every difference.

const { normalizeProvider } = require('../provider-adapters');
const { fnv1a } = require('../shared/hash');
const { deriveGalaxy, historyGalaxy } = require('./galaxy');

/**
 * @import { Project, Ship, ShipStatus } from '../../types/contract'
 * @import { LiveProject, LiveShip } from '../../types/live-model'
 */

/**
 * @param {LiveProject} p
 * @returns {Project}
 */
function liveProject(p) {
  return {
    id: p.id, path: p.path, name: p.name, exists: p.exists,
    firstSeen: p.firstSeen, lastActivity: p.lastActivity, totalBytes: p.totalBytes,
    totalBuilds: p.totalBuilds, seed: fnv1a(p.id),
    galaxy: deriveGalaxy(p.path, p.id, p.exists),
    planets: Object.keys(p.buckets || {}),
  };
}

/**
 * @param {LiveShip} s
 * @returns {Ship}
 */
function liveShip(s) {
  return {
    id: s.id, name: s.name, project: s.project, kind: s.kind,
    provider: normalizeProvider(s.provider || 'claude'),
    status: /** @type {ShipStatus} */ (s.status), detail: s.detail, lastEvent: s.lastEvent,
    attention: s.attention, attentionSince: s.attentionSince, builds: s.builds, local: s.local === true,
    model: s.model,
    taskId: typeof s.taskId === 'string' ? s.taskId : null,
    turnOutcome: typeof s.turnOutcome === 'string' ? s.turnOutcome : null,
  };
}

/** @returns {Project} */
function historyProject(project) {
  return {
    id: project.id,
    path: project.path,
    name: project.name,
    exists: project.exists,
    firstSeen: project.firstSeen,
    lastActivity: project.lastActivity,
    totalBytes: project.totalBytes,
    totalBuilds: project.totalBuilds,
    buckets: { ...project.buckets },
    seed: fnv1a(project.id),
    galaxy: historyGalaxy(project.path, project.exists),
    planets: Object.keys(project.buckets),
  };
}

/** @returns {Ship} */
function historyShip(ship) {
  return {
    id: ship.id,
    name: ship.name,
    project: ship.project,
    kind: ship.kind,
    provider: ship.provider,
    status: ship.status,
    detail: null,
    lastEvent: ship.lastEvent,
    attention: ship.attention,
    attentionSince: ship.attentionSince,
    builds: ship.builds,
    local: ship.local === true,
    model: ship.model,
  };
}

module.exports = { liveProject, liveShip, historyProject, historyShip };

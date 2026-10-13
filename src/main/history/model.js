// @ts-check
'use strict';

// The historical universe rebuilt from merged records: projects, ships, the feed, and the
// numbered event batches a forward advance emits. A seek resets it and reduces silently.

const fs = require('fs');
const path = require('path');
const { canonicalProjectPath, isLocalProjectPath } = require('../provider-adapters');
const { fnv1a, hex8, mulberry32 } = require('../shared/hash');
const { relativeInside } = require('../path-safety');
const { bucketOf, bucketKey, countBuild, bucketBuilds } = require('../build-buckets');
const { safeId, safePath } = require('../transcripts/fields');
const { proceduralSystem } = require('../universe/planets');
const { historyProject, historyShip } = require('../universe/public-shape');
const { createShipRecord } = require('../universe/ships');
const { applyRecord } = require('./apply-record');

/**
 * @import { FeedEntry, PlanetData, Project, Ship, SystemData } from '../../types/contract'
 * @import { LiveProject, LiveShip } from '../../types/live-model'
 * @import { HistoryRecord } from './record-reader'
 * @import { HistoryRuntime } from './apply-record'
 */

const FEED_LIMIT = 60;
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
const DRONE_WINDOW_MS = 15 * 60 * 1000;

/**
 * @typedef {object} ModelState
 * @property {Map<string, LiveProject>} projects
 * @property {Map<string, string>} projectIdByPath canonical path to project id
 * @property {Map<string, LiveShip>} ships
 * @property {FeedEntry[]} feed
 * @property {Map<string, HistoryRuntime>} runtimeBySource
 * @property {Map<string, number>} providerCounters ship names count per provider
 * @property {Set<string>} seenBuildSignals
 * @property {number} eventSequence
 * @property {Record<string, any>[]} pendingEvents
 */

/** @returns {ModelState} */
function emptyState() {
  return {
    projects: new Map(),
    projectIdByPath: new Map(),
    ships: new Map(),
    feed: [],
    runtimeBySource: new Map(),
    providerCounters: new Map(),
    seenBuildSignals: new Set(),
    eventSequence: 0,
    pendingEvents: [],
  };
}

/**
 * @param {{ batchSize: () => number, onBatch: (batch: Record<string, any>[]) => void,
 *   preferredProjectId: (canonicalPath: string) => string | undefined }} deps
 */
function createHistoryModel({ batchSize, onBatch, preferredProjectId }) {
  const state = emptyState();

  function reset() {
    Object.assign(state, emptyState());
  }

  function clearEvents() {
    state.eventSequence = 0;
    state.pendingEvents = [];
  }

  function queue(event, emit) {
    if (!emit) return;
    state.pendingEvents.push({ ...event, seq: ++state.eventSequence });
    if (state.pendingEvents.length >= batchSize()) flush();
  }

  function flush() {
    if (state.pendingEvents.length === 0) return;
    const batch = state.pendingEvents.splice(0, batchSize());
    onBatch(batch);
    if (state.pendingEvents.length) flush();
  }

  function pushFeed(kind, text, projectId, ts, emit) {
    const entry = { kind, text, project: projectId, ts };
    state.feed.push(entry);
    if (state.feed.length > FEED_LIMIT) state.feed = state.feed.slice(-FEED_LIMIT);
    queue({ type: 'feed', entry: { ...entry } }, emit);
  }

  /** @returns {LiveProject | null} */
  function ensureProject(projectPath, ts, emit, projectIdHint) {
    const key = canonicalProjectPath(projectPath);
    if (!key) return null;
    let id = state.projectIdByPath.get(key);
    if (!id) {
      id = safeId(preferredProjectId(key)) || safeId(projectIdHint) ||
        `project:${hex8(key)}`;
      if (state.projects.has(id) && canonicalProjectPath(state.projects.get(id).path) !== key) {
        id = `${id}-${fnv1a(key).toString(16)}`;
      }
    }
    let project = state.projects.get(id);
    if (!project) {
      project = {
        id,
        path: projectPath,
        name: path.basename(projectPath) || id,
        exists: safeExists(projectPath),
        firstSeen: ts,
        lastActivity: ts,
        totalBytes: 0,
        totalBuilds: 0,
        buckets: Object.create(null),
      };
      state.projects.set(id, project);
      state.projectIdByPath.set(key, id);
      queue({ type: 'project-added', project: historyProject(project) }, emit);
    }
    return project;
  }

  /**
   * @param {HistoryRuntime} runtime
   * @returns {LiveShip | null}
   */
  function ensureShip(runtime, ts, emit) {
    if (!runtime.projectId || !runtime.sessionId) return null;
    const id = runtime.provider === 'claude'
      ? `ship:${runtime.projectId}:${runtime.sessionId}`
      : `ship:${runtime.provider}:${runtime.sessionId}`;
    let ship = state.ships.get(id);
    if (!ship) {
      const number = (state.providerCounters.get(runtime.provider) || 0) + 1;
      state.providerCounters.set(runtime.provider, number);
      const parentId = runtime.parentSessionId
        ? `ship:${runtime.provider}:${runtime.parentSessionId}` : null;
      const parent = parentId ? state.ships.get(parentId) : null;
      ship = createShipRecord({
        id, name: `${runtime.provider === 'codex' ? 'Codex' : 'Claude'}-${number}`,
        provider: runtime.provider, project: runtime.projectId,
        kind: runtime.kind === 'drone' ? 'drone' : 'main', parentName: parent ? parent.name : null,
        lastEvent: ts, local: runtime.local,
      });
      state.ships.set(id, ship);
      queue({ type: 'ship-spawned', ship: historyShip(ship) }, emit);
      const project = state.projects.get(runtime.projectId);
      pushFeed('spawn', `${ship.name} entered ${project ? project.name : runtime.projectId}`,
        runtime.projectId, ts, emit);
    }
    return ship;
  }

  function spawnClaudeDrone(project, parent, sessionId, callId, ts, emit) {
    const id = `drone:claude:${sessionId}:${callId}`;
    if (state.ships.has(id)) return;
    const number = (state.providerCounters.get('claude') || 0) + 1;
    state.providerCounters.set('claude', number);
    const drone = createShipRecord({
      id, name: `Claude-${number}`, provider: 'claude', project: project.id, kind: 'drone',
      parentName: parent.name, lastEvent: ts, local: parent.local === true,
    });
    state.ships.set(id, drone);
    queue({ type: 'ship-spawned', ship: historyShip(drone) }, emit);
    pushFeed('spawn', `${parent.name} launched ${drone.name} in ${project.name}`,
      project.id, ts, emit);
  }

  function applyBuilds(project, ship, files, ts, emit) {
    if (!Array.isArray(files)) return;
    const seen = new Set();
    for (const value of files.slice(0, 256)) {
      const filePath = typeof value === 'string' ? value
        : value && typeof value === 'object' ? value.movePath || value.path : null;
      const relative = safePath(project.path) && safePath(filePath)
        ? relativeInside(project.path, filePath, { separator: '/', requireAbsolute: true }) : null;
      if (!relative || seen.has(relative)) continue;
      seen.add(relative);
      const bucket = bucketOf(relative, '/');
      const isNew = countBuild(project, bucket);
      project.totalBuilds++;
      ship.builds++;
      queue({
        type: 'build', project: project.id, bucket, file: relative,
        shipId: ship.id, isNew, ts,
      }, emit);
      if (isNew) pushFeed('form',
        `Planet formation started: ${bucket} in ${project.name}`, project.id, ts, emit);
      pushFeed('build', `${ship.name} building ${relative} in ${project.name}`,
        project.id, ts, emit);
    }
  }

  function advanceLifecycle(now, emit) {
    const due = [];
    for (const ship of state.ships.values()) {
      // Historical observation never pages the user for old prompts.
      ship.attention = null;
      ship.attentionSince = null;
      const timeout = ship.kind === 'drone' ? DRONE_WINDOW_MS : ACTIVE_WINDOW_MS;
      const deadline = ship.lastEvent + timeout;
      if (now > deadline) due.push({ ship, deadline });
    }
    due.sort((a, b) => a.deadline - b.deadline || a.ship.id.localeCompare(b.ship.id));
    for (const item of due) {
      if (state.ships.get(item.ship.id) === item.ship) {
        departShip(item.ship, item.deadline, emit, 'expired');
      }
    }
  }

  function setAttention(ship, attention, ts, emit) {
    if (ship.attention === attention) return;
    ship.attention = attention;
    ship.attentionSince = attention ? ts : null;
    queue({ type: 'ship-updated', ship: historyShip(ship) }, emit);
    if (attention === 'done') {
      const project = state.projects.get(ship.project);
      pushFeed('done', `${ship.name} finished its task in ${project ? project.name : ship.project}`,
        ship.project, ts, emit);
    }
  }

  function departShip(ship, ts, emit, reason) {
    if (!state.ships.has(ship.id)) return;
    state.ships.delete(ship.id);
    queue({ type: 'ship-departed', shipId: ship.id, ts }, emit);
    const text = reason === 'returned' && ship.parentName
      ? `${ship.name} returned to ${ship.parentName}` : `${ship.name} warped out`;
    pushFeed('depart', text, ship.project, ts, emit);
  }

  /** @returns {{ projects: Project[], ships: Ship[], feed: FeedEntry[], eventSequence: number }} */
  function snapshot() {
    return {
      projects: [...state.projects.values()].map(historyProject),
      ships: [...state.ships.values()].map(historyShip),
      feed: state.feed.slice(-FEED_LIMIT).map((entry) => ({ ...entry })),
      eventSequence: state.eventSequence,
    };
  }

  /**
   * @param {string} projectId
   * @returns {SystemData | null}
   */
  function getSystem(projectId) {
    const project = state.projects.get(projectId);
    if (!project) return null;
    let planets = Object.entries(project.buckets)
      .map(([name, builds]) => ({ name, files: 0, builds }))
      .sort((a, b) => b.builds - a.builds || a.name.localeCompare(b.name))
      .slice(0, 8);
    if (planets.length === 0) planets = proceduralSystem(projectId).planets;
    return { project: historyProject(project), planets, beltDensity: 0 };
  }

  /**
   * @param {string} projectId
   * @param {string} planetName
   * @returns {PlanetData | null}
   */
  function getPlanet(projectId, planetName) {
    const project = state.projects.get(projectId);
    if (!project || typeof planetName !== 'string') return null;
    const builds = bucketBuilds(project, planetName);
    const procedural = bucketKey(project, planetName) === null;
    const rand = mulberry32(fnv1a(`${projectId}:${planetName}`));
    return {
      name: planetName,
      project: historyProject(project),
      builds,
      files: procedural ? Math.floor(rand() * 160) : 0,
      sizeKb: procedural ? Math.floor(rand() * 3200) : 0,
      subdirs: procedural ? Math.floor(rand() * 8) : 0,
      resources: procedural ? ['Unknown'] : [],
      procedural,
    };
  }

  const model = {
    state,
    reset,
    clearEvents,
    queue,
    flush,
    ensureProject,
    ensureShip,
    spawnClaudeDrone,
    applyBuilds,
    advanceLifecycle,
    setAttention,
    departShip,
    /** @param {HistoryRecord} record @param {boolean} emit */
    applyRecord: (record, emit) => applyRecord(model, record, emit),
    snapshot,
    getSystem,
    getPlanet,
  };
  return model;
}

function safeExists(value) {
  // Security: never probe a UNC/device path derived from transcript content.
  if (!isLocalProjectPath(value)) return false;
  try { return fs.existsSync(value); } catch { return false; }
}

/** @typedef {ReturnType<typeof createHistoryModel>} HistoryModel */

module.exports = { createHistoryModel, FEED_LIMIT };

// @ts-check
'use strict';

// Universe backups: one JSON file holding universe-state.json as the model stands and the
// IDEAS queue's ideas. Importing one merges it into the live model and never removes anything.
// The file may come from anywhere, so every field is checked before it reaches the model.

const { canonicalProjectPath } = require('../provider-adapters');
const { localAbsolutePath } = require('../path-safety');
const { addBuckets, foldBuckets, setBucket } = require('../build-buckets');
const { hasControlChars, validProjectId } = require('../shared/ids');
const { ownString, wholeCount } = require('../shared/values');
const { plainObject } = require('../transcripts/fields');
const { liftForgotten } = require('./forgotten');
const {
  announceProjectUpdated, preferredProjectPath, projectIdAtPath, restoreProject, takeProjectPath,
} = require('./projects');
const { serializeState } = require('./state-file');

/**
 * @import { RootTaskItem } from '../../types/contract'
 * @import { LiveModel, PersistedProject } from '../../types/live-model'
 * @typedef {{ projects: [string, ImportedProject][], pathIds: [string, string][], ideas: string[] }} ParsedBackup
 * @typedef {PersistedProject & { path: string | null, override: string | null }} ImportedProject
 */

const BACKUP_FORMAT = 'agent-orrery-backup';
const BACKUP_VERSION = 1;
const MAX_BACKUP_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const MAX_KEY_LENGTH = 4096;
// Security: keys that would reach an object's prototype. A bucket (setBucket) and a project id are not held to them.
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * @param {LiveModel} model
 * @param {RootTaskItem[]} ideas
 * @param {number} [now]
 */
function createBackup(model, ideas, now = Date.now()) {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: now,
    universe: serializeState(model),
    ideas: ideas.map((item) => ({ text: item.text, createdAt: item.createdAt })),
  };
}

/**
 * The parts of a backup file the import uses, or null when it is not one.
 * @param {string} text
 * @returns {ParsedBackup | null}
 */
function parseBackup(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!plainObject(raw) || raw.format !== BACKUP_FORMAT || raw.version !== BACKUP_VERSION ||
      !plainObject(raw.universe) || !plainObject(raw.universe.projects)) return null;
  const overrides = plainObject(raw.universe.pathOverrides) ? raw.universe.pathOverrides : {};
  /** @type {[string, ImportedProject][]} */
  const projects = [];
  for (const [id, saved] of Object.entries(raw.universe.projects).slice(0, MAX_ENTRIES)) {
    // Security: an id may be '__proto__' (a folder of transcripts); every map it keys has no prototype.
    if (!validProjectId(id) || !plainObject(saved)) continue;
    // Security: a backup's path is later stat'd and opened; only a local absolute one may be.
    projects.push([id, {
      path: localAbsolutePath(saved.path),
      override: localAbsolutePath(Object.hasOwn(overrides, id) ? overrides[id] : null),
      name: validKey(saved.name) ? saved.name : undefined,
      lastActivity: wholeCount(saved.lastActivity),
      firstSeen: wholeCount(saved.firstSeen),
      totalBuilds: wholeCount(saved.totalBuilds),
      buckets: buckets(saved.buckets),
    }]);
  }
  const pathIds = Object.entries(plainObject(raw.universe.pathIds) ? raw.universe.pathIds : {})
    .slice(0, MAX_ENTRIES)
    .filter(([key, id]) => validKey(key) && typeof id === 'string' && validProjectId(id));
  const ideas = (Array.isArray(raw.ideas) ? raw.ideas : []).slice(0, MAX_ENTRIES)
    .map((idea) => ownString(idea, 'text'))
    .filter(Boolean);
  return { projects, pathIds, ideas };
}

/**
 * Adds the backup's projects the model lacks. One it already has, by id or by folder, keeps
 * the larger build count of each planet, the earlier first sight and the later activity.
 * An imported project is no longer forgotten.
 * @param {LiveModel} model
 * @param {ParsedBackup} backup
 * @returns {{ added: number, merged: number }}
 */
function importProjects(model, backup) {
  const targets = new Map();
  let added = 0;
  for (const [id, saved] of backup.projects) {
    const owner = projectIdAtPath(model, canonicalProjectPath(saved.path));
    liftForgotten(model, id);
    if (owner) liftForgotten(model, owner);
    const existing = model.projects.get(id) || (owner && model.projects.get(owner)) || null;
    const target = existing ? existing.id : id;
    targets.set(id, target);
    if (saved.override && !model.pathOverrides[target]) model.pathOverrides[target] = saved.override;
    if (!existing) {
      restoreProject(model, id, saved);
      added++;
      continue;
    }
    // The project takes its folder first: both sides are then counted by that folder's rule (each
    // side's casings of a folder added up), and the larger count of each folder is kept.
    const adopted = existing.path ? null : preferredProjectPath(model, target, saved.path);
    if (adopted) takeProjectPath(model, existing, adopted);
    addBuckets(existing, foldBuckets(existing.path, saved.buckets), Math.max);
    existing.totalBuilds = Math.max(existing.totalBuilds, saved.totalBuilds);
    if (saved.firstSeen && saved.firstSeen < existing.firstSeen) existing.firstSeen = saved.firstSeen;
    existing.lastActivity = Math.max(existing.lastActivity, saved.lastActivity);
    announceProjectUpdated(model, existing);
  }
  for (const [key, id] of backup.pathIds) {
    // A key that leads to a forgotten project is free to take.
    if (targets.has(id) && !model.projects.has(model.pathIds[key])) model.pathIds[key] = targets.get(id);
  }
  return { added, merged: targets.size - added };
}

/**
 * Security: a key or name from the file becomes an object key and reaches the screen.
 * @param {unknown} value
 * @returns {value is string}
 */
function validKey(value) {
  return plainText(value) && !RESERVED_KEYS.has(value);
}

/** @param {unknown} value @returns {value is string} */
function plainText(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_KEY_LENGTH && !hasControlChars(value);
}

function buckets(value) {
  /** @type {Record<string, number>} */
  const out = {};
  if (!plainObject(value)) return out;
  for (const [name, saved] of Object.entries(value).slice(0, MAX_ENTRIES)) {
    const builds = wholeCount(saved);
    if (plainText(name) && builds > 0) setBucket(out, name, builds);
  }
  return out;
}

module.exports = { MAX_BACKUP_BYTES, createBackup, parseBackup, importProjects };

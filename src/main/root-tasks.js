'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const STORE_VERSION = 1;
const MAX_RECORDS = 1_000;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_LENGTH = 10_000;
const MAX_PROJECT_ID_LENGTH = 256;
const PHASES = new Set([
  'idea',
  'prepared',
  'goal-written',
  'launch-requested',
  'launch-failed',
  'ready-for-review',
  'completion-failed',
  'reopened',
  'agent-aborted',
  'agent-departed',
  'agent-not-found',
]);
const OBSERVED_RUN_PHASES = new Set([
  'ready-for-review',
  'completion-failed',
  'reopened',
  'launch-failed',
  'agent-aborted',
  'agent-departed',
  'agent-not-found',
]);
const RETRYABLE_PHASES = new Set([
  'goal-written',
  'launch-failed',
  'reopened',
  'agent-aborted',
  'agent-departed',
  'agent-not-found',
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const RESERVED_MARKER_PATTERN = /agent-universe:/i;

class RootTaskStore {
  constructor(statePathOrOptions, options = {}) {
    const settings = typeof statePathOrOptions === 'string'
      ? { ...options, statePath: statePathOrOptions }
      : statePathOrOptions;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings) ||
        typeof settings.statePath !== 'string' || !path.isAbsolute(settings.statePath)) {
      throw new TypeError('RootTaskStore requires an absolute state path');
    }
    if (settings.fsImpl != null && typeof settings.fsImpl !== 'object') {
      throw new TypeError('fsImpl must be an object');
    }
    if (settings.now != null && typeof settings.now !== 'function') {
      throw new TypeError('now must be a function');
    }
    if (settings.randomUUID != null && typeof settings.randomUUID !== 'function') {
      throw new TypeError('randomUUID must be a function');
    }

    this.statePath = path.normalize(settings.statePath);
    this.fs = settings.fsImpl || fs;
    this.now = settings.now || Date.now;
    this.randomUUID = settings.randomUUID || crypto.randomUUID;
    this.records = this.load();
  }

  list() {
    return this.records.map(publicRecord);
  }

  get(id) {
    const normalizedId = normalizeId(id, false);
    if (!normalizedId) return null;
    const record = this.records.find((entry) => entry.id === normalizedId);
    return record ? publicRecord(record) : null;
  }

  create(text) {
    if (this.records.length >= MAX_RECORDS) {
      throw storeError('Root task limit reached', 'LIMIT_REACHED');
    }
    const normalizedText = normalizeText(text);
    const id = normalizeId(this.randomUUID(), true);
    if (this.records.some((entry) => entry.id === id)) {
      throw storeError('Generated root task id already exists', 'ID_COLLISION');
    }
    const timestamp = this.timestamp();
    const record = {
      id,
      text: normalizedText,
      projectId: null,
      phase: 'idea',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.commit([...this.records, record]);
    return publicRecord(record);
  }

  remove(id) {
    const normalizedId = normalizeId(id, true);
    const index = this.records.findIndex((entry) => entry.id === normalizedId);
    if (index === -1) throw storeError('Root task not found', 'NOT_FOUND');
    const record = this.records[index];
    if (record.phase !== 'idea' || record.projectId !== null) {
      throw invalidTransition(record.phase, 'removed');
    }
    this.commit(this.records.filter((entry) => entry.id !== normalizedId));
    return publicRecord(record);
  }

  prepare(id, projectId) {
    const normalizedProjectId = normalizeProjectId(projectId);
    return this.update(id, (record) => {
      if (record.projectId != null && record.projectId !== normalizedProjectId) {
        throw storeError('A root task project cannot be changed', 'PROJECT_IMMUTABLE');
      }
      if (record.phase !== 'idea') {
        if (record.projectId === normalizedProjectId) return null;
        throw invalidTransition(record.phase, 'prepared');
      }
      return {
        ...record,
        projectId: normalizedProjectId,
        phase: 'prepared',
        updatedAt: this.timestamp(record.updatedAt),
      };
    });
  }

  markGoalWritten(id) {
    return this.transition(id, 'prepared', 'goal-written', new Set([
      'goal-written', 'launch-requested', 'launch-failed',
    ]));
  }

  markLaunchRequested(id) {
    return this.transition(id, 'goal-written', 'launch-requested');
  }

  markLaunchFailed(id) {
    return this.transition(id, 'goal-written', 'launch-failed');
  }

  markRunPhase(id, projectId, phase) {
    const normalizedProjectId = normalizeProjectId(projectId);
    if (!OBSERVED_RUN_PHASES.has(phase)) {
      throw new TypeError('Invalid task run phase');
    }
    return this.update(id, (record) => {
      if (record.projectId !== normalizedProjectId) {
        throw storeError('A root task project cannot be changed', 'PROJECT_IMMUTABLE');
      }
      if (record.phase === phase) return null;
      if (record.phase === 'idea' || record.phase === 'prepared') {
        throw invalidTransition(record.phase, phase);
      }
      if (record.phase === 'ready-for-review' && phase !== 'reopened') {
        throw invalidTransition(record.phase, phase);
      }
      return {
        ...record,
        phase,
        updatedAt: this.timestamp(record.updatedAt),
      };
    });
  }

  prepareRetry(id) {
    return this.update(id, (record) => {
      if (record.phase === 'goal-written') return null;
      if (record.phase === 'launch-requested' || RETRYABLE_PHASES.has(record.phase)) {
        return {
          ...record,
          phase: 'goal-written',
          updatedAt: this.timestamp(record.updatedAt),
        };
      }
      throw invalidTransition(record.phase, 'goal-written');
    });
  }

  transition(id, expectedPhase, nextPhase, idempotentPhases = new Set([nextPhase])) {
    return this.update(id, (record) => {
      if (idempotentPhases.has(record.phase)) return null;
      if (record.phase !== expectedPhase) throw invalidTransition(record.phase, nextPhase);
      return {
        ...record,
        phase: nextPhase,
        updatedAt: this.timestamp(record.updatedAt),
      };
    });
  }

  update(id, change) {
    const normalizedId = normalizeId(id, true);
    const index = this.records.findIndex((entry) => entry.id === normalizedId);
    if (index === -1) throw storeError('Root task not found', 'NOT_FOUND');
    const current = this.records[index];
    const replacement = change(current);
    if (replacement == null) return publicRecord(current);
    const nextRecords = this.records.slice();
    nextRecords[index] = replacement;
    this.commit(nextRecords);
    return publicRecord(replacement);
  }

  timestamp(previous = -1) {
    const value = this.now();
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError('now must return a non-negative finite number');
    }
    return Math.max(value, previous);
  }

  commit(records) {
    this.persist(records);
    this.records = records;
  }

  load() {
    let bytes;
    let parsed;
    try {
      bytes = this.fs.readFileSync(this.statePath);
      if (!bytes || bytes.length > MAX_STATE_BYTES) return [];
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      return [];
    }
    if (!parsed || typeof parsed !== 'object' || parsed.version !== STORE_VERSION ||
        !Array.isArray(parsed.records) || parsed.records.length > MAX_RECORDS) {
      return [];
    }

    const records = [];
    const ids = new Set();
    for (const value of parsed.records) {
      const record = normalizeStoredRecord(value);
      if (!record || ids.has(record.id)) continue;
      ids.add(record.id);
      records.push(record);
    }
    return records;
  }

  persist(records) {
    if (!Array.isArray(records) || records.length > MAX_RECORDS) {
      throw storeError('Root task limit reached', 'LIMIT_REACHED');
    }
    const serialized = JSON.stringify({ version: STORE_VERSION, records });
    if (Buffer.byteLength(serialized, 'utf8') > MAX_STATE_BYTES) {
      throw storeError('Root task storage limit reached', 'LIMIT_REACHED');
    }
    const directory = path.dirname(this.statePath);
    this.fs.mkdirSync(directory, { recursive: true });
    const tempPath = path.join(
      directory,
      `.${path.basename(this.statePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
    );
    try {
      this.fs.writeFileSync(
        tempPath,
        serialized,
        { encoding: 'utf8', flag: 'wx' }
      );
      this.fs.renameSync(tempPath, this.statePath);
    } finally {
      try {
        this.fs.unlinkSync(tempPath);
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
      }
    }
  }
}

function normalizeText(value) {
  if (typeof value !== 'string') throw new TypeError('Root task text must be a string');
  if (CONTROL_PATTERN.test(value)) throw new TypeError('Invalid root task text');
  const text = value.trim();
  if (text.length === 0 || text.length > MAX_TEXT_LENGTH || RESERVED_MARKER_PATTERN.test(text)) {
    throw new TypeError('Invalid root task text');
  }
  return text;
}

function normalizeProjectId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PROJECT_ID_LENGTH ||
      value.trim().length === 0 || CONTROL_PATTERN.test(value)) {
    throw new TypeError('Invalid project id');
  }
  return value;
}

function normalizeId(value, required) {
  if (typeof value === 'string' && UUID_PATTERN.test(value)) return value.toLowerCase();
  if (required) throw new TypeError('Invalid root task id');
  return null;
}

function normalizeStoredRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !PHASES.has(value.phase) || !Number.isFinite(value.createdAt) || value.createdAt < 0 ||
      !Number.isFinite(value.updatedAt) || value.updatedAt < value.createdAt) {
    return null;
  }
  const id = normalizeId(value.id, false);
  if (!id) return null;

  let text;
  try {
    text = normalizeText(value.text);
  } catch {
    return null;
  }
  if (text !== value.text) return null;

  if (value.phase === 'idea') {
    if (value.projectId !== null) return null;
  } else {
    try {
      if (normalizeProjectId(value.projectId) !== value.projectId) return null;
    } catch {
      return null;
    }
  }
  return {
    id,
    text,
    projectId: value.projectId,
    phase: value.phase,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function publicRecord(record) {
  return {
    id: record.id,
    text: record.text,
    projectId: record.projectId,
    phase: record.phase,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function invalidTransition(from, to) {
  return storeError(`Cannot move root task from ${from} to ${to}`, 'INVALID_TRANSITION');
}

function storeError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = { RootTaskStore };

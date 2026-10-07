'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { completeAssignedGoal, validGoalId } = require('./goals');
const { writeFileAtomic } = require('./shared/atomic-write');

const ACTIVE_PHASES = new Set(['waiting-for-agent', 'running']);
const LOCKING_PHASES = new Set([...ACTIVE_PHASES, 'completing']);
const STORED_PHASES = new Set([
  'waiting-for-agent', 'running', 'completing', 'ready-for-review', 'launch-failed',
  'completion-failed', 'reopened', 'agent-aborted', 'agent-departed', 'agent-not-found',
]);
const RETRYABLE_PHASES = new Set([
  'reopened', 'launch-failed', 'agent-aborted', 'agent-departed', 'agent-not-found',
]);
const PROVIDERS = new Set(['codex']);
const MAX_RUNS = 500;
const MAX_TEXT = 10_000;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const CLAIM_CLOCK_SKEW_MS = 5_000;
const WAITING_TIMEOUT_MS = 5 * 60 * 1000;
const RUNNING_TIMEOUT_MS = 24 * 60 * 60 * 1000;

class TaskRunTracker {
  constructor(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options) ||
        typeof options.statePath !== 'string' || !path.isAbsolute(options.statePath) ||
        typeof options.resolveProjectRoot !== 'function') {
      throw new TypeError('TaskRunTracker requires a state path and project resolver');
    }
    this.statePath = path.normalize(options.statePath);
    this.resolveProjectRoot = options.resolveProjectRoot;
    this.onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.fs = options.fsImpl || fs;
    this.runs = this.load();
    try { this.recoverCompletions(); } catch { /* retried by reconcile and expiry sweeps */ }
  }

  start(input) {
    const run = normalizeStart(input, this.now());
    if (this.runs.some((entry) => entry.id === run.id && !RETRYABLE_PHASES.has(entry.phase))) {
      const error = new Error('Task already has an active or completed run');
      error.code = 'TASK_BUSY';
      throw error;
    }
    if (this.runs.some((entry) => LOCKING_PHASES.has(entry.phase) &&
        entry.projectId === run.projectId)) {
      const error = new Error('Project already has an active task run');
      error.code = 'PROJECT_BUSY';
      throw error;
    }
    const previousRuns = this.runs;
    this.runs = this.runs.filter((entry) => entry.id !== run.id);
    this.runs.push(run);
    try {
      this.prune();
      this.persist();
    } catch (error) {
      // A run must never be visible in memory unless its pre-launch
      // correlation record is durable too.
      this.runs = previousRuns;
      throw error;
    }
    this.changed(run, 'started');
    return publicRun(run);
  }

  failLaunch(id) {
    return this.setTerminalFailure(id, 'launch-failed', 'launch-failed');
  }

  observe(batch) {
    if (!Array.isArray(batch) || batch.length === 0) return [];
    const changed = [];
    for (const event of batch) {
      if (event && event.type === 'ship-departed' && typeof event.shipId === 'string') {
        const departed = this.runs.find((entry) => (
          ACTIVE_PHASES.has(entry.phase) && entry.shipId === event.shipId
        ));
        const failure = departed ? this.failRun(departed, 'agent-departed') : null;
        if (failure) changed.push(failure);
        continue;
      }
      if (!event || (event.type !== 'ship-spawned' && event.type !== 'ship-updated') ||
          !event.ship || event.ship.kind === 'drone') continue;
      const ship = event.ship;
      let run = this.runs.find((entry) => ACTIVE_PHASES.has(entry.phase) && entry.shipId === ship.id);
      if (!run) run = this.claimShip(ship);
      if (run && ship.turnOutcome === 'aborted') {
        const failure = this.failRun(run, 'agent-aborted');
        if (failure) changed.push(failure);
        continue;
      }
      if (!run || ship.attention !== 'done') continue;
      const completion = this.complete(run, ship);
      if (completion) changed.push(completion);
    }
    return changed;
  }

  decorate(projectId, items) {
    if (typeof projectId !== 'string' || !Array.isArray(items)) return [];
    const byGoal = new Map();
    for (const run of this.runs) {
      if (run.projectId !== projectId) continue;
      const prior = byGoal.get(run.id);
      if (!prior || run.updatedAt > prior.updatedAt) byGoal.set(run.id, run);
    }
    return items.map((item) => {
      const copy = { ...item };
      const run = item && validGoalId(item.id) ? byGoal.get(item.id.toLowerCase()) : null;
      if (!run || run.text !== item.text) return copy;
      if (run.phase === 'ready-for-review' && item.done === true) {
        copy.agentStatus = 'ready-for-review';
      } else if (LOCKING_PHASES.has(run.phase) && item.done === false) {
        copy.agentStatus = 'agent-working';
      }
      return copy;
    });
  }

  reconcile(projectId, items) {
    if (typeof projectId !== 'string' || !Array.isArray(items)) return;
    if (this.recoverCompletions(projectId).length > 0) return;
    const goals = new Map(items.filter((item) => item && validGoalId(item.id))
      .map((item) => [item.id.toLowerCase(), item]));
    const updates = [];
    for (const run of this.runs) {
      if (run.projectId !== projectId || run.phase !== 'ready-for-review') continue;
      const goal = goals.get(run.id);
      if (goal && goal.done === true && goal.text === run.text) continue;
      updates.push({ run, phase: run.phase, updatedAt: run.updatedAt, nextUpdatedAt: this.now() });
    }
    if (updates.length === 0) return;
    for (const update of updates) {
      const { run } = update;
      run.phase = 'reopened';
      run.updatedAt = update.nextUpdatedAt;
    }
    try {
      this.persist();
    } catch (error) {
      for (const update of updates) {
        update.run.phase = update.phase;
        update.run.updatedAt = update.updatedAt;
      }
      throw error;
    }
    for (const update of updates) this.changed(update.run, 'reopened');
  }

  get(id) {
    const run = typeof id === 'string' ? this.runs.find((entry) => entry.id === id.toLowerCase()) : null;
    return run ? publicRun(run) : null;
  }

  activeForProject(projectId) {
    const run = typeof projectId === 'string'
      ? this.runs.find((entry) => entry.projectId === projectId && LOCKING_PHASES.has(entry.phase))
      : null;
    return run ? publicRun(run) : null;
  }

  expire(now = this.now()) {
    if (!Number.isFinite(now)) return [];
    this.recoverCompletions();
    const expired = [];
    for (const run of this.runs) {
      const timedOutWaiting = run.phase === 'waiting-for-agent' &&
        now - run.startedAt >= WAITING_TIMEOUT_MS;
      const timedOutRunning = run.phase === 'running' &&
        now - run.startedAt >= RUNNING_TIMEOUT_MS;
      if (!timedOutWaiting && !timedOutRunning) continue;
      const failure = this.failRun(run, timedOutWaiting ? 'agent-not-found' : 'agent-departed');
      if (failure) expired.push(failure);
    }
    return expired;
  }

  claimShip(ship) {
    if (!ship || typeof ship.id !== 'string' || typeof ship.project !== 'string' ||
        !PROVIDERS.has(ship.provider) || !Number.isFinite(ship.lastEvent) ||
        !validGoalId(ship.taskId)) return null;
    const claimed = new Set(this.runs.map((entry) => entry.shipId).filter(Boolean));
    if (claimed.has(ship.id)) return null;
    const run = this.runs
      .filter((entry) => entry.phase === 'waiting-for-agent' &&
        entry.projectId === ship.project && entry.provider === ship.provider &&
        entry.id === ship.taskId.toLowerCase() &&
        !entry.baselineShipIds.includes(ship.id) &&
        ship.lastEvent >= entry.startedAt - CLAIM_CLOCK_SKEW_MS)
      .sort((a, b) => a.startedAt - b.startedAt)[0];
    if (!run) return null;
    this.persistTransition(run, {
      shipId: ship.id,
      phase: 'running',
      updatedAt: this.now(),
    });
    this.changed(run, 'claimed');
    return run;
  }

  complete(run, ship) {
    if (!run || run.phase !== 'running' || run.shipId !== ship.id) return null;
    const projectRoot = this.resolveProjectRoot(run.projectId);
    if (!projectRoot) return this.setCompletionFailure(run);
    this.persistTransition(run, {
      phase: 'completing',
      updatedAt: this.now(),
    });
    return this.finishCompletion(run, projectRoot);
  }

  setCompletionFailure(run) {
    if (!run || (!ACTIVE_PHASES.has(run.phase) && run.phase !== 'completing')) return null;
    this.persistTransition(run, {
      phase: 'completion-failed',
      updatedAt: this.now(),
    });
    this.changed(run, 'completion-failed');
    return publicRun(run);
  }

  failRun(run, phase) {
    if (!run || !ACTIVE_PHASES.has(run.phase) || !STORED_PHASES.has(phase)) return null;
    this.persistTransition(run, { phase, updatedAt: this.now() });
    this.changed(run, phase);
    return publicRun(run);
  }

  setTerminalFailure(id, phase, reason) {
    const run = typeof id === 'string' ? this.runs.find((entry) => entry.id === id.toLowerCase()) : null;
    if (!run || !ACTIVE_PHASES.has(run.phase)) return null;
    this.persistTransition(run, { phase, updatedAt: this.now() });
    this.changed(run, reason);
    return publicRun(run);
  }

  finishCompletion(run, projectRoot) {
    if (!run || run.phase !== 'completing') return null;
    try {
      completeAssignedGoal(projectRoot, { id: run.id, text: run.text });
    } catch {
      return this.setCompletionFailure(run);
    }
    const completedAt = this.now();
    this.persistTransition(run, {
      phase: 'ready-for-review',
      completedAt,
      updatedAt: completedAt,
    });
    this.changed(run, 'ready-for-review');
    return publicRun(run);
  }

  recoverCompletions(projectId = null) {
    const pending = this.runs.filter((run) => run.phase === 'completing' &&
      (projectId === null || run.projectId === projectId));
    const recovered = [];
    for (const run of pending) {
      const projectRoot = this.resolveProjectRoot(run.projectId);
      const result = projectRoot
        ? this.finishCompletion(run, projectRoot)
        : this.setCompletionFailure(run);
      if (result) recovered.push(result);
    }
    return recovered;
  }

  persistTransition(run, update) {
    const previous = { ...run, baselineShipIds: [...run.baselineShipIds] };
    Object.assign(run, update);
    try {
      this.persist();
    } catch (error) {
      for (const key of Object.keys(run)) delete run[key];
      Object.assign(run, previous);
      throw error;
    }
  }

  changed(run, reason) {
    try { this.onChange({ reason, run: publicRun(run) }); } catch { /* observers are best-effort */ }
  }

  prune() {
    if (this.runs.length <= MAX_RUNS) return;
    const ordered = [...this.runs].sort((a, b) => b.updatedAt - a.updatedAt);
    const active = ordered.filter((run) => LOCKING_PHASES.has(run.phase));
    if (active.length > MAX_RUNS) {
      const error = new Error('Task run limit reached');
      error.code = 'LIMIT_REACHED';
      throw error;
    }
    const terminal = ordered.filter((run) => !LOCKING_PHASES.has(run.phase));
    this.runs = [...active, ...terminal.slice(0, MAX_RUNS - active.length)]
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  load() {
    let parsed;
    try {
      const bytes = this.fs.readFileSync(this.statePath);
      if (bytes.length > MAX_STATE_BYTES) return [];
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      return [];
    }
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.runs)) return [];
    const ordered = parsed.runs.map(normalizeStored).filter(Boolean)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const active = ordered.filter((run) => LOCKING_PHASES.has(run.phase));
    const terminal = ordered.filter((run) => !LOCKING_PHASES.has(run.phase));
    return [...active, ...terminal.slice(0, Math.max(0, MAX_RUNS - active.length))]
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  persist() {
    const serialized = JSON.stringify({ version: 1, runs: this.runs });
    if (Buffer.byteLength(serialized, 'utf8') > MAX_STATE_BYTES) {
      const error = new Error('Task run storage limit reached');
      error.code = 'LIMIT_REACHED';
      throw error;
    }
    this.fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    writeFileAtomic(this.statePath, serialized, { fsImpl: this.fs });
  }
}

function normalizeStart(input, now) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !validGoalId(input.id) ||
      typeof input.projectId !== 'string' || input.projectId.length === 0 ||
      input.projectId.length > 256 || typeof input.text !== 'string' || input.text.length === 0 ||
      input.text.length > MAX_TEXT || /[\r\n\0]/.test(input.text) || !PROVIDERS.has(input.provider) ||
      !Array.isArray(input.baselineShipIds) || input.baselineShipIds.length > 1_000 ||
      input.baselineShipIds.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 256)) {
    throw new TypeError('Invalid task run');
  }
  return {
    id: input.id.toLowerCase(),
    projectId: input.projectId,
    text: input.text,
    provider: input.provider,
    phase: 'waiting-for-agent',
    shipId: null,
    baselineShipIds: [...new Set(input.baselineShipIds)],
    startedAt: now,
    updatedAt: now,
    completedAt: null,
  };
}

function normalizeStored(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !validGoalId(value.id) ||
      typeof value.projectId !== 'string' || value.projectId.length === 0 || value.projectId.length > 256 ||
      typeof value.text !== 'string' || value.text.length === 0 || value.text.length > MAX_TEXT ||
      !PROVIDERS.has(value.provider) || !STORED_PHASES.has(value.phase) ||
      !Number.isFinite(value.startedAt) || !Number.isFinite(value.updatedAt) ||
      !Array.isArray(value.baselineShipIds)) return null;
  const shipId = typeof value.shipId === 'string' && value.shipId.length <= 256 ? value.shipId : null;
  const baselineShipIds = value.baselineShipIds
    .filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 256).slice(0, 1_000);
  return {
    id: value.id.toLowerCase(), projectId: value.projectId, text: value.text,
    provider: value.provider, phase: value.phase, shipId,
    baselineShipIds: [...new Set(baselineShipIds)], startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    completedAt: Number.isFinite(value.completedAt) ? value.completedAt : null,
  };
}

function publicRun(run) {
  return {
    id: run.id,
    projectId: run.projectId,
    provider: run.provider,
    phase: run.phase,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
  };
}

module.exports = { TaskRunTracker };

// @ts-check
'use strict';

const path = require('node:path');
const { ensureAssignedGoal, removeAssignedGoal, validGoalId } = require('./goals');
const { validProjectId } = require('./shared/ids');

/** @import { RootTaskItem, Ship } from '../types/contract' */
/** @import { createAgentLauncher } from './agent-launcher' */
/** @typedef {InstanceType<typeof import('./root-tasks').RootTaskStore>} RootTaskStore */
/** @typedef {InstanceType<typeof import('./task-runs').TaskRunTracker>} TaskRunTracker */

const ACTIVE_RUN_PHASES = new Set(['waiting-for-agent', 'running', 'completing']);
const RETRYABLE_RUN_PHASES = new Set([
  'reopened',
  'launch-failed',
  'agent-aborted',
  'agent-departed',
  'agent-not-found',
]);
const RETRYABLE_ROOT_PHASES = new Set([
  'prepared',
  'goal-written',
  'launch-failed',
  'launch-requested',
  'reopened',
  'agent-aborted',
  'agent-departed',
  'agent-not-found',
]);
const EXPOSED_RUN_PHASES = new Set([
  ...ACTIVE_RUN_PHASES,
  'ready-for-review',
  'launch-failed',
  'completion-failed',
  'reopened',
  'agent-aborted',
  'agent-departed',
  'agent-not-found',
]);
const PUBLIC_FAILURE_CODES = new Set([
  'INVALID',
  'NOT_FOUND',
  'LIMIT_REACHED',
  'PROJECT_IMMUTABLE',
  'INVALID_TRANSITION',
  'PROJECT_NOT_FOUND',
  'PROJECT_BUSY',
  'BUSY',
  'WRITE_FAILED',
  'UNAVAILABLE',
  'LAUNCH_FAILED',
  'FAILED',
]);

/**
 * @typedef {object} RootTaskCoordinatorOptions
 * @property {RootTaskStore} [store]
 * @property {TaskRunTracker} [taskRuns]
 * @property {ReturnType<typeof createAgentLauncher>} [launcher]
 * @property {(projectId: string) => string | null} [resolveProjectRoot]
 * @property {(projectId: string) => Pick<Ship, 'id' | 'provider' | 'project' | 'kind'>[]} [listShips]
 * @property {typeof ensureAssignedGoal} [ensureGoal]
 * @property {typeof removeAssignedGoal} [removeGoal]
 * @property {(change: { reason: string, item: RootTaskItem | null }) => void} [onChange]
 */

class RootTaskCoordinator {
  /** @param {RootTaskCoordinatorOptions} [options] */
  constructor(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options) ||
        !validStore(options.store) || !validTaskRuns(options.taskRuns) ||
        !options.launcher || typeof options.launcher.launch !== 'function' ||
        typeof options.resolveProjectRoot !== 'function' ||
        typeof options.listShips !== 'function' ||
        (options.ensureGoal != null && typeof options.ensureGoal !== 'function') ||
        (options.removeGoal != null && typeof options.removeGoal !== 'function') ||
        (options.onChange != null && typeof options.onChange !== 'function')) {
      throw new TypeError('RootTaskCoordinator requires its task workflow dependencies');
    }
    this.store = options.store;
    this.taskRuns = options.taskRuns;
    this.launcher = options.launcher;
    this.resolveProjectRoot = options.resolveProjectRoot;
    this.listShips = options.listShips;
    this.ensureGoal = options.ensureGoal || ensureAssignedGoal;
    this.removeGoal = options.removeGoal || removeAssignedGoal;
    this.onChange = options.onChange || (() => {});
    this.taskLocks = new Set();
    this.projectLocks = new Set();
  }

  snapshot() {
    return { items: this.store.list().map((item) => this.overlay(item)) };
  }

  create(text) {
    try {
      const item = this.store.create(text);
      this.changed(item.id, 'created');
      return success(this.overlay(item));
    } catch (error) {
      return failure(storeFailureCode(error, 'INVALID'));
    }
  }

  remove(id) {
    if (!validGoalId(id)) return failure('INVALID');
    const canonicalId = id.toLowerCase();
    if (this.taskLocks.has(canonicalId)) return failure('BUSY');
    const run = this.taskRuns.get(canonicalId);
    if (run && ACTIVE_RUN_PHASES.has(run.phase)) return failure('BUSY');
    let item;
    try {
      item = this.store.remove(canonicalId);
    } catch (error) {
      return failure(storeFailureCode(error));
    }
    // The tagged GOALS.md line goes with it when the project is reachable; the queue entry is
    // gone either way.
    if (item.projectId) {
      try {
        const cwd = this.resolveProjectRoot(item.projectId);
        if (typeof cwd === 'string' && path.isAbsolute(cwd)) this.removeGoal(cwd, { id: item.id, text: item.text });
      } catch { /* the file changed or is unreachable */ }
    }
    this.changed(canonicalId, 'removed', item);
    return success(item);
  }

  observeRun(run) {
    if (!run || typeof run !== 'object' || Array.isArray(run) || !validGoalId(run.id) ||
        !validProjectId(run.projectId) || !EXPOSED_RUN_PHASES.has(run.phase)) {
      return failure('INVALID');
    }
    const id = run.id.toLowerCase();
    const item = this.store.get(id);
    if (!item) return failure('NOT_FOUND');
    if (item.projectId !== run.projectId) return failure('PROJECT_IMMUTABLE');

    if (ACTIVE_RUN_PHASES.has(run.phase)) {
      this.changed(id, run.phase);
      return success(this.overlay(item));
    }
    try {
      const persisted = this.store.markRunPhase(id, run.projectId, run.phase);
      this.changed(id, run.phase);
      return success(this.overlay(persisted));
    } catch (error) {
      return failure(storeFailureCode(error));
    }
  }

  async assign(id, projectId) {
    if (!validGoalId(id) || !validProjectId(projectId)) return failure('INVALID');
    const canonicalId = id.toLowerCase();
    const item = this.store.get(canonicalId);
    if (!item) return failure('NOT_FOUND');
    if (item.phase !== 'idea') {
      if (item.projectId && item.projectId !== projectId) return failure('PROJECT_IMMUTABLE');
      return failure('INVALID_TRANSITION');
    }
    return this.run(canonicalId, projectId, false);
  }

  async retry(id) {
    if (!validGoalId(id)) return failure('INVALID');
    const canonicalId = id.toLowerCase();
    const item = this.store.get(canonicalId);
    if (!item) return failure('NOT_FOUND');
    if (!RETRYABLE_ROOT_PHASES.has(item.phase) || !validProjectId(item.projectId)) {
      return failure('INVALID_TRANSITION');
    }
    return this.run(canonicalId, item.projectId, true);
  }

  overlay(item) {
    if (!item || !validGoalId(item.id)) return item;
    const run = this.taskRuns.get(item.id);
    if (!run || run.projectId !== item.projectId || !EXPOSED_RUN_PHASES.has(run.phase)) {
      return { ...item };
    }
    let phase = run.phase;
    if (ACTIVE_RUN_PHASES.has(phase)) {
      // The root launch intent is the durable proof that an external process
      // may exist. A waiting run paired with goal-written is the safe,
      // pre-launch crash window and must remain retryable in the UI.
      phase = item.phase === 'launch-requested' ? 'agent-working' : item.phase;
    }
    return { ...item, phase };
  }

  async run(id, projectId, retry) {
    if (this.taskLocks.has(id)) return failure('BUSY');
    if (this.projectLocks.has(projectId)) return failure('PROJECT_BUSY');
    this.taskLocks.add(id);
    this.projectLocks.add(projectId);
    try {
      const current = this.store.get(id);
      if (!current) return failure('NOT_FOUND');
      if (current.projectId && current.projectId !== projectId) {
        return failure('PROJECT_IMMUTABLE');
      }
      const existingRun = this.taskRuns.get(id);
      if (retry) {
        const retryGate = retryAllowed(current, existingRun);
        if (retryGate) return failure(retryGate);
      } else if (current.phase !== 'idea') {
        return failure('INVALID_TRANSITION');
      }

      const resumeWaitingRun = retry && isResumableWaitingRun(current, existingRun);
      const active = this.taskRuns.activeForProject(projectId);
      if (active && !(resumeWaitingRun && active.id === id)) {
        return failure(active.id === id ? 'BUSY' : 'PROJECT_BUSY');
      }

      let cwd;
      try {
        cwd = this.resolveProjectRoot(projectId);
      } catch {
        return failure('PROJECT_NOT_FOUND');
      }
      if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
        return failure('PROJECT_NOT_FOUND');
      }

      let assigned;
      try {
        assigned = retry ? this.prepareRetry(current) : this.store.prepare(id, projectId);
      } catch (error) {
        return failure(storeFailureCode(error));
      }
      this.changed(id, retry ? 'retry-prepared' : 'prepared');

      try {
        this.ensureGoal(cwd, { id: assigned.id, text: assigned.text });
      } catch {
        return failure('WRITE_FAILED');
      }

      try {
        assigned = this.store.markGoalWritten(id);
      } catch (error) {
        return failure(storeFailureCode(error));
      }
      this.changed(id, 'goal-written');

      if (!resumeWaitingRun) {
        let baselineShipIds;
        try {
          baselineShipIds = collectBaselineCodexShipIds(this.listShips(projectId), projectId);
        } catch {
          return failure('FAILED');
        }

        try {
          this.taskRuns.start({
            id,
            projectId,
            text: assigned.text,
            provider: 'codex',
            baselineShipIds,
          });
        } catch (error) {
          if (error && error.code === 'PROJECT_BUSY') return failure('PROJECT_BUSY');
          if (error && error.code === 'LIMIT_REACHED') return failure('LIMIT_REACHED');
          if (error && error.code === 'TASK_BUSY') return failure('BUSY');
          return failure('FAILED');
        }
      }

      // Persist the launch intent before creating the external process. A crash
      // in between leaves a recoverable waiting run instead of an untracked agent.
      try {
        assigned = this.store.markLaunchRequested(id);
      } catch {
        try { this.taskRuns.failLaunch(id); } catch { /* best-effort recovery */ }
        this.changed(id, 'launch-state-failed');
        return failure('FAILED');
      }
      this.changed(id, 'launch-requested');

      let launchResult;
      try {
        // Task text intentionally stays in GOALS.md. The child receives only the
        // repository root and opaque task marker used for exact correlation.
        launchResult = await this.launcher.launch({ cwd, taskId: id });
      } catch {
        launchResult = { ok: false, code: 'FAILED' };
      }
      if (!launchResult || launchResult.ok !== true) {
        const stateSaved = this.markLaunchFailure(id);
        this.changed(id, 'launch-failed');
        if (!stateSaved) return failure('FAILED');
        return failure(launchResult && launchResult.code === 'UNAVAILABLE'
          ? 'UNAVAILABLE'
          : 'LAUNCH_FAILED');
      }

      return success(this.overlay(assigned));
    } catch {
      return failure('FAILED');
    } finally {
      this.projectLocks.delete(projectId);
      this.taskLocks.delete(id);
    }
  }

  prepareRetry(item) {
    if (item.phase === 'prepared' || item.phase === 'goal-written') return item;
    return this.store.prepareRetry(item.id);
  }

  markLaunchFailure(id) {
    let saved = true;
    try {
      if (!this.taskRuns.failLaunch(id)) saved = false;
    } catch {
      saved = false;
    }
    try {
      this.store.prepareRetry(id);
      this.store.markLaunchFailed(id);
    } catch {
      saved = false;
    }
    return saved;
  }

  changed(id, reason, fallbackItem = null) {
    try {
      const item = this.store.get(id);
      this.onChange({ reason, item: item ? this.overlay(item) : fallbackItem });
    } catch {
      // Observers are best-effort and cannot affect persisted task state.
    }
  }
}

function retryAllowed(item, run) {
  if (!RETRYABLE_ROOT_PHASES.has(item.phase)) return 'INVALID_TRANSITION';
  if (!run) return item.phase === 'launch-requested' ? 'BUSY' : null;
  if (run.projectId !== item.projectId) return 'INVALID_TRANSITION';
  if (ACTIVE_RUN_PHASES.has(run.phase)) {
    return isResumableWaitingRun(item, run) ? null : 'BUSY';
  }
  return RETRYABLE_RUN_PHASES.has(run.phase) ? null : 'INVALID_TRANSITION';
}

function isResumableWaitingRun(item, run) {
  return item && item.phase === 'goal-written' && run && run.phase === 'waiting-for-agent' &&
    run.projectId === item.projectId;
}

function collectBaselineCodexShipIds(value, projectId) {
  if (!Array.isArray(value)) throw new TypeError('Ship list must be an array');
  const ids = [];
  const seen = new Set();
  for (const ship of value) {
    if (!ship || typeof ship !== 'object' || ship.provider !== 'codex' ||
        ship.project !== projectId || ship.kind === 'drone' ||
        typeof ship.id !== 'string' || ship.id.length === 0 || ship.id.length > 256 ||
        seen.has(ship.id)) continue;
    seen.add(ship.id);
    ids.push(ship.id);
    if (ids.length === 1_000) break;
  }
  return ids;
}

function validStore(value) {
  return Boolean(value) && ['list', 'get', 'create', 'remove', 'prepare', 'markGoalWritten',
    'markLaunchRequested', 'markLaunchFailed', 'markRunPhase', 'prepareRetry']
    .every((method) => typeof value[method] === 'function');
}

function validTaskRuns(value) {
  return Boolean(value) && ['get', 'activeForProject', 'start', 'failLaunch']
    .every((method) => typeof value[method] === 'function');
}

function storeFailureCode(error, fallback = 'FAILED') {
  const code = error && typeof error.code === 'string' ? error.code : fallback;
  return PUBLIC_FAILURE_CODES.has(code) ? code : fallback;
}

function success(item) {
  return { ok: true, item };
}

function failure(code) {
  return { ok: false, code: PUBLIC_FAILURE_CODES.has(code) ? code : 'FAILED' };
}

module.exports = {
  RootTaskCoordinator,
};

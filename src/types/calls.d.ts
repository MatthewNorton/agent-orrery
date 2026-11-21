// What the `window.AU` bridge's calls that act take and answer: results, replay commands,
// GOALS.md tasks, the IDEAS queue, moved-project recovery and the universe backup.
// contract.d.ts exports these again, so importers name one file.

import type { PlaybackStatus, Project, ReplaySpeed, Snapshot } from './contract';

// ---- results ----

/**
 * A failure carries only `code`; a success carries the other fields. Flat rather than a
 * discriminated union because, without strictNullChecks, the renderer's
 * `result && result.code` reads would not narrow.
 */
export interface Outcome<Code extends string> {
  ok: boolean;
  code?: Code;
}

export interface Failure<Code extends string> extends Outcome<Code> {
  ok: false;
  code: Code;
}

export type OpenExternalResult = Outcome<'INVALID_URL' | 'OPEN_FAILED'>;

export type TerminalFailureCode = 'INVALID' | 'REPLAY' | 'NOT_FOUND' | 'UNAVAILABLE' | 'BUSY' | 'FAILED'
  | 'TERMINAL_NOT_FOUND' | 'TERMINAL_BLOCKED' | 'AMBIGUOUS';
export type OpenTerminalResult = Outcome<TerminalFailureCode>;

export type ReplayCommand =
  | { action: 'index' | 'play' | 'pause' | 'live' }
  | { action: 'seek'; ts: number }
  | { action: 'speed'; speed: ReplaySpeed };

export interface ReplayResult {
  playback: PlaybackStatus;
  streamEpoch: number;
  /** Present after `seek` and `live`. */
  snapshot?: Snapshot;
}

export interface ReplayStatePush extends PlaybackStatus {
  streamEpoch: number;
}

// ---- GOALS.md tasks ----

export interface GoalItem {
  text: string;
  done: boolean;
  /** Zero-based source line in GOALS.md. */
  line: number;
  /** Lower-case UUID marker on goals assigned from the IDEAS queue. */
  id?: string;
  agentStatus?: 'ready-for-review' | 'agent-working';
}

export interface TasksSnapshot {
  exists: boolean;
  path: string;
  items: GoalItem[];
}

export interface TaskMutationResult {
  ok: boolean;
  items: GoalItem[];
}

export interface TaskSetDoneRequest {
  text: string;
  done: boolean;
  id?: string;
  line?: number;
}

export interface TaskRemoveRequest {
  line: number;
  text: string;
}

export type TaskRunPhase =
  | 'waiting-for-agent' | 'running' | 'completing' | 'ready-for-review' | 'launch-failed'
  | 'completion-failed' | 'reopened' | 'agent-aborted' | 'agent-departed' | 'agent-not-found';

export interface TasksChangedPush {
  projectId: string;
  taskId: string;
  phase: TaskRunPhase;
}

// ---- IDEAS queue ----

export type RootTaskPhase =
  | 'idea' | 'prepared' | 'goal-written' | 'launch-requested' | 'launch-failed'
  | 'ready-for-review' | 'completion-failed' | 'reopened'
  | 'agent-aborted' | 'agent-departed' | 'agent-not-found'
  /** Overlaid while a launched run is active. */
  | 'agent-working';

export interface RootTaskItem {
  id: string;
  text: string;
  projectId: string | null;
  phase: RootTaskPhase;
  createdAt: number;
  updatedAt: number;
}

export interface RootTasksSnapshot {
  items: RootTaskItem[];
}

export type RootTaskFailureCode =
  | 'INVALID' | 'REPLAY' | 'NOT_FOUND' | 'LIMIT_REACHED' | 'PROJECT_IMMUTABLE'
  | 'INVALID_TRANSITION' | 'PROJECT_NOT_FOUND' | 'PROJECT_BUSY' | 'BUSY'
  | 'WRITE_FAILED' | 'UNAVAILABLE' | 'LAUNCH_FAILED' | 'FAILED';

export interface RootTaskResult extends Outcome<RootTaskFailureCode> {
  item?: RootTaskItem;
}

export interface RootTasksChangedPush {
  taskId: string;
  /** Null once the idea is removed. */
  phase: RootTaskPhase | TaskRunPhase | null;
}

// ---- moved-project recovery ----

export type ProjectPathFailureCode =
  | 'INVALID' | 'REPLAY' | 'BUSY' | 'NOT_FOUND' | 'NOT_MISSING' | 'IN_USE' | 'EXPIRED'
  /** Forget only: an agent is working in the project. */
  | 'ACTIVE'
  | 'FAILED';

export interface ProjectPathCandidate {
  /** One-time token for `projectPathApply`. */
  token: string;
  path: string;
}

export interface ProjectPathMatch {
  projectId: string;
  candidates: ProjectPathCandidate[];
}

export interface ProjectPathsScanResult extends Outcome<ProjectPathFailureCode> {
  /** True when the folder dialog was dismissed; nothing else is set then. */
  canceled?: boolean;
  /** Absent when no project is missing. */
  scanId?: string;
  root?: string | null;
  directoriesVisited?: number;
  truncated?: boolean;
  matches?: ProjectPathMatch[];
}

export interface ProjectPathRecoveryResult extends Outcome<ProjectPathFailureCode> {
  /** Locate only: the folder dialog was dismissed. */
  canceled?: boolean;
  project?: Project;
}

/**
 * A forgotten project leaves the stream: success starts a new LIVE epoch and carries its
 * snapshot, as `replay({ action: 'live' })` does.
 */
export interface ProjectForgetResult extends Outcome<ProjectPathFailureCode>, Partial<ReplayResult> {
  /** The confirmation was dismissed; nothing changed. */
  canceled?: boolean;
}

// ---- universe backup ----

export type BackupFailureCode = 'INVALID' | 'REPLAY' | 'BUSY' | 'FAILED';

export interface UniverseExportResult extends Outcome<BackupFailureCode> {
  canceled?: boolean;
  path?: string;
  projects?: number;
  ideas?: number;
}

/** Import merges and never removes; new projects arrive as `project-added` events. */
export interface UniverseImportResult extends Outcome<BackupFailureCode> {
  canceled?: boolean;
  added?: number;
  merged?: number;
  ideas?: number;
}

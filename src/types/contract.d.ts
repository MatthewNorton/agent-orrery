// Shapes that cross the `window.AU` bridge; kit/SPEC.md §3 is the prose version.

export type Provider = 'claude' | 'codex' | 'generic';
export type ShipKind = 'main' | 'drone';
export type ShipStatus =
  | 'Building' | 'Exploring' | 'Gathering Resources' | 'Scanning'
  | 'Delegating' | 'Planning' | 'Working';
export type Attention = 'question' | 'permission' | 'stalled' | 'done';
export type FeedKind = 'discover' | 'form' | 'build' | 'info' | 'spawn' | 'depart' | 'attention' | 'done';
export type StreamMode = 'live' | 'replay';
export type ReplaySpeed = 1 | 10 | 100 | 1000;
export type DebugView = 'universe' | 'system' | 'planet';

export interface Galaxy {
  key: string;
  label: string;
}

export interface Project {
  id: string;
  path: string | null;
  name: string;
  exists: boolean;
  firstSeen: number;
  lastActivity: number;
  totalBytes: number;
  totalBuilds: number;
  seed: number;
  galaxy: Galaxy;
  /** LIVE snapshot and system only. */
  vcs?: ProjectVcsStatus | null;
  /** Replay only: build counts per planet. */
  buckets?: Record<string, number>;
  /** LIVE: the top-level folders with builds, the system's planets, for Go to. */
  planets?: string[];
}

export interface Ship {
  id: string;
  name: string;
  provider: Provider;
  project: string;
  kind: ShipKind;
  status: ShipStatus;
  detail: string | null;
  lastEvent: number;
  attention: Attention | null;
  attentionSince: number | null;
  /** Build events attributed to this ship since its source first observed it; picks its hull rank. */
  builds: number;
  /** The session runs a local model (a Codex local model_provider, or a non-Claude model in Claude Code); tints the ship red. */
  local: boolean;
  /** The model the session reports (Claude message.model; Codex session_meta and turn_context model), for any provider; null until known. */
  model: string | null;
  /** LIVE only. */
  taskId?: string | null;
  /** LIVE only. */
  turnOutcome?: string | null;
}

export interface FeedEntry {
  kind: FeedKind;
  text: string;
  project: string;
  ts: number;
}

export interface Planet {
  name: string;
  files: number;
  builds: number;
  procedural?: boolean;
}

export interface SystemData {
  project: Project;
  planets: Planet[];
  beltDensity: number;
}

export interface PlanetData {
  name: string;
  project: Project;
  builds: number;
  files: number;
  sizeKb: number;
  subdirs: number;
  /** Top file extensions, upper case. */
  resources: string[];
  procedural?: boolean;
}

/** Bounded by main (replay-control.js): unknown times are null; in LIVE, playing is false and cursorTs is maxTs once known. */
export interface PlaybackStatus {
  mode: StreamMode;
  available: boolean;
  indexing: boolean;
  minTs: number | null;
  maxTs: number | null;
  cursorTs: number | null;
  playing: boolean;
  speed: ReplaySpeed;
  sourceCount: number;
  truncated: boolean;
}

/** Builds per half hour of one local day: `day` is its midnight, `bins` has 48 entries. */
export interface BuildHistogram {
  day: number;
  bins: number[];
}

export interface Snapshot {
  projects: Project[];
  ships: Ship[];
  feed: FeedEntry[];
  eventSequence: number;
  streamEpoch: number;
  playback: PlaybackStatus;
  /** LIVE only; replay snapshots carry none. */
  buildHistogram?: BuildHistogram;
}

// ---- events ----

export interface BatchMeta {
  streamEpoch: number;
  mode: StreamMode;
}

interface Sequenced {
  /** Monotonic within one source stream; see kit/SPEC.md §3. */
  seq: number;
}

export interface ProjectAddedEvent extends Sequenced {
  type: 'project-added';
  project: Project;
}

export interface ProjectUpdatedEvent extends Sequenced {
  type: 'project-updated';
  project: Project;
}

export interface ShipSpawnedEvent extends Sequenced {
  type: 'ship-spawned';
  ship: Ship;
}

export interface ShipUpdatedEvent extends Sequenced {
  type: 'ship-updated';
  ship: Ship;
}

export interface ShipDepartedEvent extends Sequenced {
  type: 'ship-departed';
  shipId: string;
  ts: number;
}

export interface ActivityEvent extends Sequenced {
  type: 'activity';
  /** Project id. */
  project: string;
  shipId: string;
  tool: string;
  status: ShipStatus;
  detail: string | null;
  ts: number;
}

export interface BuildEvent extends Sequenced {
  type: 'build';
  /** Project id. */
  project: string;
  /** Planet name. */
  bucket: string;
  file: string;
  shipId: string;
  /** True when this build forms a new planet. */
  isNew: boolean;
  ts: number;
}

export interface FeedEvent extends Sequenced {
  type: 'feed';
  entry: FeedEntry;
}

/** What `AU.onEvents` delivers. */
export type AUEvent =
  | ProjectAddedEvent | ProjectUpdatedEvent
  | ShipSpawnedEvent | ShipUpdatedEvent | ShipDepartedEvent
  | ActivityEvent | BuildEvent | FeedEvent;

/** Synthesized by the renderer when a git status push arrives; never sent by main. */
export interface ProjectVcsStatusEvent {
  type: 'project-vcs-status';
  projectId: string;
  status: ProjectVcsStatus;
}

/** What a view's `update(batch)` receives. */
export type ViewEvent = AUEvent | ProjectVcsStatusEvent;

// ---- git / GitHub status ----

export interface GitStatus {
  state: 'ready';
  branch: string | null;
  detached: boolean;
  dirty: boolean;
  changedFiles: number;
}

export interface GithubStatus {
  owner: string;
  repository: string;
  nameWithOwner: string;
  url: string;
  remoteName: string;
  state: 'unknown' | 'ready' | 'stale' | 'error';
  openPullRequests?: number | null;
  stale?: boolean;
  checkedAt?: number | null;
  errorCode?: string | null;
}

export interface ProjectVcsStatus {
  projectId: string;
  projectPath: string | null;
  checkedAt: number;
  state: 'ready' | 'unavailable';
  git: GitStatus | null;
  github: GithubStatus | null;
  errorCode: string | null;
}

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

export type TerminalFailureCode = 'INVALID' | 'REPLAY' | 'NOT_FOUND' | 'UNAVAILABLE' | 'BUSY' | 'FAILED';
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
  | 'INVALID' | 'REPLAY' | 'BUSY' | 'NOT_FOUND' | 'NOT_MISSING' | 'IN_USE' | 'EXPIRED' | 'FAILED';

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

// ---- the bridge ----

/**
 * `window.AU`, exposed by src/preload.js. Invokes resolve `null` (or a failure) when the
 * caller is not the trusted main frame; the `on*` subscriptions cannot be removed.
 */
export interface AUBridge {
  snapshot(): Promise<Snapshot | null>;
  getSystem(projectId: string): Promise<SystemData | null>;
  getPlanet(projectId: string, name: string): Promise<PlanetData | null>;
  /** Resolves `shell.openPath`'s error text: '' on success or when nothing opened. */
  openProject(projectId: string): Promise<string>;
  /** Only `https://github.com/<owner>/<repo>` URLs open. */
  openExternal(url: string): Promise<OpenExternalResult>;
  openTerminal(projectId: string): Promise<OpenTerminalResult>;

  tasksGet(projectId: string): Promise<TasksSnapshot | null>;
  taskAdd(projectId: string, text: string): Promise<TaskMutationResult>;
  taskSetDone(projectId: string, request: TaskSetDoneRequest): Promise<TaskMutationResult>;
  taskRemove(projectId: string, request: TaskRemoveRequest): Promise<TaskMutationResult>;
  onTasksChanged(cb: (update: TasksChangedPush) => void): void;

  rootTasksGet(): Promise<RootTasksSnapshot>;
  rootTaskCreate(text: string): Promise<RootTaskResult>;
  rootTaskRemove(taskId: string): Promise<RootTaskResult>;
  rootTaskAssign(taskId: string, projectId: string): Promise<RootTaskResult>;
  rootTaskRetry(taskId: string): Promise<RootTaskResult>;
  onRootTasksChanged(cb: (update: RootTasksChangedPush) => void): void;

  projectPathsScan(): Promise<ProjectPathsScanResult>;
  projectPathLocate(projectId: string): Promise<ProjectPathRecoveryResult>;
  projectPathApply(projectId: string, token: string): Promise<ProjectPathRecoveryResult>;
  /** LIVE only. */
  onProjectVcsStatusChanged(cb: (status: ProjectVcsStatus, meta: BatchMeta) => void): void;

  /** Rejects on an invalid command or when the action needs the other mode. */
  replay(command: ReplayCommand): Promise<ReplayResult | null>;
  onEvents(cb: (batch: AUEvent[], meta: BatchMeta) => void): void;
  onReplayState(cb: (playback: ReplayStatePush) => void): void;
  /** Test modes only. */
  onDebugView(cb: (view: DebugView) => void): void;
  /** Call once the requested debug view has rendered a frame. */
  debugReady(): void;
}

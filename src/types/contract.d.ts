// Shapes that cross the `window.AU` bridge; kit/SPEC.md §3 is the prose version. What its calls
// that act take and answer (results, tasks, the IDEAS queue, recovery, backup) is in calls.d.ts.

import type {
  OpenExternalResult, OpenTerminalResult, ProjectForgetResult, ProjectPathRecoveryResult,
  ProjectPathsScanResult, ReplayCommand, ReplayResult, ReplayStatePush, RootTaskResult,
  RootTasksChangedPush, RootTasksSnapshot, TaskMutationResult, TaskRemoveRequest,
  TaskSetDoneRequest, TasksChangedPush, TasksSnapshot, UniverseExportResult, UniverseImportResult,
} from './calls';

export type * from './calls';

export type Provider = 'claude' | 'codex' | 'generic' | 'local';
export type ShipKind = 'main' | 'drone';
export type ShipStatus =
  | 'Building' | 'Exploring' | 'Gathering Resources' | 'Scanning'
  | 'Delegating' | 'Planning' | 'Working';
export type Attention = 'question' | 'permission' | 'stalled' | 'done';
export type FeedKind = 'discover' | 'form' | 'build' | 'info' | 'spawn' | 'depart' | 'attention' | 'done' | 'warning';
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
  /** The session runs a local model (a Codex local model_provider, a non-Claude model in Claude Code, or any ship of the `local` provider); tints the ship red. */
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

/**
 * What main compares a planet by (build-buckets.js planetKey): the same for a folder, its bucket
 * and every build the bucket holds, in whatever casing each was written. A build no bucket holds
 * (a name a bucket cannot have, or a project at the 10,000 cap) carries null and is on no planet,
 * not even the one its folder names. Match on it with `===`; it is not a name to show.
 */
export type PlanetKey = string;

export interface Planet {
  name: string;
  key: PlanetKey;
  files: number;
  builds: number;
  procedural?: boolean;
}

export interface SystemData {
  project: Project;
  /** The planets the system view draws: the biggest, at most 8 (universe/planets.js). */
  planets: Planet[];
  beltDensity: number;
  /** How many planets the project has, when that is more than `planets` holds. */
  planetTotal?: number;
}

export interface PlanetData {
  /**
   * The planet's name as the system view draws it, which seeds its globe: live, the folder's name
   * as the disk spells it; in history, its bucket's key. Under a Windows path it can differ in
   * case from the name asked for.
   */
  name: string;
  key: PlanetKey;
  project: Project;
  builds: number;
  files: number;
  sizeKb: number;
  subdirs: number;
  /** Top file extensions, upper case. */
  resources: string[];
  /**
   * A stand-in whose folder numbers are invented. Live: the project has no folder on disk, or the
   * planet is a stand-in of a project without folders. History: no builds at the cursor.
   */
  procedural?: boolean;
  /**
   * Live only, how far main read the folder (live/system-view.js): 'partial' when a read limit left
   * a folder holding a file unread, or a folder below it or a file's size could not be read, so files
   * and size are floors; 'gone' when the folder itself is not there; 'none' when it is there and
   * could not be read (locked, or a passing error). Absent when there was no folder to read: a
   * procedural planet's numbers are invented, and history never reads the disk.
   */
  folderRead?: 'full' | 'partial' | 'none' | 'gone';
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
  /** LIVE only: provider problems this run, such as a transcript format this version does not recognise or a providers.json error. */
  warnings?: string[];
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
  /**
   * The edit's top-level folder as the edit wrote it, or '(root)': a name to show. Under a Windows
   * path it can differ in case from its planet's name, so the planet is found by `key`.
   */
  bucket: string;
  /** The key of the planet this build is in; null when no bucket holds it (isBucketName, the cap). */
  key: PlanetKey | null;
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
  /** LIVE project ID or exact live ship ID; main resolves the session and its terminal. */
  openTerminal(targetId: string): Promise<OpenTerminalResult>;

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
  /** LIVE only; main asks the user to confirm. */
  projectForget(projectId: string): Promise<ProjectForgetResult>;
  universeExport(): Promise<UniverseExportResult>;
  /** LIVE only. */
  universeImport(): Promise<UniverseImportResult>;
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

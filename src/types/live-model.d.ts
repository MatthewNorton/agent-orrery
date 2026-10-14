// The live Tracker's own records (src/main/tracker.js, src/main/live/); contract.d.ts has the
// public shapes.

import type { AUEvent, Attention, FeedEntry, SystemData } from './contract';

export interface LiveProject {
  id: string;
  path: string | null;
  name: string;
  exists: boolean;
  lastActivity: number;
  totalBytes: number;
  claudeBytes?: number;
  codexBytes?: number;
  /** Build count per top-level folder; '(root)' counts files at the top level. */
  buckets: Record<string, number>;
  totalBuilds: number;
  firstSeen: number;
}

export interface LiveShip {
  id: string;
  name: string;
  provider: string;
  /** Project id. */
  project: string;
  kind: 'main' | 'drone';
  parentName?: string | null;
  status: string;
  detail: string | null;
  lastEvent: number;
  /** Open tool calls by call id. */
  pending: Map<any, { tool: any; ts: number }>;
  turnDone: boolean;
  attention: Attention | null;
  attentionSince: number | null;
  /** Build events attributed to this ship, counted during catch-up too. */
  builds: number;
  /** Learned from the transcript (Codex session_meta.model_provider, Claude message.model). */
  local: boolean;
  /** The model name the transcript last reported; null until known. */
  model: string | null;
  taskId?: string;
  turnOutcome?: string;
}

/** One project as universe-state.json keeps it; files before version 2 lack path, name and lastActivity. */
export interface PersistedProject {
  path?: string | null;
  name?: string;
  lastActivity?: number;
  buckets?: Record<string, number>;
  totalBuilds?: number;
  firstSeen?: number;
}

/** universe-state.json as an earlier run left it. */
export interface PersistedState {
  version?: number;
  projects: Record<string, PersistedProject>;
  pathIds?: Record<string, string>;
  pathOverrides?: Record<string, string>;
}

/**
 * Where a transcript is being read. Claude tails keep a string remainder, provider tails a
 * Buffer plus their adapter state.
 */
export interface LiveTail {
  provider: string;
  /** Project id. */
  project: string;
  session: string;
  offset: number;
  /** Reading a file found mid-run from zero: count builds, announce nothing. */
  catchup: boolean;
  remainder: any;
  discardOversized?: boolean;
  path?: string;
  adapterState?: any;
  kind?: 'main' | 'drone';
  parentSessionId?: string | null;
  local?: boolean;
  model?: string | null;
  seenSignals?: Set<string>;
  missingScans?: number;
}

export interface LiveModelOptions {
  claudeProjectsDir?: string;
  codexSessionsDir?: string;
  codexSessionDir?: string;
  codexSessionDirs?: string[];
  providerConfigPath?: string;
}

/** Everything the live modules share; src/main/live/model.js creates it. */
export interface LiveModel {
  statePath: string;
  claudeProjectsDir: string;
  codexSessionDirs: string[];
  providerConfigPath: string;
  /** Project id -> project record. */
  projects: Map<string, LiveProject>;
  /** Ship id -> ship record. */
  ships: Map<string, LiveShip>;
  /** Absolute transcript path -> tail, for every file polled. */
  files: Map<string, LiveTail>;
  /** Absolute Claude transcript path -> its tail, kept while the file is cold. */
  claudeTails: Map<string, LiveTail>;
  persisted: PersistedState;
  /** Canonical project path -> project id, saved across runs. */
  pathIds: Record<string, string>;
  /** Project id -> a path the user recovered by hand, saved across runs. */
  pathOverrides: Record<string, string>;
  projectPathIndex: Map<string, string>;
  codexTailsBySession: Map<string, LiveTail>;
  codexMetaCache: Map<string, { size: number; mtimeMs: number; meta: any }>;
  signalFiles: Map<string, { size: number; mtimeMs: number; sessionId: string }>;
  providerWarnings: Set<string>;
  /** Names Claude ships and drones: Claude-1, Claude-2, ... */
  shipCounter: number;
  /** Names provider ships per provider: Codex-1, Signal-1, ... */
  providerCounters: Map<string, number>;
  systemCache: Map<string, { at: number; data: SystemData }>;
  /** Open tool call id -> id of the ship that issued it. */
  pendingIndex: Map<any, string>;
  /** Events queued since the last flush. */
  pending: AUEvent[];
  feed: FeedEntry[];
  /** Builds per half hour of the current local day (src/main/shared/build-histogram.js). */
  buildHistogram: { day: number; bins: number[] };
  /** seq of the last queued event. */
  eventSequence: number;
  /** Hands a flushed batch to the Tracker's 'events' listeners. */
  publish: (batch: AUEvent[]) => void;
}

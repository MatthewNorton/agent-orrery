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

/** A project the user forgot: when, and the folder it showed then. */
export interface ForgottenProject {
  at: number;
  path: string | null;
}

/** universe-state.json as an earlier run left it. */
export interface PersistedState {
  version?: number;
  projects: Record<string, PersistedProject>;
  pathIds?: Record<string, string>;
  pathOverrides?: Record<string, string>;
  forgotten?: Record<string, ForgottenProject>;
}

/** Lines read, records of a kind the adapter reads, and the provider version named: the format canary's count. */
export interface DriftCount {
  lines: number;
  recognised: number;
  version: string | null;
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
  /** What the format canary has seen of the file (live/drift.js). */
  drift?: DriftCount;
}

/** One model the local server lists as loaded. */
export interface OllamaModel {
  name: string;
  size: number;
  sizeVram: number;
  /** When the server will unload it: set again, from the request's keep_alive, each time it completes a request, and left as it was while one runs. 0 when unknown. */
  expiresAt: number;
}

export type OllamaStatus = { reachable: true; models: OllamaModel[] } | { reachable: false };

/** A fetch: the real one, or a fixture's. The body is read as a stream, under a byte cap. */
export type OllamaFetch = (url: string, init: { signal: AbortSignal; redirect: 'error' }) => Promise<Pick<Response, 'ok' | 'body'>>;

/** The Ollama adapter's state (live/ollama-source.js): where it asks, the poll, and the loaded models' ships. */
export interface OllamaState {
  /** The Tracker option host; providers.json and OLLAMA_HOST are read per poll. */
  host: string | null;
  /** The server's system, its home folder: the Tracker option or ~/.ollama. */
  home: string;
  /** providers.json's ollama.home, read again every poll; null when it names none. */
  configHome: string | null;
  fetch: OllamaFetch;
  inFlight: AbortController | null;
  /** Consecutive failed polls; 0 after a success. */
  failures: number;
  /** No poll before this time (backoff); 0 after a success. */
  nextPollAt: number;
  /** Null until the first verdict. */
  reachable: boolean | null;
  /** Model name -> the expires_at last seen; the ship id follows from the name. */
  loaded: Map<string, number>;
}

export interface LiveModelOptions {
  claudeProjectsDir?: string;
  codexSessionsDir?: string;
  codexSessionDir?: string;
  codexSessionDirs?: string[];
  providerConfigPath?: string;
  /** Poll the local Ollama server; absent means never. */
  ollama?: { host?: string; home?: string; fetch?: OllamaFetch };
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
  /** Project id -> when the user forgot it, saved across runs (live/forgotten.js). */
  forgotten: Record<string, ForgottenProject>;
  /** Claude project folder -> the forgotten project id its transcripts belong to. */
  forgottenSlugs: Map<string, string>;
  projectPathIndex: Map<string, string>;
  codexTailsBySession: Map<string, LiveTail>;
  codexMetaCache: Map<string, { size: number; mtimeMs: number; meta: any; head: DriftCount }>;
  signalFiles: Map<string, { size: number; mtimeMs: number; sessionId: string }>;
  providerWarnings: Set<string>;
  /** The local model server; null when the Tracker was not given options.ollama. */
  ollama: OllamaState | null;
  /** Names Claude ships and drones: Claude-1, Claude-2, ... */
  shipCounter: number;
  /** Names provider ships per label: Codex-1, Signal-1, Ollama-1, ... */
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

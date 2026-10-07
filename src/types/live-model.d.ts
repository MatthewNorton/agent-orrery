// The live Tracker's own records (src/main/tracker.js); contract.d.ts has the public shapes.

import type { Attention } from './contract';

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
  taskId?: string;
  turnOutcome?: string;
}

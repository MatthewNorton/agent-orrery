'use strict';

// Shared fixtures for the Tracker / ReplaySource characterization tests.
// Every transcript write pins the file mtime to the mocked clock, because the
// Tracker compares Date.now() against real mtimes for its 5- and 15-minute
// windows.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Tracker } = require('../../src/main/tracker');
const { ReplaySource } = require('../../src/main/replay-source');

const SEC = 1000;
const MIN = 60 * SEC;
const T0 = Date.UTC(2026, 6, 21, 12, 0, 0);
const SLUG = 'C--workspace-demo';
const CLAUDE_SESSION = '7c0d5f8e-1111-4222-8333-444455556666';
const CODEX_SESSION = '019f0000-0000-7000-8000-000000000201';
const TASK_ID = '3f2a6c1e-8b4d-4e5f-9a6b-7c8d9e0f1a2b';

// Independent oracle for the fnv1a id/seed contract shared by both models.
function fnv1a(value) {
  const input = String(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function hex8(value) {
  return fnv1a(value).toString(16).padStart(8, '0');
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function setMtime(file, ms) {
  fs.utimesSync(file, ms / 1000, ms / 1000);
}

function appendJsonl(file, records, mtimeMs = Date.now()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, records.map((record) => `${JSON.stringify(record)}\n`).join(''));
  setMtime(file, mtimeMs);
}

function createWorld(t, { now = T0 } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now });
  // onToolUse samples 12% of non-build tool calls into the feed.
  t.mock.method(Math, 'random', () => 0.99);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'au-characterize-'));
  const owned = [];
  // One hook, in this order: saveState() on stop() would recreate a deleted root.
  t.after(() => {
    for (const item of owned) item.stop();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });

  const projectDir = path.join(root, 'workspace', 'demo');
  fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
  const claudeRoot = path.join(root, 'claude', 'projects');
  const codexRoot = path.join(root, 'codex', 'sessions');
  const codexArchive = path.join(root, 'codex', 'archived_sessions');
  const statePath = path.join(root, 'state', 'universe-state.json');
  const providerConfigPath = path.join(root, 'state', 'providers.json');

  return {
    root,
    projectDir,
    claudeRoot,
    codexRoot,
    codexArchive,
    statePath,
    providerConfigPath,
    clock: {
      now: () => Date.now(),
      set: (ms) => t.mock.timers.setTime(ms),
    },
    claudeFile(slug = SLUG, session = CLAUDE_SESSION) {
      return path.join(claudeRoot, slug, `${session}.jsonl`);
    },
    codexFile(sessionId = CODEX_SESSION, dir = codexRoot) {
      return path.join(dir, '2026', '07', '21', `rollout-2026-07-21T12-00-00-${sessionId}.jsonl`);
    },
    live({ statePath: trackerStatePath = statePath, ...options } = {}) {
      const tracker = new Tracker(trackerStatePath, {
        claudeProjectsDir: claudeRoot,
        codexSessionDirs: [codexRoot],
        providerConfigPath,
        ...options,
      });
      owned.push(tracker);
      return { tracker, take: collect(tracker) };
    },
    replay(options = {}) {
      const source = new ReplaySource({
        claudeProjectsDir: claudeRoot,
        codexSessionDirs: [codexRoot],
        now: () => T0 + 60 * MIN,
        ...options,
      });
      owned.push(source);
      const states = [];
      source.on('state', (state) => states.push(state));
      return { source, take: collect(source), states };
    },
  };
}

// Returns a function that hands back (and forgets) every event emitted so far.
function collect(emitter) {
  const batches = [];
  emitter.on('events', (batch) => batches.push(batch));
  return () => batches.splice(0).flat();
}

function ofType(events, type) {
  return events.filter((event) => event.type === type);
}

function countTypes(events) {
  const counts = {};
  for (const event of events) counts[event.type] = (counts[event.type] || 0) + 1;
  return counts;
}

const claude = {
  prompt: (cwd, ts, text = 'private prompt') => ({
    type: 'user', timestamp: iso(ts), cwd,
    message: { role: 'user', content: text },
  }),
  tool: (cwd, ts, id, name, input = {}) => ({
    type: 'assistant', timestamp: iso(ts), cwd,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  }),
  result: (cwd, ts, id) => ({
    type: 'user', timestamp: iso(ts), cwd,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'private' }] },
  }),
  turnDone: (cwd, ts) => ({ type: 'system', subtype: 'turn_duration', timestamp: iso(ts), cwd }),
};

const codex = {
  meta: (ts, id, cwd, extra = {}) => ({
    timestamp: iso(ts), type: 'session_meta',
    payload: { id, session_id: id, cwd, thread_source: 'user', ...extra },
  }),
  call: (ts, callId, name) => ({
    timestamp: iso(ts), type: 'response_item',
    payload: { type: 'function_call', call_id: callId, name, arguments: '{"cmd":"private"}' },
  }),
  output: (ts, callId) => ({
    timestamp: iso(ts), type: 'response_item',
    payload: { type: 'function_call_output', call_id: callId, output: 'private' },
  }),
  patchCall: (ts, callId) => ({
    timestamp: iso(ts), type: 'response_item',
    payload: { type: 'custom_tool_call', call_id: callId, name: 'apply_patch', input: 'private' },
  }),
  patchOutput: (ts, callId) => ({
    timestamp: iso(ts), type: 'response_item',
    payload: { type: 'custom_tool_call_output', call_id: callId, output: 'private' },
  }),
  patched: (ts, callId, files) => ({
    timestamp: iso(ts), type: 'event_msg',
    payload: {
      type: 'patch_apply_end', call_id: callId, success: true,
      changes: Object.fromEntries(files.map((file) => [file, { type: 'update', content: 'private' }])),
    },
  }),
  userText: (ts, text) => ({
    timestamp: iso(ts), type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  }),
  event: (ts, type) => ({ timestamp: iso(ts), type: 'event_msg', payload: { type } }),
};

module.exports = {
  SEC,
  MIN,
  T0,
  SLUG,
  CLAUDE_SESSION,
  CODEX_SESSION,
  TASK_ID,
  fnv1a,
  hex8,
  iso,
  setMtime,
  appendJsonl,
  createWorld,
  ofType,
  countTypes,
  claude,
  codex,
};

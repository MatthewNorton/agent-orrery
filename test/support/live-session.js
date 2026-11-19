'use strict';

// A live Tracker over one transcript, for the tracker tests: sessions already docked at startup,
// and the clock, the file and the poll moved together.

const { T0, CODEX_SESSION, appendJsonl, writeState, createWorld, claude, codex } = require('./transcripts');

const PROJECT_KEYS = [
  'exists', 'firstSeen', 'galaxy', 'id', 'lastActivity', 'name', 'path', 'planets', 'seed',
  'totalBuilds', 'totalBytes',
];
const SHIP_KEYS = [
  'attention', 'attentionSince', 'builds', 'detail', 'id', 'kind', 'lastEvent', 'local', 'model', 'name', 'project',
  'provider', 'status', 'taskId', 'turnOutcome',
];

// A Claude session whose first line was on disk at startup (so it is tailed
// from EOF and its ship is docked), with startup events already drained.
// `saved` is the projects map of a universe-state.json left by an earlier run.
function startClaude(t, { mtime = T0, saved } = {}) {
  const world = createWorld(t);
  if (saved) writeState(world.statePath, { projects: saved });
  const file = world.claudeFile();
  appendJsonl(file, [claude.prompt(world.projectDir, mtime)], mtime);
  const live = world.live();
  live.tracker.scan(true);
  const startup = live.take();
  return { world, file, dir: world.projectDir, ...live, startup };
}

function startCodex(t) {
  const world = createWorld(t);
  const file = world.codexFile();
  appendJsonl(file, [codex.meta(T0, CODEX_SESSION, world.projectDir)], T0);
  const live = world.live();
  live.tracker.scan(true);
  const startup = live.take();
  return { world, file, dir: world.projectDir, ...live, startup };
}

// Moves the clock to `at`, appends records with that mtime, and polls once.
function appendAndPoll(session, records, at) {
  session.world.clock.set(at);
  appendJsonl(session.file, records, at);
  session.tracker.pollFiles();
  return session.take();
}

function pollAt(session, at) {
  session.world.clock.set(at);
  session.tracker.pollFiles();
  return session.take();
}

function sweepAt(session, at) {
  session.world.clock.set(at);
  session.tracker.sweepShips();
  return session.take();
}

function shipOf(tracker, id) {
  return tracker.snapshot().ships.find((ship) => ship.id === id);
}

module.exports = { PROJECT_KEYS, SHIP_KEYS, startClaude, startCodex, appendAndPoll, pollAt, sweepAt, shipOf };

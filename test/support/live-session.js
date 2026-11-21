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

// A session whose first line was on disk at startup (so it is tailed from EOF and its ship is
// docked), with startup events already drained. `file(world)` is its transcript and
// `firstRecord(world, mtime)` that line; `saved` is the projects map of a universe-state.json
// left by an earlier run.
function start(t, file, firstRecord, { mtime = T0, saved } = {}) {
  const world = createWorld(t);
  if (saved) writeState(world.statePath, { projects: saved });
  const transcript = file(world);
  appendJsonl(transcript, [firstRecord(world, mtime)], mtime);
  const live = world.live();
  live.tracker.scan(true);
  const startup = live.take();
  return { world, file: transcript, dir: world.projectDir, ...live, startup };
}

const startClaude = (t, options) => start(t, (world) => world.claudeFile(), (world, mtime) => claude.prompt(world.projectDir, mtime), options);
const startCodex = (t, options) => start(t, (world) => world.codexFile(), (world, mtime) => codex.meta(mtime, CODEX_SESSION, world.projectDir), options);

/** The tracker's projects as a snapshot gives them, by id. */
function projectsById(tracker) {
  return new Map(tracker.snapshot().projects.map((project) => [project.id, project]));
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

module.exports = { PROJECT_KEYS, SHIP_KEYS, startClaude, startCodex, projectsById, appendAndPoll, pollAt, sweepAt, shipOf };

'use strict';

// Fakes for the main-process wiring tests: a window that records pushes, IPC events
// from trusted and untrusted frames, and tracker / replay sources that carry only the
// fields and methods the wiring touches.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { RENDERER_ENTRY_URL } = require('../../src/main/window');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeWindow() {
  const webContents = new EventEmitter();
  webContents.mainFrame = { url: RENDERER_ENTRY_URL };
  const win = new EventEmitter();
  win.sent = [];
  win.destroyed = false;
  win.webContents = webContents;
  win.isDestroyed = () => win.destroyed;
  webContents.send = (channel, ...args) => { win.sent.push({ channel, args }); };
  return win;
}

function sentOn(win, channel) {
  return win.sent.filter((entry) => entry.channel === channel).map((entry) => entry.args);
}

function trustedEvent(win) {
  return { sender: win.webContents, senderFrame: win.webContents.mainFrame };
}

// Same sender and URL, but not the main frame: an embedded frame must never pass.
function untrustedEvent(win) {
  return { sender: win.webContents, senderFrame: { url: RENDERER_ENTRY_URL } };
}

function fakeTracker({ projects = [], ships = [] } = {}) {
  const tracker = new EventEmitter();
  tracker.projects = new Map(projects.map((project) => [project.id, project]));
  tracker.ships = new Map(ships.map((ship) => [ship.id, ship]));
  tracker.remapped = [];
  tracker.snapshot = () => ({
    projects: [...tracker.projects.values()], ships: [...tracker.ships.values()], feed: [], eventSequence: 3,
  });
  tracker.getSystem = (id) => ({ source: 'live', project: tracker.projects.get(id) || null, planets: [] });
  tracker.getPlanet = (id, name) => ({ source: 'live', id, name });
  tracker.remapProjectPath = (id, projectPath) => {
    tracker.remapped.push({ id, path: projectPath });
    const project = { ...tracker.projects.get(id), path: projectPath, exists: true };
    tracker.projects.set(id, project);
    return project;
  };
  return tracker;
}

function fakeReplaySource(status = {}) {
  const source = new EventEmitter();
  source.calls = [];
  source.raw = {
    available: true, indexing: false, minTs: 1_000, maxTs: 9_000, cursorTs: null,
    playing: false, speed: 1, sourceCount: 2, truncated: false, ...status,
  };
  // Tests swap these for deferred promises to hold a command in flight.
  source.gates = { index: null, seek: null, advanceTo: null };
  const record = (name, ...args) => { source.calls.push([name, ...args]); };
  const gated = async (name, done) => {
    if (source.gates[name]) await source.gates[name];
    done();
  };
  source.status = () => ({ ...source.raw });
  source.index = (...args) => {
    record('index', ...args);
    return gated('index', () => { source.raw.available = true; });
  };
  source.seek = (ts) => {
    record('seek', ts);
    return gated('seek', () => { source.raw.cursorTs = ts; });
  };
  source.advanceTo = (ts, options) => {
    record('advanceTo', ts, options);
    return gated('advanceTo', () => { source.raw.cursorTs = ts; });
  };
  source.pause = () => { record('pause'); source.raw.playing = false; };
  source.play = () => { record('play'); source.raw.playing = true; };
  source.setSpeed = (speed) => { record('setSpeed', speed); source.raw.speed = speed; };
  source.snapshot = () => ({ projects: [], ships: [], feed: [], eventSequence: 11 });
  source.getSystem = (id) => ({ source: 'replay', project: { id }, planets: [] });
  source.getPlanet = (id, name) => ({ source: 'replay', id, name });
  source.stop = () => record('stop');
  return source;
}

function callNames(source) {
  return source.calls.map(([name]) => name);
}

// The ctx fields the replay and ipc factories read; tests attach the real factories.
function fakeCtx(overrides = {}) {
  const tracker = overrides.tracker || fakeTracker();
  return {
    flags: {},
    win: fakeWindow(),
    tracker,
    replaySource: fakeReplaySource(),
    activeSource: tracker,
    streamEpoch: 1,
    terminalLauncher: null,
    taskRuns: null,
    rootTaskCoordinator: null,
    projectVcsStatusController: null,
    harness: { openedProjects: [] },
    replay: { replayBoundaryOperations: 0 },
    ipc: {},
    ...overrides,
  };
}

// Native realpath: Windows CI temp dirs are 8.3 short names the app expands.
function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.normalize(fs.realpathSync.native(dir));
}

function liveProject(id, projectPath, extra = {}) {
  return { id, name: id, path: projectPath, exists: true, lastActivity: 0, ...extra };
}

function setPlatform(t, platform) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  t.after(() => Object.defineProperty(process, 'platform', original));
}

module.exports = {
  RENDERER_ENTRY_URL,
  deferred,
  fakeWindow,
  sentOn,
  trustedEvent,
  untrustedEvent,
  fakeTracker,
  fakeReplaySource,
  callNames,
  fakeCtx,
  tempDir,
  liveProject,
  setPlatform,
};

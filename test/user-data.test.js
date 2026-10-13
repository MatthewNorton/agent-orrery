'use strict';

// The rename to Agent Orrery moved the data folder; the first run under the new name copies the
// app's own state from the Agent Universe Lite folder and never writes to it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { adoptLegacyUserData, LEGACY_FOLDER } = require('../src/main/user-data');

function profile(t) {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'au-user-data-'));
  t.after(() => fs.rmSync(appData, { recursive: true, force: true }));
  const legacy = path.join(appData, LEGACY_FOLDER);
  const userData = path.join(appData, 'agent-orrery');
  const app = { getPath: (name) => (name === 'appData' ? appData : userData) };
  return { appData, legacy, userData, app };
}

function seedLegacy(legacy, files) {
  fs.mkdirSync(path.join(legacy, 'Local Storage'), { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(legacy, name), text);
}

function snapshot(dir) {
  return fs.readdirSync(dir, { recursive: true }).sort().map((name) => {
    const file = path.join(dir, String(name));
    return [String(name), fs.statSync(file).isFile() ? fs.readFileSync(file, 'utf8') : '<dir>'];
  });
}

test('first run under the new name copies the state files and leaves the legacy folder as it was', (t) => {
  const { legacy, userData, app } = profile(t);
  seedLegacy(legacy, {
    'universe-state.json': '{"version":1,"projects":{"p":{"builds":12}}}',
    'root-tasks.json': '{"ideas":[]}',
    'task-runs.json': '{"runs":[]}',
    'Preferences': '{}',
  });
  const before = snapshot(legacy);

  assert.deepEqual(adoptLegacyUserData(app), ['root-tasks.json', 'task-runs.json', 'universe-state.json']);
  for (const name of ['universe-state.json', 'root-tasks.json', 'task-runs.json']) {
    assert.equal(fs.readFileSync(path.join(userData, name), 'utf8'), fs.readFileSync(path.join(legacy, name), 'utf8'));
  }
  assert.deepEqual(fs.readdirSync(userData).sort(), ['root-tasks.json', 'task-runs.json', 'universe-state.json'],
    'only the app\'s own files, no Chromium data and no temp files');
  assert.deepEqual(snapshot(legacy), before);
});

test('once the new folder has its own state, later runs copy nothing', (t) => {
  const { legacy, userData, app } = profile(t);
  seedLegacy(legacy, { 'universe-state.json': '{"old":true}', 'root-tasks.json': '{"old":true}' });
  fs.mkdirSync(userData);
  fs.writeFileSync(path.join(userData, 'universe-state.json'), '{"new":true}');

  assert.deepEqual(adoptLegacyUserData(app), []);
  assert.deepEqual(fs.readdirSync(userData), ['universe-state.json']);
  assert.equal(fs.readFileSync(path.join(userData, 'universe-state.json'), 'utf8'), '{"new":true}');
});

test('a folder Chromium already created does not count as migrated', (t) => {
  const { legacy, userData, app } = profile(t);
  seedLegacy(legacy, { 'universe-state.json': '{"old":true}' });
  fs.mkdirSync(path.join(userData, 'GPUCache'), { recursive: true });

  assert.deepEqual(adoptLegacyUserData(app), ['universe-state.json']);
});

test('nothing to copy: no legacy state, or still running under the legacy name', (t) => {
  const { appData, legacy, userData, app } = profile(t);
  assert.deepEqual(adoptLegacyUserData(app), []);
  assert.equal(fs.existsSync(userData), false, 'a fresh install gets no folder from the copy');

  seedLegacy(legacy, { 'universe-state.json': '{}' });
  const sameFolder = { getPath: (name) => (name === 'appData' ? appData : legacy) };
  assert.deepEqual(adoptLegacyUserData(sameFolder), []);
});

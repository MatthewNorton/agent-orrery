'use strict';

// A bare live model over a temp folder, for the tests of the project registry and of the owner's
// edits to it: no Tracker and no scan, so a test sets the projects it needs.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLiveModel } = require('../../src/main/live/model');

function newModel(t, { statePath, persisted } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'au-live-projects-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = statePath ? statePath(root) : path.join(root, 'state', 'universe-state.json');
  if (persisted) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(persisted));
  }
  const published = [];
  const model = createLiveModel(file, { claudeProjectsDir: path.join(root, 'none'), codexSessionDirs: [],
    providerConfigPath: path.join(root, 'providers.json') }, (batch) => published.push(...batch));
  // Flushed events first, then whatever is still queued: seq order either way.
  const take = () => [...published.splice(0), ...model.pending.splice(0)].map((event) => event.type === 'feed'
    ? ['feed', event.entry.text] : [event.type, event.project.id]);
  const dir = (name) => {
    const full = path.join(root, name);
    fs.mkdirSync(full, { recursive: true });
    return full;
  };
  return { root, file, model, take, dir };
}

function record(id, projectPath, exists) {
  return {
    id, path: projectPath, name: projectPath ? path.basename(projectPath) : id, exists,
    lastActivity: 0, totalBytes: 0, buckets: {}, totalBuilds: 0, firstSeen: 0,
  };
}

module.exports = { newModel, record };

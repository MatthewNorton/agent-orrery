'use strict';

// Universe export and import over the IPC handlers: the file dialogs, the file checks, and the
// IDEAS queue.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createBackupIpc } = require('../src/main/ipc/backup');
const { RootTaskStore } = require('../src/main/root-tasks');
const { fakeCtx, trustedEvent } = require('./support/main-wiring');
const { MIN, T0, createWorld, writeState } = require('./support/transcripts');

// `choose` answers each file dialog with a path, or null for Cancel.
function backupCtx(t) {
  const w = createWorld(t);
  writeState(w.statePath, {
    version: 2,
    projects: { demo: { path: w.projectDir, buckets: { src: 2 }, totalBuilds: 2, firstSeen: T0 - 5 * MIN } },
  });
  const tracker = w.live().tracker;
  const rootTasks = new RootTaskStore({ statePath: path.join(w.root, 'root-tasks.json'), now: () => 1 });
  rootTasks.create('first idea');
  const pushes = [];
  const ctx = fakeCtx({
    tracker,
    rootTasks,
    ipc: { rootTasks: { sendRootTasksChanged: (item, reason) => pushes.push([item.text, reason]) } },
  });
  const electron = { dialogs: [], choose: () => null };
  electron.app = { getPath: () => w.root };
  electron.dialog = {
    async showSaveDialog(win, options) {
      electron.dialogs.push(options);
      const file = electron.choose();
      return { canceled: !file, filePath: file || '' };
    },
    async showOpenDialog(win, options) {
      electron.dialogs.push(options);
      const file = electron.choose();
      return { canceled: !file, filePaths: file ? [file] : [] };
    },
  };
  const backup = createBackupIpc(ctx, electron);
  return { w, ctx, tracker, rootTasks, electron, backup, pushes, event: trustedEvent(ctx.win) };
}

test('export writes the universe and the ideas to the chosen file', async (t) => {
  const { w, electron, backup, event } = backupCtx(t);
  assert.deepEqual(await backup.handleUniverseExport(event), { ok: true, canceled: true });

  const file = path.join(w.root, 'backup.json');
  electron.choose = () => file;
  assert.deepEqual(await backup.handleUniverseExport(event), {
    ok: true, canceled: false, path: file, projects: 1, ideas: 1,
  });
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(written.format, 'agent-orrery-backup');
  assert.equal(written.universe.projects.demo.totalBuilds, 2);
  assert.deepEqual(written.ideas, [{ text: 'first idea', createdAt: 1 }]);
  assert.match(path.basename(electron.dialogs[0].defaultPath), /^agent-orrery-\d{4}-\d{2}-\d{2}\.json$/);
});

test('import merges a backup and adds only the ideas the queue lacks', async (t) => {
  const { w, tracker, rootTasks, electron, backup, pushes, event } = backupCtx(t);
  const file = path.join(w.root, 'in.json');
  fs.writeFileSync(file, JSON.stringify({
    format: 'agent-orrery-backup',
    version: 1,
    universe: { projects: { extra: { buckets: { lib: 1 }, totalBuilds: 1, firstSeen: T0 - 9 * MIN } } },
    ideas: [{ text: ' first idea ' }, { text: 'second idea' }, { text: 'third idea' }],
  }));
  electron.choose = () => file;
  assert.deepEqual(await backup.handleUniverseImport(event), {
    ok: true, canceled: false, added: 1, merged: 0, ideas: 2,
  });
  assert.deepEqual(rootTasks.list().map((item) => item.text), ['first idea', 'second idea', 'third idea']);
  assert.deepEqual(pushes, [['third idea', 'created']], 'one change notice for the batch');
  assert.ok(tracker.projects.has('extra'));
});

test('import refuses replay, a folder, an oversized file and a file that is not a backup', async (t) => {
  const { w, ctx, tracker, electron, backup, event } = backupCtx(t);
  ctx.activeSource = ctx.replaySource;
  assert.deepEqual(await backup.handleUniverseImport(event), { ok: false, code: 'REPLAY' });
  assert.equal(electron.dialogs.length, 0);
  ctx.activeSource = tracker;

  const big = path.join(w.root, 'big.json');
  fs.writeFileSync(big, Buffer.alloc(8 * 1024 * 1024 + 1, 32));
  const notBackup = path.join(w.root, 'other.json');
  fs.writeFileSync(notBackup, '{"projects": {}}');
  for (const file of [w.root, big, notBackup]) {
    electron.choose = () => file;
    assert.deepEqual(await backup.handleUniverseImport(event), { ok: false, code: 'INVALID' }, file);
  }
  assert.deepEqual([...tracker.projects.keys()], ['demo']);
});

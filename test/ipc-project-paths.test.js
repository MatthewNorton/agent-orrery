'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createProjectPathsIpc } = require('../src/main/ipc/project-paths');
const {
  deferred, fakeCtx, fakeTracker, liveProject, tempDir, trustedEvent, untrustedEvent,
} = require('./support/main-wiring');

// `next` answers each dialog; by default the user picks the search root.
function fakeElectron(documents) {
  const electron = { dialogs: [], next: null };
  electron.app = { getPath: (name) => (name === 'documents' ? documents : null) };
  electron.dialog = {
    async showOpenDialog(win, options) {
      electron.dialogs.push({ win, options });
      return electron.next();
    },
  };
  return electron;
}

function pathsCtx(t) {
  const dir = tempDir(t, 'au-ipc-project-paths-');
  const search = path.join(dir, 'search');
  const documents = path.join(dir, 'documents');
  for (const sub of [path.join(search, 'nested', 'alpha'), path.join(search, 'beta'), documents]) {
    fs.mkdirSync(sub, { recursive: true });
  }
  const tracker = fakeTracker({
    projects: [
      liveProject('beta', path.join(dir, 'old', 'beta'), { exists: false, lastActivity: 1 }),
      liveProject('alpha', path.join(dir, 'old', 'alpha'), { exists: false, lastActivity: 2 }),
      liveProject('gamma', dir),
    ],
  });
  const ctx = fakeCtx({ tracker });
  ctx.activeSource = tracker;
  const electron = fakeElectron(documents);
  electron.next = async () => ({ canceled: false, filePaths: [search] });
  const paths = createProjectPathsIpc(ctx, electron);
  return { ctx, paths, electron, tracker, dir, search, documents, event: trustedEvent(ctx.win) };
}

function tokenFor(scan, projectId) {
  return scan.matches.find((match) => match.projectId === projectId).candidates[0].token;
}

function markMissing(tracker, id) {
  tracker.projects.set(id, { ...tracker.projects.get(id), exists: false });
}

test('a scan offers one-time tokens for the candidates of every missing project', async (t) => {
  const { ctx, paths, electron, dir, search, event } = pathsCtx(t);
  const scan = await paths.handleProjectPathsScan(event);

  assert.equal(scan.ok, true);
  assert.equal(scan.canceled, false);
  assert.equal(typeof scan.scanId, 'string');
  assert.equal(scan.root, search);
  assert.equal(scan.truncated, false);
  assert.deepEqual(scan.matches.map((match) => [match.projectId, match.candidates.map((c) => c.path)]), [
    ['alpha', [path.join(search, 'nested', 'alpha')]],
    ['beta', [path.join(search, 'beta')]],
  ], 'most recently active missing project first');
  const tokens = scan.matches.flatMap((match) => match.candidates.map((c) => c.token));
  assert.equal(new Set(tokens).size, tokens.length);

  assert.equal(electron.dialogs.length, 1);
  assert.equal(electron.dialogs[0].win, ctx.win);
  assert.equal(electron.dialogs[0].options.defaultPath, dir, 'nearest existing ancestor of the old path');
  assert.deepEqual(electron.dialogs[0].options.properties, ['openDirectory']);
});

test('applying a token remaps the project once and revokes its other tokens', async (t) => {
  const { paths, tracker, search, event } = pathsCtx(t);
  const scan = await paths.handleProjectPathsScan(event);
  const alpha = tokenFor(scan, 'alpha');

  const applied = paths.handleProjectPathApply(event, 'alpha', alpha);
  assert.equal(applied.ok, true);
  assert.equal(applied.canceled, false);
  assert.equal(applied.project.path, path.join(search, 'nested', 'alpha'));
  assert.deepEqual(tracker.remapped, [{ id: 'alpha', path: path.join(search, 'nested', 'alpha') }]);

  markMissing(tracker, 'alpha');
  assert.deepEqual(paths.handleProjectPathApply(event, 'alpha', alpha), { ok: false, code: 'EXPIRED' });
  assert.equal(paths.handleProjectPathApply(event, 'beta', tokenFor(scan, 'beta')).ok, true, 'other projects keep theirs');
});

test('a token belongs to one project', async (t) => {
  const { paths, tracker, event } = pathsCtx(t);
  const scan = await paths.handleProjectPathsScan(event);
  assert.deepEqual(paths.handleProjectPathApply(event, 'beta', tokenFor(scan, 'alpha')), { ok: false, code: 'EXPIRED' });
  assert.deepEqual(paths.handleProjectPathApply(event, 'beta', 'made-up-token'), { ok: false, code: 'EXPIRED' });
  assert.deepEqual(tracker.remapped, []);
});

test('tokens expire ten minutes after the scan', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const { paths, event } = pathsCtx(t);
  const scan = await paths.handleProjectPathsScan(event);
  t.mock.timers.tick(10 * 60 * 1000 - 1);
  assert.equal(paths.handleProjectPathApply(event, 'beta', tokenFor(scan, 'beta')).ok, true);
  t.mock.timers.tick(1);
  assert.deepEqual(paths.handleProjectPathApply(event, 'alpha', tokenFor(scan, 'alpha')), { ok: false, code: 'EXPIRED' });
});

test('a new scan, a project coming back and reset each drop issued tokens', async (t) => {
  const { paths, event } = pathsCtx(t);
  const first = await paths.handleProjectPathsScan(event);
  const second = await paths.handleProjectPathsScan(event);
  assert.deepEqual(paths.handleProjectPathApply(event, 'alpha', tokenFor(first, 'alpha')), { ok: false, code: 'EXPIRED' });

  paths.revokeProjectPathCandidates('alpha');
  assert.deepEqual(paths.handleProjectPathApply(event, 'alpha', tokenFor(second, 'alpha')), { ok: false, code: 'EXPIRED' });

  paths.reset();
  assert.deepEqual(paths.handleProjectPathApply(event, 'beta', tokenFor(second, 'beta')), { ok: false, code: 'EXPIRED' });
});

test('apply re-checks the candidate folder on disk', async (t) => {
  const { paths, tracker, search, event } = pathsCtx(t);
  const scan = await paths.handleProjectPathsScan(event);
  fs.rmSync(path.join(search, 'nested', 'alpha'), { recursive: true });
  assert.deepEqual(paths.handleProjectPathApply(event, 'alpha', tokenFor(scan, 'alpha')), { ok: false, code: 'FAILED' });
  fs.rmSync(path.join(search, 'beta'), { recursive: true });
  fs.writeFileSync(path.join(search, 'beta'), 'now a file');
  assert.deepEqual(paths.handleProjectPathApply(event, 'beta', tokenFor(scan, 'beta')), { ok: false, code: 'INVALID' });
  assert.deepEqual(tracker.remapped, []);
});

test('apply validates its arguments and the project state', async (t) => {
  const { paths, event } = pathsCtx(t);
  const scan = await paths.handleProjectPathsScan(event);
  const token = tokenFor(scan, 'alpha');
  assert.deepEqual(paths.handleProjectPathApply(event, '', token), { ok: false, code: 'INVALID' });
  for (const bad of [null, '', 42, 'x'.repeat(129)]) {
    assert.deepEqual(paths.handleProjectPathApply(event, 'alpha', bad), { ok: false, code: 'INVALID' });
  }
  assert.deepEqual(paths.handleProjectPathApply(event, 'delta', token), { ok: false, code: 'NOT_FOUND' });
  assert.deepEqual(paths.handleProjectPathApply(event, 'gamma', token), { ok: false, code: 'NOT_MISSING' });
});

test('scan, locate and apply are LIVE-only and refuse untrusted frames', async (t) => {
  const { ctx, paths, electron, tracker, event } = pathsCtx(t);
  const scan = await paths.handleProjectPathsScan(event);
  electron.dialogs.length = 0;
  const denials = [
    ['INVALID', untrustedEvent(ctx.win), () => {}],
    ['REPLAY', event, () => { ctx.activeSource = ctx.replaySource; }],
    ['REPLAY', event, () => { ctx.activeSource = tracker; ctx.replay.replayBoundaryOperations = 1; }],
  ];
  for (const [code, denialEvent, arrange] of denials) {
    arrange();
    assert.deepEqual(await paths.handleProjectPathsScan(denialEvent), { ok: false, code });
    assert.deepEqual(await paths.handleProjectPathLocate(denialEvent, 'alpha'), { ok: false, code });
    assert.deepEqual(paths.handleProjectPathApply(denialEvent, 'alpha', tokenFor(scan, 'alpha')), { ok: false, code });
  }
  assert.equal(electron.dialogs.length, 0);
  assert.deepEqual(tracker.remapped, []);
});

test('switching to replay while the dialog is open discards the selection', async (t) => {
  const { ctx, paths, electron, tracker, search, event } = pathsCtx(t);
  const picked = deferred();
  electron.next = () => picked.promise;
  const scanning = paths.handleProjectPathsScan(event);
  ctx.activeSource = ctx.replaySource;
  picked.resolve({ canceled: false, filePaths: [search] });
  assert.deepEqual(await scanning, { ok: false, code: 'REPLAY' });

  ctx.activeSource = tracker;
  electron.next = async () => {
    ctx.replay.replayBoundaryOperations = 1;
    return { canceled: false, filePaths: [search] };
  };
  assert.deepEqual(await paths.handleProjectPathLocate(event, 'alpha'), { ok: false, code: 'REPLAY' });
  assert.deepEqual(tracker.remapped, []);
});

test('one dialog at a time; a canceled or failed dialog frees the slot', async (t) => {
  const { paths, electron, event } = pathsCtx(t);
  const picked = deferred();
  electron.next = () => picked.promise;
  const first = paths.handleProjectPathsScan(event);
  assert.deepEqual(await paths.handleProjectPathsScan(event), { ok: false, code: 'BUSY' });
  picked.resolve({ canceled: true, filePaths: [] });
  assert.deepEqual(await first, { ok: true, canceled: true });

  electron.next = async () => { throw new Error('dialog crashed'); };
  assert.deepEqual(await paths.handleProjectPathsScan(event), { ok: false, code: 'FAILED' });
  electron.next = async () => ({ canceled: false, filePaths: [] });
  assert.deepEqual(await paths.handleProjectPathLocate(event, 'alpha'), { ok: true, canceled: true });
  assert.equal(electron.dialogs.length, 3, 'BUSY never opened a dialog');
});

test('with nothing missing the scan returns at once without a dialog', async (t) => {
  const { paths, electron, tracker, event } = pathsCtx(t);
  tracker.projects.delete('alpha');
  tracker.projects.delete('beta');
  assert.deepEqual(await paths.handleProjectPathsScan(event), {
    ok: true, canceled: false, root: null, directoriesVisited: 0, truncated: false, matches: [],
  });
  assert.equal(electron.dialogs.length, 0);
});

test('locate remaps to the chosen folder and revokes that project\'s tokens', async (t) => {
  const { paths, electron, tracker, search, event } = pathsCtx(t);
  const scan = await paths.handleProjectPathsScan(event);
  const chosen = path.join(search, 'beta');
  electron.next = async () => ({ canceled: false, filePaths: [chosen] });

  const located = await paths.handleProjectPathLocate(event, 'alpha');
  assert.deepEqual(located, { ok: true, canceled: false, project: tracker.projects.get('alpha') });
  assert.deepEqual(tracker.remapped, [{ id: 'alpha', path: chosen }]);
  assert.equal(electron.dialogs.at(-1).options.title, 'Locate alpha');

  markMissing(tracker, 'alpha');
  assert.deepEqual(paths.handleProjectPathApply(event, 'alpha', tokenFor(scan, 'alpha')), { ok: false, code: 'EXPIRED' });
});

test('locate refuses unknown, present and invalid projects, and re-checks after the dialog', async (t) => {
  const { paths, electron, tracker, search, event } = pathsCtx(t);
  assert.deepEqual(await paths.handleProjectPathLocate(event, 'delta'), { ok: false, code: 'NOT_FOUND' });
  assert.deepEqual(await paths.handleProjectPathLocate(event, 'gamma'), { ok: false, code: 'NOT_MISSING' });
  assert.deepEqual(await paths.handleProjectPathLocate(event, 'bad\nid'), { ok: false, code: 'INVALID' });
  assert.equal(electron.dialogs.length, 0);

  electron.next = async () => {
    tracker.projects.set('alpha', { ...tracker.projects.get('alpha'), exists: true });
    return { canceled: false, filePaths: [search] };
  };
  assert.deepEqual(await paths.handleProjectPathLocate(event, 'alpha'), { ok: false, code: 'NOT_MISSING' });
  assert.deepEqual(tracker.remapped, []);
});

test('the dialog falls back to Documents when the old path has no usable ancestor', async (t) => {
  const { paths, electron, tracker, documents, event } = pathsCtx(t);
  tracker.projects.set('alpha', liveProject('alpha', path.join('relative', 'alpha'), { exists: false }));
  electron.next = async () => ({ canceled: true, filePaths: [] });
  await paths.handleProjectPathLocate(event, 'alpha');
  assert.equal(electron.dialogs[0].options.defaultPath, documents);
});

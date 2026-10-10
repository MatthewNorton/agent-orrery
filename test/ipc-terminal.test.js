'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTerminalIpc } = require('../src/main/ipc/terminal');
const {
  deferred, fakeCtx, fakeTracker, liveProject, setPlatform, tempDir, trustedEvent, untrustedEvent,
} = require('./support/main-wiring');

// `next` is called per launch when set, so a test can hand back a pending or failing outcome.
function fakeLauncher() {
  const launcher = { requests: [], next: null };
  launcher.open = async (request) => {
    launcher.requests.push(request);
    return launcher.next ? launcher.next() : { ok: true };
  };
  return launcher;
}

// controlTest lifts the platform gate so the launch path runs on Linux CI too.
function terminalCtx(t, { flags = { controlTest: true }, launcher = fakeLauncher() } = {}) {
  const dir = tempDir(t, 'au-ipc-terminal-');
  const ctx = fakeCtx({
    flags,
    tracker: fakeTracker({ projects: [liveProject('alpha', dir)] }),
    terminalLauncher: launcher,
  });
  ctx.activeSource = ctx.tracker;
  const terminal = createTerminalIpc(ctx);
  return { ctx, terminal, launcher, dir, event: trustedEvent(ctx.win) };
}

test('liveProjectCwd resolves a live project to its canonical directory', (t) => {
  const { ctx, terminal, dir } = terminalCtx(t);
  assert.equal(terminal.liveProjectCwd('alpha'), dir);

  const real = path.join(dir, 'real');
  const link = path.join(dir, 'link');
  fs.mkdirSync(real);
  fs.symlinkSync(real, link, 'junction');
  ctx.tracker.projects.set('linked', liveProject('linked', link));
  assert.equal(terminal.liveProjectCwd('linked'), real, 'links resolve to their target');
});

test('liveProjectCwd refuses anything that is not a present local directory', (t) => {
  const { ctx, terminal, dir } = terminalCtx(t);
  const file = path.join(dir, 'file.txt');
  fs.writeFileSync(file, 'x');
  const projects = ctx.tracker.projects;
  projects.set('missing', liveProject('missing', dir, { exists: false }));
  projects.set('unknown-state', liveProject('unknown-state', dir, { exists: undefined }));
  projects.set('relative', liveProject('relative', path.join('relative', 'dir')));
  projects.set('unc', liveProject('unc', '\\\\server\\share\\project'));
  projects.set('device', liveProject('device', '\\\\?\\C:\\project'));
  projects.set('file', liveProject('file', file));
  projects.set('gone', liveProject('gone', path.join(dir, 'gone')));
  projects.set('no-path', liveProject('no-path', null));

  for (const id of ['nope', 'missing', 'unknown-state', 'relative', 'unc', 'device', 'file', 'gone', 'no-path']) {
    assert.equal(terminal.liveProjectCwd(id), null, id);
  }
  ctx.tracker = null;
  assert.equal(terminal.liveProjectCwd('alpha'), null, 'no tracker');
  ctx.tracker = { projects: {} };
  assert.equal(terminal.liveProjectCwd('alpha'), null, 'projects is not a Map');
});

test('opens the terminal once at the canonical cwd', async (t) => {
  const { terminal, launcher, dir, event } = terminalCtx(t);
  assert.deepEqual(await terminal.handleOpenTerminal(event, 'alpha'), { ok: true });
  assert.deepEqual(launcher.requests, [{ cwd: dir }]);
});

test('rejects untrusted frames and invalid ids before anything else', async (t) => {
  const { ctx, terminal, launcher, event } = terminalCtx(t);
  ctx.activeSource = ctx.replaySource;
  assert.deepEqual(await terminal.handleOpenTerminal(untrustedEvent(ctx.win), 'alpha'), { ok: false, code: 'INVALID' });
  for (const id of ['', ' ', 'a\nb', 'x'.repeat(257), 7, null]) {
    assert.deepEqual(await terminal.handleOpenTerminal(event, id), { ok: false, code: 'INVALID' }, String(id));
  }
  assert.equal(launcher.requests.length, 0);
});

test('is LIVE-only: refused in replay and while a seek is crossing the boundary', async (t) => {
  const { ctx, terminal, launcher, event } = terminalCtx(t);
  ctx.activeSource = ctx.replaySource;
  assert.deepEqual(await terminal.handleOpenTerminal(event, 'alpha'), { ok: false, code: 'REPLAY' });
  ctx.activeSource = ctx.tracker;
  ctx.replay.replayBoundaryOperations = 1;
  assert.deepEqual(await terminal.handleOpenTerminal(event, 'alpha'), { ok: false, code: 'REPLAY' });
  assert.equal(launcher.requests.length, 0);
});

test('hosts without a terminal adapter report UNAVAILABLE unless the control harness runs', async (t) => {
  setPlatform(t, 'linux');
  const plain = terminalCtx(t, { flags: {} });
  assert.deepEqual(await plain.terminal.handleOpenTerminal(plain.event, 'alpha'), { ok: false, code: 'UNAVAILABLE' });
  assert.equal(plain.launcher.requests.length, 0);

  const harness = terminalCtx(t, { flags: { controlTest: true } });
  assert.deepEqual(await harness.terminal.handleOpenTerminal(harness.event, 'unknown'), { ok: false, code: 'NOT_FOUND' });
});

test('reports NOT_FOUND for a project without a live cwd and UNAVAILABLE without a launcher', async (t) => {
  const { ctx, terminal, launcher, event } = terminalCtx(t);
  ctx.tracker.projects.get('alpha').exists = false;
  assert.deepEqual(await terminal.handleOpenTerminal(event, 'alpha'), { ok: false, code: 'NOT_FOUND' });
  ctx.tracker.projects.get('alpha').exists = true;
  ctx.terminalLauncher = null;
  assert.deepEqual(await terminal.handleOpenTerminal(event, 'alpha'), { ok: false, code: 'UNAVAILABLE' });
  ctx.terminalLauncher = {};
  assert.deepEqual(await terminal.handleOpenTerminal(event, 'alpha'), { ok: false, code: 'UNAVAILABLE' });
  assert.equal(launcher.requests.length, 0);
});

test('single-flight: a second request while one is launching is BUSY', async (t) => {
  const { terminal, launcher, event } = terminalCtx(t);
  const pending = deferred();
  launcher.next = () => pending.promise;
  const first = terminal.handleOpenTerminal(event, 'alpha');
  assert.deepEqual(await terminal.handleOpenTerminal(event, 'alpha'), { ok: false, code: 'BUSY' });
  pending.resolve({ ok: false, code: 'FAILED' });
  assert.deepEqual(await first, { ok: false, code: 'FAILED' });

  launcher.next = null;
  assert.deepEqual(await terminal.handleOpenTerminal(event, 'alpha'), { ok: true }, 'a failure leaves no cooldown');
  assert.equal(launcher.requests.length, 2);
});

test('a successful launch starts a 750 ms cooldown', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const { terminal, launcher, event } = terminalCtx(t);
  assert.deepEqual(await terminal.handleOpenTerminal(event, 'alpha'), { ok: true });
  t.mock.timers.tick(749);
  assert.deepEqual(await terminal.handleOpenTerminal(event, 'alpha'), { ok: false, code: 'BUSY' });
  t.mock.timers.tick(1);
  assert.deepEqual(await terminal.handleOpenTerminal(event, 'alpha'), { ok: true });
  assert.equal(launcher.requests.length, 2);
});

test('launcher failures map onto the terminal failure codes and release the flight', async (t) => {
  const { terminal, launcher, event } = terminalCtx(t);
  const cases = [
    [{ ok: false, code: 'UNAVAILABLE' }, 'UNAVAILABLE'],
    [{ ok: false, code: 'NOT_A_CODE' }, 'FAILED'],
    [{ ok: false }, 'FAILED'],
    [{ ok: 'yes' }, 'FAILED'],
    [null, 'FAILED'],
  ];
  for (const [outcome, code] of cases) {
    launcher.next = () => outcome;
    assert.deepEqual(await terminal.handleOpenTerminal(event, 'alpha'), { ok: false, code });
  }
  for (const next of [() => Promise.reject(new Error('spawn failed')), () => { throw new Error('sync'); }]) {
    launcher.next = next;
    assert.deepEqual(await terminal.handleOpenTerminal(event, 'alpha'), { ok: false, code: 'FAILED' });
  }
  assert.equal(launcher.requests.length, cases.length + 2, 'no case left the launch in flight');
});

test('reset clears an in-flight launch and the cooldown', async (t) => {
  const { terminal, launcher, event } = terminalCtx(t);
  assert.deepEqual(await terminal.handleOpenTerminal(event, 'alpha'), { ok: true });
  terminal.reset();
  assert.deepEqual(await terminal.handleOpenTerminal(event, 'alpha'), { ok: true }, 'cooldown cleared');

  launcher.next = () => new Promise(() => {});
  terminal.handleOpenTerminal(event, 'alpha');
  terminal.reset();
  launcher.next = null;
  assert.deepEqual(await terminal.handleOpenTerminal(event, 'alpha'), { ok: true }, 'flight cleared');
});

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

function addSession(ctx, dir, session, provider = 'claude', extra = {}) {
  const id = provider === 'claude' ? `ship:alpha:${session}` : `ship:${provider}:${session}`;
  const ship = { id, name: session, project: 'alpha', provider, kind: 'main', ...extra };
  ctx.tracker.ships.set(id, ship);
  ctx.tracker.files ||= new Map();
  ctx.tracker.files.set(path.join(dir, `${session}.jsonl`), { project: 'alpha', session, provider });
  ctx.tracker.model = { claudeProjectsDir: path.join(dir, '.claude', 'projects') };
  return ship;
}

test('focuses the sole live session instead of opening a fresh terminal', async (t) => {
  const { ctx, terminal, launcher, dir, event } = terminalCtx(t);
  const ship = addSession(ctx, dir, 'first');
  const focused = [];
  ctx.terminalFocus = { focus: async (request) => { focused.push(request); return { ok: true }; } };
  assert.deepEqual(await terminal.handleOpenTerminal(event, 'alpha'), { ok: true });
  assert.equal(launcher.requests.length, 0);
  assert.deepEqual(focused, [{ cwd: dir, provider: 'claude', sessionId: ship.name,
    transcriptPath: path.join(dir, 'first.jsonl'), registryDirectory: path.join(dir, '.claude', 'sessions') }]);
});

test('two agents in the same project require a selection and the exact ship selects its own session', async (t) => {
  const { ctx, terminal, launcher, dir, event } = terminalCtx(t);
  addSession(ctx, dir, 'first');
  const second = addSession(ctx, dir, 'second', 'codex');
  const focused = [];
  ctx.terminalFocus = { focus: async (request) => { focused.push(request); return { ok: true }; } };
  assert.deepEqual(await terminal.handleOpenTerminal(event, 'alpha'), { ok: false, code: 'AMBIGUOUS' });
  assert.equal(focused.length, 0);
  assert.deepEqual(await terminal.handleOpenTerminal(event, second.id), { ok: true });
  assert.equal(focused[0].sessionId, 'second');
  assert.equal(focused[0].provider, 'codex');
  assert.equal(focused[0].registryDirectory, null);
  assert.equal(launcher.requests.length, 0);
});

test('a drone targets its parent session, and missing parents or sessions never open a shell', async (t) => {
  const { ctx, terminal, launcher, dir, event } = terminalCtx(t);
  const parent = addSession(ctx, dir, 'parent');
  const drone = { id: 'drone:tool-use', name: 'drone', project: 'alpha', provider: 'claude',
    kind: 'drone', parentName: parent.name };
  ctx.tracker.ships.set(drone.id, drone);
  const focused = [];
  ctx.terminalFocus = { focus: async (request) => { focused.push(request); return { ok: false, code: 'TERMINAL_NOT_FOUND' }; } };
  assert.deepEqual(await terminal.handleOpenTerminal(event, drone.id), { ok: false, code: 'TERMINAL_NOT_FOUND' });
  assert.equal(focused[0].sessionId, 'parent');
  ctx.tracker.ships.delete(parent.id);
  assert.deepEqual(await terminal.handleOpenTerminal(event, drone.id), { ok: false, code: 'TERMINAL_NOT_FOUND' });
  assert.deepEqual(await terminal.handleOpenTerminal(event, 'alpha'), { ok: false, code: 'TERMINAL_NOT_FOUND' });
  assert.equal(focused.length, 1);
  assert.equal(launcher.requests.length, 0);
});

test('a found terminal the system keeps in the background reports TERMINAL_BLOCKED, not a fresh shell', async (t) => {
  const { ctx, terminal, launcher, dir, event } = terminalCtx(t);
  const ship = addSession(ctx, dir, 'first');
  ctx.terminalFocus = { focus: async () => ({ ok: false, code: 'TERMINAL_BLOCKED' }) };
  assert.deepEqual(await terminal.handleOpenTerminal(event, ship.id), { ok: false, code: 'TERMINAL_BLOCKED' });
  assert.equal(launcher.requests.length, 0);
});

test('stale, replay, spoofed, and unsupported session targets cannot invoke a terminal', async (t) => {
  const { ctx, terminal, launcher, dir, event } = terminalCtx(t);
  const ship = addSession(ctx, dir, 'first');
  ctx.terminalFocus = { focus() { assert.fail('must not focus'); } };
  assert.deepEqual(await terminal.handleOpenTerminal(untrustedEvent(ctx.win), ship.id), { ok: false, code: 'INVALID' });
  assert.deepEqual(await terminal.handleOpenTerminal(event, { pid: 123, cwd: dir }), { ok: false, code: 'INVALID' });
  ctx.activeSource = ctx.replaySource;
  assert.deepEqual(await terminal.handleOpenTerminal(event, ship.id), { ok: false, code: 'REPLAY' });
  ctx.activeSource = ctx.tracker;
  ctx.tracker.files.clear();
  assert.deepEqual(await terminal.handleOpenTerminal(event, ship.id), { ok: false, code: 'TERMINAL_NOT_FOUND' });
  ctx.tracker.files.set('\\\\server\\share\\session.jsonl', { provider: 'claude', project: 'alpha', session: 'first' });
  assert.deepEqual(await terminal.handleOpenTerminal(event, ship.id), { ok: false, code: 'TERMINAL_NOT_FOUND' });
  ctx.tracker.ships.clear();
  assert.deepEqual(await terminal.handleOpenTerminal(event, ship.id), { ok: false, code: 'NOT_FOUND' });
  const signal = addSession(ctx, dir, 'signal', 'signal');
  assert.deepEqual(await terminal.handleOpenTerminal(event, signal.id), { ok: false, code: 'TERMINAL_NOT_FOUND' });
  assert.equal(launcher.requests.length, 0);
});

test('focus requests share the same in-flight and cooldown guard as shell launches', async (t) => {
  const { ctx, terminal, launcher, dir, event } = terminalCtx(t);
  const ship = addSession(ctx, dir, 'first');
  const pending = deferred();
  ctx.terminalFocus = { focus: () => pending.promise };
  const first = terminal.handleOpenTerminal(event, ship.id);
  assert.deepEqual(await terminal.handleOpenTerminal(event, 'alpha'), { ok: false, code: 'BUSY' });
  pending.resolve({ ok: true });
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(await terminal.handleOpenTerminal(event, ship.id), { ok: false, code: 'BUSY' });
  assert.equal(launcher.requests.length, 0);
});

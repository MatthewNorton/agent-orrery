'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTerminalFocus, registryCandidates } = require('../src/main/terminal/focus');
const { focusMacTerminal } = require('../src/main/terminal/macos');
const { tempDir } = require('./support/main-wiring');

function fixture(t) {
  const cwd = tempDir(t, 'au-terminal-focus-');
  const transcriptPath = path.join(cwd, "session & 'quote'; $(literal).jsonl");
  fs.writeFileSync(transcriptPath, '{}\n');
  const registryDirectory = path.join(cwd, 'sessions');
  fs.mkdirSync(registryDirectory);
  const session = { cwd, transcriptPath, registryDirectory, provider: 'claude', sessionId: 'exact-session' };
  return { session, record(pid, extra = {}) {
    fs.writeFileSync(path.join(registryDirectory, `${pid}.json`), JSON.stringify({
      pid, cwd, sessionId: session.sessionId, startedAt: 1_000, ...extra,
    }));
  } };
}

test('registry selection matches the exact session, project, filename and bounded metadata', (t) => {
  const { session, record } = fixture(t);
  record(41);
  record(42, { sessionId: 'different-session' });
  record(43, { cwd: path.dirname(session.cwd) });
  record(44, { pid: 99 });
  record(45, { startedAt: null });
  record(46, { extra: 'x'.repeat(17_000) });
  fs.writeFileSync(path.join(session.registryDirectory, '47.json'), '{partial');
  assert.deepEqual(registryCandidates(session, fs), [{ pid: 41, startedAt: 1_000 }]);
  assert.deepEqual(registryCandidates({ ...session, provider: 'codex' }, fs), []);
  assert.deepEqual(registryCandidates({ ...session, registryDirectory: '\\\\server\\share' }, fs), []);
});

test('Windows uses a fixed hidden helper with session data only on stdin', async (t) => {
  const { session, record } = fixture(t);
  record(41);
  const calls = [];
  const focus = createTerminalFocus({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' },
    run: async (...args) => { calls.push(args); return 'FOCUSED'; } });
  assert.deepEqual(await focus.focus(session), { ok: true });
  assert.equal(calls[0][0], 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(calls[0][1].slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-File']);
  assert.equal(path.basename(calls[0][1][4]), 'windows.ps1');
  assert.equal(calls[0][1].includes(session.transcriptPath), false);
  assert.deepEqual(JSON.parse(calls[0][2]), { transcriptPath: session.transcriptPath,
    provider: 'claude', candidates: [{ pid: 41, startedAt: 1_000 }] });
});

test('missing, blocked, ambiguous, invalid and timed-out focus results never fall back to a new terminal', async (t) => {
  const { session } = fixture(t);
  for (const [result, code] of [['NOT_FOUND', 'TERMINAL_NOT_FOUND'], ['BLOCKED', 'TERMINAL_BLOCKED'],
    ['AMBIGUOUS', 'AMBIGUOUS'], ['private error C:\\secret', 'TERMINAL_NOT_FOUND']]) {
    const focus = createTerminalFocus({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, run: async () => result });
    assert.deepEqual(await focus.focus(session), { ok: false, code });
  }
  const focus = createTerminalFocus({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' },
    run: async () => { throw new Error('private timeout'); } });
  assert.deepEqual(await focus.focus(session), { ok: false, code: 'TERMINAL_NOT_FOUND' });
  assert.deepEqual(await focus.focus({ ...session, transcriptPath: '\\\\server\\share\\x' }), { ok: false, code: 'INVALID' });
  assert.deepEqual(await focus.focus({ ...session, sessionId: '../not-a-session' }), { ok: false, code: 'INVALID' });
  fs.unlinkSync(session.transcriptPath);
  assert.deepEqual(await focus.focus(session), { ok: false, code: 'TERMINAL_NOT_FOUND' });
  const linux = createTerminalFocus({ platform: 'linux', run() { assert.fail('must not run'); } });
  assert.deepEqual(await linux.focus(session), { ok: false, code: 'UNAVAILABLE' });
});

test('macOS maps the exact transcript owner to a TTY, then selects that existing tab', async () => {
  const calls = [];
  const session = { provider: 'codex', transcriptPath: "/Users/me/Orbit ' &/session.jsonl" };
  const run = async (command, args) => {
    calls.push([command, args]);
    if (command === '/usr/sbin/lsof') return '42\n42\n77';
    if (args.includes('comm=')) return args[1] === '42' ? '/usr/local/bin/codex' : 'Electron';
    if (args.includes('tty=')) return 'ttys003';
    return 'FOCUSED';
  };
  assert.equal(await focusMacTerminal(session, [], run), 'FOCUSED');
  assert.deepEqual(calls[0], ['/usr/sbin/lsof', ['-t', '--', session.transcriptPath]]);
  assert.equal(calls.at(-1)[0], '/usr/bin/osascript');
  assert.equal(calls.at(-1)[1][1], '/dev/ttys003');
});

test('macOS rejects headless and ambiguous processes and checks registry PID reuse', async () => {
  const session = { provider: 'claude', transcriptPath: '/session.jsonl' };
  for (const tty of ['??', 'not a tty', 'ttys001']) {
    const run = async (command, args) => {
      assert.notEqual(command, '/usr/bin/osascript');
      if (args.includes('lstart=')) return 'Thu Jan 01 00:01:00 1970';
      if (command === '/usr/sbin/lsof') return '42\n43';
      if (args.includes('comm=')) return '/usr/local/bin/claude';
      return tty === 'ttys001' && args[1] === '43' ? 'ttys002' : tty;
    };
    assert.equal(await focusMacTerminal(session, [{ pid: 41, startedAt: 1_000 }], run),
      tty === 'ttys001' ? 'AMBIGUOUS' : 'NOT_FOUND');
  }
});

test('macOS does not mistake a generic Node transcript reader for a Codex agent', async () => {
  const result = await focusMacTerminal({ provider: 'codex', transcriptPath: '/rollout.jsonl' }, [],
    async (command, args) => {
      if (command === '/usr/sbin/lsof') return '42';
      assert.deepEqual(args, ['-p', '42', '-o', 'comm=']);
      return '/usr/local/bin/node';
    });
  assert.equal(result, 'NOT_FOUND');
});

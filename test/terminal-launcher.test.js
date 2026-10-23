'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  createTerminalLauncher,
  buildMacTerminalSpec,
  resolveMacOpen,
} = require('../src/main/terminal/launcher');

const MAC_CWD = "/Users/coder/Projects/Orbit & (Mission) O'Brien";

function fakeFs(present) {
  return {
    constants: { F_OK: 0 },
    accessSync(candidate) {
      if (!present.includes(candidate)) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
    },
  };
}

test('macOS spec opens Terminal through the fixed system launcher with one opaque cwd', () => {
  const spec = buildMacTerminalSpec({ cwd: MAC_CWD });
  assert.deepEqual(spec, {
    command: '/usr/bin/open',
    args: ['-a', 'Terminal', MAC_CWD],
    options: { cwd: MAC_CWD, shell: false, detached: true, stdio: 'ignore', windowsHide: false },
  });
  for (const cwd of ['relative', '', '/Users/coder/../root', 'C:\\Windows', null]) {
    assert.throws(() => buildMacTerminalSpec({ cwd }), (error) => error.code === 'INVALID');
  }
});

test('macOS launcher spawns exactly once, unrefs, and reports a bounded result', async () => {
  const calls = [];
  const child = new EventEmitter();
  let unrefCount = 0;
  child.unref = () => { unrefCount += 1; };
  const launcher = createTerminalLauncher({
    platform: 'darwin',
    env: {},
    fsImpl: fakeFs(['/usr/bin/open']),
    spawnImpl(command, args, options) {
      calls.push({ command, args, options });
      return child;
    },
  });
  const result = await launcher.open({ cwd: MAC_CWD });
  assert.deepEqual(result, { ok: true, terminal: 'macos-terminal' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '/usr/bin/open');
  assert.deepEqual(calls[0].args, ['-a', 'Terminal', MAC_CWD]);
  assert.equal(unrefCount, 1);
  assert.equal(child.listenerCount('exit'), 0);
});

test('macOS launcher fails closed without the system launcher or with a bad cwd', async () => {
  let spawned = 0;
  const launcher = createTerminalLauncher({
    platform: 'darwin', env: {}, fsImpl: fakeFs([]), spawnImpl() { spawned += 1; return null; },
  });
  assert.deepEqual(await launcher.open({ cwd: MAC_CWD }), { ok: false, code: 'UNAVAILABLE' });
  assert.deepEqual(await launcher.open({ cwd: 'C:\\Work' }), { ok: false, code: 'INVALID' });
  assert.equal(spawned, 0);
  assert.throws(() => resolveMacOpen({ fsImpl: fakeFs([]) }), (error) => error.code === 'UNAVAILABLE');
});

test('Linux stays unavailable and never probes the filesystem', async () => {
  let probes = 0;
  const launcher = createTerminalLauncher({
    platform: 'linux',
    env: {},
    fsImpl: { constants: { F_OK: 0 }, accessSync() { probes += 1; } },
    spawnImpl() { throw new Error('must not spawn'); },
  });
  assert.deepEqual(await launcher.open({ cwd: MAC_CWD }), { ok: false, code: 'UNAVAILABLE' });
  assert.deepEqual(await launcher.open({ cwd: 'C:\\Work' }), { ok: false, code: 'UNAVAILABLE' });
  assert.equal(probes, 0);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { runBoundedProcess } = require('../src/main/shared/bounded-process');

const SPEC = Object.freeze({ command: 'tool', args: Object.freeze(['--flag']), options: Object.freeze({}) });

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kills = [];
  child.kill = (signal) => { child.kills.push(signal); return true; };
  return child;
}

function limits(overrides = {}) {
  return {
    spawnImpl: () => fakeChild(),
    timeoutMs: 1_000,
    maxOutputBytes: 16,
    unavailableCode: 'TOOL_UNAVAILABLE',
    onClose: (result) => ({ ok: result.exitCode === 0, ...result }),
    ...overrides,
  };
}

test('passes the spec to spawn and maps the close through onClose', async () => {
  const child = fakeChild();
  let captured = null;
  const result = await runBoundedProcess(SPEC, limits({
    spawnImpl(command, args, options) {
      captured = { command, args, options };
      process.nextTick(() => {
        child.stdout.emit('data', 'out');
        child.stderr.emit('data', Buffer.from('err'));
        child.stdout.emit('data', null);
        child.emit('close', 3, 'SIGTERM');
      });
      return child;
    },
  }));

  assert.deepEqual(captured, { command: 'tool', args: SPEC.args, options: SPEC.options });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 3);
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(result.stdout.toString(), 'out');
  assert.equal(result.stderr.toString(), 'err');
  assert.deepEqual(child.kills, []);
});

test('reports the unavailable code when spawn throws, returns a bad child, or errors', async () => {
  const thrown = await runBoundedProcess(SPEC, limits({ spawnImpl() { throw new Error('ENOENT'); } }));
  assert.deepEqual(thrown, { ok: false, code: 'TOOL_UNAVAILABLE' });

  for (const bad of [null, {}, { stdout: { on() {} }, stderr: { on() {} } }]) {
    assert.deepEqual(await runBoundedProcess(SPEC, limits({ spawnImpl: () => bad })), {
      ok: false, code: 'TOOL_UNAVAILABLE',
    });
  }

  const child = fakeChild();
  const errored = await runBoundedProcess(SPEC, limits({
    spawnImpl() {
      process.nextTick(() => {
        child.emit('error', new Error('spawn failed'));
        child.emit('close', 0, null);
      });
      return child;
    },
  }));
  assert.deepEqual(errored, { ok: false, code: 'TOOL_UNAVAILABLE' });
});

test('kills the child once combined output passes the cap and ignores later output', async () => {
  const child = fakeChild();
  let closed = 0;
  const result = await runBoundedProcess(SPEC, limits({
    onClose() { closed++; return { ok: true }; },
    spawnImpl() {
      process.nextTick(() => {
        child.stdout.emit('data', Buffer.alloc(10));
        child.stderr.emit('data', Buffer.alloc(7));
        child.stdout.emit('data', Buffer.alloc(1));
      });
      return child;
    },
  }));

  assert.deepEqual(result, { ok: false, code: 'OUTPUT_LIMIT' });
  assert.deepEqual(child.kills, ['SIGKILL']);
  assert.equal(closed, 0);
});

test('output exactly at the cap is kept', async () => {
  const child = fakeChild();
  const result = await runBoundedProcess(SPEC, limits({
    spawnImpl() {
      process.nextTick(() => {
        child.stdout.emit('data', Buffer.alloc(16, 0x61));
        child.emit('close', 0, null);
      });
      return child;
    },
  }));
  assert.equal(result.ok, true);
  assert.equal(result.stdout.length, 16);
});

test('kills the child on timeout even when kill throws, and a later close changes nothing', async () => {
  const child = fakeChild();
  child.kill = () => { throw new Error('already exited'); };
  // The runner unrefs its timer; hold the event loop open until it fires.
  const keepAlive = setTimeout(() => {}, 1_000);
  const result = await runBoundedProcess(SPEC, limits({
    timeoutMs: 5,
    spawnImpl: () => child,
  }));
  clearTimeout(keepAlive);
  assert.deepEqual(result, { ok: false, code: 'TIMEOUT' });
  child.emit('close', 0, null);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { runHelper } = require('../src/main/terminal/process');

function helper() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kills = 0;
  child.kill = () => { child.kills++; };
  return child;
}

test('native helpers run hidden without a shell and receive opaque input', async () => {
  const child = helper();
  let options;
  const result = runHelper('fixed-helper', ['fixed-script'], "untrusted '; $()", 1000,
    (_command, _args, opts) => { options = opts; return child; });
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  assert.equal(child.stdin.read().toString(), "untrusted '; $()");
  child.stdout.write('FOCUSED\n');
  child.emit('close', 0);
  assert.equal(await result, 'FOCUSED');
  assert.equal(child.kills, 0);
});

test('helper deadlines and excess output stop only the app-owned helper', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hung = helper();
  const timeout = runHelper('fixed-helper', [], '', 1000, () => hung);
  const rejected = assert.rejects(timeout, /timed out/);
  t.mock.timers.tick(1000);
  await rejected;
  assert.equal(hung.kills, 1);

  const noisy = helper();
  const output = runHelper('fixed-helper', [], '', 1000, () => noisy);
  const limited = assert.rejects(output, /output limit/);
  noisy.stdout.write('x'.repeat(16385));
  await limited;
  assert.equal(noisy.kills, 1);
});

test('spawn and stdin failures reject rather than reporting focus success', async () => {
  for (const stream of ['process', 'stdin']) {
    const child = helper();
    const result = runHelper('fixed-helper', [], '', 1000, () => child);
    const failed = assert.rejects(result, /failed/);
    (stream === 'stdin' ? child.stdin : child).emit('error', new Error('failed'));
    await failed;
    assert.equal(child.kills, stream === 'stdin' ? 1 : 0);
  }
});

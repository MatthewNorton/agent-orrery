'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readFlags } = require('../src/main/flags');

const ROOT = path.resolve(__dirname, '..');
const ARGV0 = ['electron', '.'];

test('plain launch sets no test mode and defaults every output under .shots', () => {
  const flags = readFlags(ARGV0);
  assert.deepEqual(flags, {
    shots: false,
    polishTest: false,
    providerTest: false,
    historyTest: false,
    controlTest: false,
    testMode: false,
    outputs: {
      polish: path.join(ROOT, '.shots', 'polish'),
      provider: path.join(ROOT, '.shots', 'providers'),
      history: path.join(ROOT, '.shots', 'history'),
      control: path.join(ROOT, '.shots', 'control'),
    },
  });
});

test('each harness flag sets its own key and test mode, and nothing else', () => {
  const cases = [
    ['--shots', 'shots'],
    ['--polish-test', 'polishTest'],
    ['--provider-test', 'providerTest'],
    ['--history-test', 'historyTest'],
    ['--control-test', 'controlTest'],
  ];
  for (const [arg, key] of cases) {
    const flags = readFlags([...ARGV0, arg]);
    assert.equal(flags.testMode, true, arg);
    for (const [, other] of cases) assert.equal(flags[other], other === key, `${arg} -> ${other}`);
  }
});

test('flags match whole arguments only', () => {
  const flags = readFlags([...ARGV0, '--shots=1', '--control-tests', 'history-test']);
  assert.equal(flags.testMode, false);
  assert.equal(flags.shots, false);
  assert.equal(flags.controlTest, false);
  assert.equal(flags.historyTest, false);
});

test('output overrides resolve against the working directory', () => {
  const absolute = [ROOT, 'out', '..', 'abs-control'].join(path.sep);
  const flags = readFlags([
    ...ARGV0,
    `--polish-output=${path.join('rel', 'polish')}`,
    `--provider-output=${path.join('rel', 'providers')}`,
    `--history-output=${path.join('rel', 'history')}`,
    `--control-output=${absolute}`,
  ]);
  assert.equal(flags.testMode, false, 'an output path alone does not enter a test mode');
  assert.deepEqual(flags.outputs, {
    polish: path.resolve('rel', 'polish'),
    provider: path.resolve('rel', 'providers'),
    history: path.resolve('rel', 'history'),
    control: path.join(ROOT, 'abs-control'),
  });
});

test('the flags object and its outputs are frozen', () => {
  const flags = readFlags([...ARGV0, '--shots']);
  assert.ok(Object.isFrozen(flags));
  assert.ok(Object.isFrozen(flags.outputs));
  assert.throws(() => { flags.shots = false; }, TypeError);
  assert.throws(() => { flags.outputs.polish = 'elsewhere'; }, TypeError);
});

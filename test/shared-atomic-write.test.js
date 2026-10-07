'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeFileAtomic } = require('../src/main/shared/atomic-write');

function withTempDir(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-universe-atomic-write-'));
  try {
    return run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function failing(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

test('creates or replaces the target and leaves no temp file', () => {
  withTempDir((directory) => {
    const target = path.join(directory, 'state.json');
    writeFileAtomic(target, 'first');
    writeFileAtomic(target, 'sécond');
    assert.equal(fs.readFileSync(target, 'utf8'), 'sécond');
    assert.deepEqual(fs.readdirSync(directory), ['state.json']);
  });
});

test('writes an exclusive UTF-8 temp file beside the target, then renames it', () => {
  withTempDir((directory) => {
    const target = path.join(directory, 'GOALS.md');
    const calls = [];
    const fsImpl = {
      ...fs,
      writeFileSync(file, text, options) { calls.push(['write', file, options]); return fs.writeFileSync(file, text, options); },
      renameSync(from, to) { calls.push(['rename', from, to]); return fs.renameSync(from, to); },
      unlinkSync(file) { calls.push(['unlink', file]); return fs.unlinkSync(file); },
    };
    writeFileAtomic(target, 'text', { fsImpl });

    const temp = calls[0][1];
    assert.equal(path.dirname(temp), directory);
    assert.match(path.basename(temp), new RegExp(`^\\.GOALS\\.md\\.${process.pid}\\.\\d+\\.[0-9a-f]+\\.tmp$`));
    assert.deepEqual(calls, [
      ['write', temp, { encoding: 'utf8', flag: 'wx' }],
      ['rename', temp, target],
      ['unlink', temp],
    ]);
  });
});

test('beforeRename can abandon the write; the target and directory stay unchanged', () => {
  withTempDir((directory) => {
    const target = path.join(directory, 'GOALS.md');
    fs.writeFileSync(target, 'original');
    let tempSeen = null;
    assert.throws(() => writeFileAtomic(target, 'next', {
      beforeRename() {
        tempSeen = fs.readdirSync(directory).filter((name) => name.endsWith('.tmp'));
        throw new Error('changed underneath');
      },
    }), /changed underneath/);
    assert.equal(tempSeen.length, 1);
    assert.equal(fs.readFileSync(target, 'utf8'), 'original');
    assert.deepEqual(fs.readdirSync(directory), ['GOALS.md']);
  });
});

test('a failed rename removes the temp file and rethrows', () => {
  withTempDir((directory) => {
    const target = path.join(directory, 'state.json');
    fs.writeFileSync(target, 'original');
    const fsImpl = { ...fs, renameSync() { throw failing('EIO', 'simulated rename failure'); } };
    assert.throws(() => writeFileAtomic(target, 'next', { fsImpl }), /simulated rename failure/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'original');
    assert.deepEqual(fs.readdirSync(directory), ['state.json']);
  });
});

test('a failed temp write is rethrown and the missing temp file is ignored', () => {
  withTempDir((directory) => {
    const target = path.join(directory, 'state.json');
    const fsImpl = { ...fs, writeFileSync() { throw failing('ENOSPC', 'disk full'); } };
    assert.throws(() => writeFileAtomic(target, 'next', { fsImpl }), /disk full/);
    assert.deepEqual(fs.readdirSync(directory), []);
  });
});

test('a cleanup failure other than ENOENT surfaces instead of being swallowed', () => {
  withTempDir((directory) => {
    const target = path.join(directory, 'state.json');
    const fsImpl = { ...fs, unlinkSync() { throw failing('EPERM', 'cleanup denied'); } };
    assert.throws(() => writeFileAtomic(target, 'next', { fsImpl }), /cleanup denied/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'next');
  });
});

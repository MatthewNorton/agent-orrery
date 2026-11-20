'use strict';

// src/main/harness/asar-check.js: the shots run's check of what the main process's fs makes of a
// file named *.asar (kit/grade.mjs M7). Node's fs has no asar handling, so it passes here; a
// stand-in that behaves as Electron's does with asar handling on must fail each step.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { asarCheck, validArchive } = require('../src/main/harness/asar-check');

test('asar check: plain files, read and deleted, and the temporary folder it made goes, by an rm that tries again while it is held', async (t) => {
  const mkdtemp = t.mock.method(fs.promises, 'mkdtemp');
  const rm = t.mock.method(fs.promises, 'rm');
  assert.deepEqual(await asarCheck(), { lstatFile: true, direntFile: true, deleted: true, errors: [] });
  const made = await Promise.all(mkdtemp.mock.calls.map((call) => call.result));
  assert.deepEqual(rm.mock.calls.map((call) => call.arguments[0]), made, 'the folder it made, and no other');
  assert.deepEqual([made.length, path.basename(made[0]).startsWith('agent-orrery-asar-'), fs.existsSync(made[0])], [1, true, false]);
  assert.deepEqual(rm.mock.calls[0].arguments[1], { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
});

test('asar check: a temporary folder it cannot make fails every answer, and the check answers all the same', async () => {
  const result = await asarCheck({
    ...fs.promises,
    mkdtemp: async () => { throw Object.assign(new Error('ENOENT: no such file or directory, mkdtemp'), { code: 'ENOENT' }); },
  });
  assert.deepEqual(result, { lstatFile: false, direntFile: false, deleted: false, errors: ['mkdtemp: ENOENT: no such file or directory, mkdtemp'] });
});

// fs.promises whose rename and unlink fail for each file as `fails` says ({ call: [code, times] }), then
// go through; each error names its try, and `tried` lists the calls.
function holding(fails) {
  const tried = [], counts = new Map();
  const call = (name) => async (target, ...rest) => {
    tried.push(name);
    const [code, times] = fails[name] || [null, 0];
    const n = counts.get(name + target) ?? 0;
    counts.set(name + target, n + 1);
    if (n < times) throw Object.assign(new Error(`${code}: ${name} '${path.basename(target)}', try ${n + 1}`), { code });
    return fs.promises[name](target, ...rest);
  };
  return { tried, files: { ...fs.promises, rename: call('rename'), unlink: call('unlink') } };
}

test('asar check: a rename or delete held for a moment is tried again, five tries at most and only while held', async () => {
  let waits = 0;
  const options = { wait: async () => { waits++; } };
  const brief = holding({ rename: ['EPERM', 2], unlink: ['EBUSY', 2] });
  assert.deepEqual(await asarCheck(brief.files, options), { lstatFile: true, direntFile: true, deleted: true, errors: [] });
  assert.deepEqual([brief.tried.length, waits], [12, 8], 'two renames and two deletes, three tries each');
  waits = 0;
  const long = holding({ unlink: ['EACCES', 9] });
  const kept = await asarCheck(long.files, options);
  assert.deepEqual([kept.deleted, kept.errors, long.tried.filter((name) => name === 'unlink').length, waits],
    [false, ["delete: EACCES: unlink 'malformed.asar', try 5"], 5, 4], 'the last try\'s error');
  waits = 0;
  const gone = holding({ unlink: ['ENOENT', 1] });
  assert.deepEqual([(await asarCheck(gone.files, options)).errors, waits], [["delete: ENOENT: unlink 'malformed.asar', try 1"], 0]);
});

test('asar check: an fs that opens archives fails every step it gets wrong, and cleans up all the same', async (t) => {
  // As Electron 45's fs with asar handling on (measured): it cannot write a file named *.asar,
  // lstat throws for a malformed archive and calls a valid one a folder, readdir's types say file
  // regardless, and an opened archive stays open.
  const opened = new Set();
  const electron = {
    ...fs.promises,
    async writeFile(file, bytes) {
      if (file.endsWith('.asar')) throw new Error(`Invalid package ${file}`);
      return fs.promises.writeFile(file, bytes);
    },
    async lstat(file) {
      const bytes = fs.readFileSync(file);
      if (!bytes.equals(validArchive())) throw new Error(`Invalid package ${file}`);
      opened.add(file);
      return { isFile: () => false };
    },
    async unlink(file) {
      if (opened.has(file)) throw Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${file}'`), { code: 'EBUSY' });
      return fs.promises.unlink(file);
    },
  };
  const rm = t.mock.method(electron, 'rm');
  const result = await asarCheck(electron, { wait: async () => {} });
  assert.deepEqual([result.lstatFile, result.direntFile, result.deleted], [false, true, false]);
  assert.deepEqual(result.errors.map((error) => error.split(':')[0]), ['lstat', 'delete'], 'the archives were written, then read');
  const [dir] = rm.mock.calls[0].arguments;
  assert.deepEqual([fs.existsSync(dir), [...opened].some((file) => fs.existsSync(file))], [false, false], 'the valid archive went with the folder');
});

test('asar check: a temporary folder it cannot remove is named in its errors', async () => {
  // As on Windows with asar handling on, where the archive the fs opened keeps the folder.
  let kept = null;
  const result = await asarCheck({
    ...fs.promises,
    async rm(dir) {
      kept = dir;
      throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${dir}'`), { code: 'EBUSY' });
    },
  });
  try {
    assert.ok(kept, 'the check removes its folder through the fs it checks');
    assert.deepEqual([result.lstatFile, result.direntFile, result.deleted], [true, true, true]);
    assert.deepEqual(result.errors, [`cleanup: ${kept} stays: EBUSY: resource busy or locked, rmdir '${kept}'`]);
  } finally {
    if (kept) fs.rmSync(kept, { recursive: true, force: true });
  }
});

test('asar check: an archive that lstat or readdir calls a folder is no plain file', async () => {
  const folder = (entry) => ({ name: entry.name, isFile: () => false });
  const result = await asarCheck({
    ...fs.promises,
    lstat: async () => ({ isFile: () => false }),
    readdir: async (dir, options) => (options ? (await fs.promises.readdir(dir, options)).map(folder) : fs.promises.readdir(dir)),
  });
  assert.deepEqual(result, { lstatFile: false, direntFile: false, deleted: true, errors: [] });
});

test('asar check: the valid archive is one Electron could open: its header pickles name a.txt', () => {
  const bytes = validArchive();
  const headerSize = bytes.readUInt32LE(4);
  const indexLength = bytes.readInt32LE(12);
  const index = JSON.parse(bytes.subarray(16, 16 + indexLength).toString('utf8'));
  assert.deepEqual([bytes.readUInt32LE(0), bytes.readUInt32LE(8), headerSize % 4], [4, headerSize - 4, 0]);
  assert.deepEqual(index, { files: { 'a.txt': { size: 5, offset: '0' } } });
  assert.equal(bytes.subarray(8 + headerSize).toString(), 'hello');
});

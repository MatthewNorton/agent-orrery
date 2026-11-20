'use strict';

// src/main/harness/asar-check.js: the shots run's check of what the main process's fs makes of a
// file named *.asar (kit/grade.mjs M7). Node's fs has no asar handling, so it passes here; a
// stand-in that behaves as Electron's does with asar handling on must fail each step.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { asarCheck, validArchive } = require('../src/main/harness/asar-check');

const leftovers = () => fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('agent-orrery-asar-'));

test('asar check: plain files, read and deleted, and the temporary folder goes', async () => {
  const before = leftovers();
  assert.deepEqual(await asarCheck(), { lstatFile: true, direntFile: true, deleted: true, errors: [] });
  assert.deepEqual(leftovers(), before);
});

test('asar check: an fs that opens archives fails every step it gets wrong, and still cleans up', async () => {
  // As Electron 45's fs with asar handling on (measured): it cannot write a file named *.asar,
  // lstat throws for a malformed archive and calls a valid one a folder, readdir's types still say
  // file, and an opened archive stays open.
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
  const before = leftovers();
  const result = await asarCheck(electron);
  assert.deepEqual([result.lstatFile, result.direntFile, result.deleted], [false, true, false]);
  assert.deepEqual(result.errors.map((error) => error.split(':')[0]), ['lstat', 'delete'], 'the archives were written, then read');
  assert.deepEqual(leftovers(), before);
  for (const file of opened) assert.equal(fs.existsSync(file), false, 'the valid archive went with the folder');
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

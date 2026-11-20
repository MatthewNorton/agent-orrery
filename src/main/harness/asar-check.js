// @ts-check
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const driver = require('./driver');

// What the main process's fs makes of a file named *.asar in a folder it reads (kit/grade.mjs M7).
// With Electron's asar handling off (process.noAsar, main.js), a malformed archive and a valid one
// both read as the plain files they are, by lstat and by readdir's types, and both can be deleted
// straight after, since nothing holds them open. With it on, lstat throws for the malformed one and
// calls the valid one a folder, and the archive it opened stays open (Electron 45, measured).

// The smallest archive Electron's asar reader accepts: a size pickle, then a header pickle that
// holds the JSON index, then the one file's bytes.
function validArchive() {
  const content = Buffer.from('hello');
  const index = Buffer.from(JSON.stringify({ files: { 'a.txt': { size: content.length, offset: '0' } } }));
  const header = Buffer.alloc(8 + Math.ceil(index.length / 4) * 4);
  header.writeUInt32LE(header.length - 4, 0);
  header.writeInt32LE(index.length, 4);
  index.copy(header, 8);
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0);
  size.writeUInt32LE(header.length, 4);
  return Buffer.concat([size, header, content]);
}

// The codes Windows gives for a file that another process (a virus scanner, the search indexer)
// holds for a moment after it was written.
const HELD = new Set(['EPERM', 'EBUSY', 'EACCES']);
const HELD_TRIES = 5, HELD_WAIT_MS = 100;

/**
 * Writes both archives into a new temporary folder, reads them back and deletes them. Each is
 * written under another name and renamed, since with asar handling on the fs takes a new file's
 * *.asar name for an archive to open and cannot write it. A rename or delete is tried again while
 * the file is held (HELD), HELD_TRIES tries in all. The folder's removal goes by rm's own retries,
 * on rm's own codes and with a longer wait each time. Each answer is false when its step threw,
 * every one when the folder could not be made; `errors` holds what each step threw, and names the
 * folder when it cannot be removed (an archive held open keeps it). It never rejects.
 * @param {typeof fs.promises} [files] the fs to check, Electron's own by default
 * @param {{ wait?: (ms: number) => Promise<unknown> } | null} [options] how it waits between tries;
 *   null is none
 * @returns {Promise<{ lstatFile: boolean, direntFile: boolean, deleted: boolean, errors: string[] }>}
 */
async function asarCheck(files = fs.promises, options = {}) {
  const { wait = driver.wait } = options || {};
  /** @type {string[]} */
  const errors = [];
  // What a step threw, as text: String() takes any value, and whatever cannot be read is said so.
  const describe = (/** @type {any} */ error) => {
    try { return String(error && error.message); } catch { return 'an error with no readable text'; }
  };
  /** @template T @param {string} name @param {() => Promise<T>} step @returns {Promise<T | false>} */
  const run = async (name, step) => {
    try { return await step(); } catch (error) { errors.push(`${name}: ${describe(error)}`); return false; }
  };
  /** @template T @param {() => Promise<T>} call @returns {Promise<T>} */
  const held = async (call) => {
    for (let tried = 1; ; tried++) {
      try {
        return await call();
      } catch (error) {
        if (tried >= HELD_TRIES || !HELD.has(error && error.code)) throw error;
        await wait(HELD_WAIT_MS);
      }
    }
  };
  const dir = await run('mkdtemp', () => files.mkdtemp(path.join(os.tmpdir(), 'agent-orrery-asar-')));
  if (dir === false) return { lstatFile: false, direntFile: false, deleted: false, errors };
  const archives = { 'malformed.asar': Buffer.from('not an archive'), 'valid.asar': validArchive() };
  const names = Object.keys(archives);
  const at = (name) => path.join(dir, name);
  await run('write', async () => {
    for (const name of names) {
      await files.writeFile(at(name + '.part'), archives[name]);
      await held(() => files.rename(at(name + '.part'), at(name)));
    }
    return true;
  });
  const lstatFile = await run('lstat', async () => {
    const stats = await Promise.all(names.map((name) => files.lstat(at(name))));
    return stats.every((stat) => stat.isFile());
  });
  const direntFile = await run('readdir', async () => {
    const entries = await files.readdir(dir, { withFileTypes: true });
    return names.every((name) => entries.some((entry) => entry.name === name && entry.isFile()));
  });
  const deleted = await run('delete', async () => {
    for (const name of names) await held(() => files.unlink(at(name)));
    return (await files.readdir(dir)).length === 0;
  });
  const removal = { recursive: true, force: true, maxRetries: HELD_TRIES - 1, retryDelay: HELD_WAIT_MS };
  await run(`cleanup: ${String(dir)} stays`, () => files.rm(dir, removal));
  return { lstatFile, direntFile, deleted, errors };
}

module.exports = { asarCheck, validArchive };

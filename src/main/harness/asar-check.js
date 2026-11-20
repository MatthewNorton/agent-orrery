// @ts-check
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// What the main process's fs makes of a file named *.asar in a folder it reads (kit/grade.mjs M7).
// With Electron's asar handling off (process.noAsar, main.js), a malformed archive and a valid one
// both read as the plain files they are, by lstat and by readdir's types, and both can be deleted
// straight after, since nothing holds them open. With it on, lstat throws for the malformed one and
// calls the valid one a folder, and the archive it opened stays open.

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

/**
 * Writes both archives into a new temporary folder, reads them back and deletes them. Each answer
 * is false when its step threw; `errors` holds what each step threw.
 * @param {typeof fs.promises} [files] the fs to check, Electron's own by default
 * @returns {Promise<{ lstatFile: boolean, direntFile: boolean, deleted: boolean, errors: string[] }>}
 */
async function asarCheck(files = fs.promises) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-orrery-asar-'));
  const archives = { 'malformed.asar': Buffer.from('not an archive'), 'valid.asar': validArchive() };
  const names = Object.keys(archives);
  const at = (name) => path.join(dir, name);
  /** @type {string[]} */
  const errors = [];
  /** @param {string} name @param {() => Promise<boolean>} step */
  const run = async (name, step) => {
    try { return await step(); } catch (error) { errors.push(`${name}: ${error && error.message}`); return false; }
  };
  try {
    await run('write', async () => {
      for (const name of names) await files.writeFile(at(name), archives[name]);
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
      for (const name of names) await files.unlink(at(name));
      return (await files.readdir(dir)).length === 0;
    });
    return { lstatFile, direntFile, deleted, errors };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { asarCheck, validArchive };

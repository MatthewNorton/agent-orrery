'use strict';

// Project folders on disk for the system view tests, and watches on the folder reads a planet makes.

const fs = require('node:fs');
const path = require('node:path');
const { liveProject, tempDir } = require('./main-wiring');

// `files` are written; a path ending in '/' is an empty folder.
function projectOnDisk(t, files, buckets = {}) {
  const root = tempDir(t, 'au-live-system-');
  for (const rel of files) {
    if (rel.endsWith('/')) { fs.mkdirSync(path.join(root, rel), { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), 'x');
  }
  const project = liveProject('p', root, { totalBytes: 0, buckets, totalBuilds: 0, firstSeen: 0 });
  const model = { projects: new Map([['p', project]]), systemCache: new Map() };
  return { root, project, model };
}

// Watches the folder reads a planet makes (fs.promises.readdir): `before(dir, options)` runs ahead
// of each and may throw in its place, `entries(list, options)` changes what one answers. Returns
// every folder a read was asked for.
function spyReaddir(t, { before = () => {}, entries = (list) => list } = {}) {
  const readdir = fs.promises.readdir;
  const dirs = [];
  t.mock.method(fs.promises, 'readdir', async (dir, options) => {
    dirs.push(String(dir));
    before(String(dir), options);
    return entries(await readdir.call(fs.promises, dir, options), options);
  });
  return dirs;
}

// Fails the folder reads `refuse` picks, counting them, with an error of `code`. `seen.dirs` is
// every folder a read was asked for.
function refuseReads(t, refuse, code = 'EACCES') {
  const seen = { tried: 0, dirs: [] };
  seen.dirs = spyReaddir(t, { before: (dir) => {
    if (!refuse(dir)) return;
    seen.tried++;
    throw Object.assign(new Error(code), { code });
  } });
  return seen;
}

// A link to `target` at `link`: a junction on Windows, which needs no privilege.
const linkTo = (target, link) => fs.symlinkSync(target, link, 'junction');

// A folder outside every project, holding `files` of 2 KB each.
function outsideFolder(t, files) {
  const outside = path.join(tempDir(t, 'au-live-outside-'), 'secrets');
  fs.mkdirSync(path.join(outside, 'deep'), { recursive: true });
  for (const file of files) fs.writeFileSync(path.join(outside, file), 'x'.repeat(2048));
  return outside;
}

module.exports = { linkTo, outsideFolder, projectOnDisk, refuseReads, spyReaddir };

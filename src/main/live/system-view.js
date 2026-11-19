// @ts-check
'use strict';

// The system and planet views of a live project, read from the project folder on disk.

const fs = require('fs');
const path = require('path');
const { fnv1a, mulberry32 } = require('../shared/hash');
const { ignoresCase, relativeInside } = require('../path-safety');
const { bucketBuilds, bucketFor, matchingName, planetKey } = require('../build-buckets');
const { isStandInName, proceduralSystem, systemData } = require('../universe/planets');
const { liveProject } = require('../universe/public-shape');

/**
 * @import { PlanetData, SystemData } from '../../types/contract'
 * @import { LiveModel } from '../../types/live-model'
 * @typedef {Pick<PlanetData, 'files' | 'sizeKb' | 'subdirs' | 'resources' | 'folderRead'>} FolderRead
 */

const SYSTEM_CACHE_MS = 30000;
// A planet's folder read: its limits, and how many folders left unread are looked into for a file.
const READ_FILES = 600, READ_FOLDERS = 300, READ_LEVELS = 5, READ_PEEKS = 100;
const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.next', '.venv', 'venv', 'dist', 'build', 'out',
  'release', 'coverage', 'target', '__pycache__', '.idea', '.vscode', 'bin', 'obj',
]);
const ignored = (/** @type {string} */ name) => IGNORE_DIRS.has(name) || name.startsWith('.');
// A project without a folder has stand-in planets only; a folder that is not read has no counts.
const NO_FOLDER = { name: null, read: null, standIn: true };
/** @type {FolderRead} */
const UNREAD = { files: 0, sizeKb: 0, subdirs: 0, resources: [], folderRead: 'none' };

// Planets = top-level directories of the real project on disk, sized by a
// shallow file count, enriched by accumulated build counts. Missing paths
// (deleted/temp projects) get deterministic procedural planets instead.
/**
 * @param {LiveModel} model
 * @param {string} projectId
 * @returns {SystemData | null}
 */
function getSystem(model, projectId) {
  const project = model.projects.get(projectId);
  if (!project) return null;
  const cached = model.systemCache.get(projectId);
  if (cached && Date.now() - cached.at < SYSTEM_CACHE_MS) return cached.data;

  let planets = [];
  let beltDensity = 0;
  if (project.path && project.exists) {
    try {
      const entries = fs.readdirSync(project.path, { withFileTypes: true });
      beltDensity = entries.filter((e) => e.isFile()).length;
      const dirs = entries.filter((e) => e.isDirectory() && !ignored(e.name));
      planets = dirs.map((d) => ({
        name: d.name,
        files: shallowCount(path.join(project.path, d.name)),
        builds: bucketBuilds(project, d.name),
      }));
      if (project.buckets['(root)']) {
        planets.push({ name: '(root)', files: beltDensity, builds: project.buckets['(root)'] });
      }
      planets.sort((a, b) => b.files + b.builds * 5 - (a.files + a.builds * 5));
    } catch { /* fall through to procedural */ }
  }
  if (planets.length === 0) ({ planets, beltDensity } = proceduralSystem(projectId));
  const data = systemData(liveProject(project), planets, beltDensity);
  model.systemCache.set(projectId, { at: Date.now(), data });
  return data;
}

// Planet close-up stats: a folder's files, size and subfolders, read from disk off the main loop.
/**
 * @param {LiveModel} model
 * @param {string} projectId
 * @param {string} planetName
 * @returns {Promise<PlanetData | null>}
 */
async function getPlanet(model, projectId, planetName) {
  const project = model.projects.get(projectId);
  if (!project) return null;
  const folderOf = () => (project.path && project.exists ? project.path : null);
  const projectPath = folderOf();
  const root = planetName === '(root)';
  // Security: planetName arrives over IPC. Only a single plain directory segment
  // is a planet; anything with separators or dot-segments could walk outside the project.
  if (projectPath && !root && !isPlanetSegment(planetName)) return null;
  const folder = projectPath ? await readPlanet(projectPath, planetName, root) : NO_FOLDER;
  if (!folder) return null;
  // Everything the answer takes from the project is read from here on, after the disk: the
  // renderer counts builds onto a planet only once it has this answer, so one counted during the
  // read has to be in it. A project forgotten meanwhile has no planets; one whose folder changed
  // is read again.
  if (model.projects.get(projectId) !== project) return null;
  if (folderOf() !== projectPath) return getPlanet(model, projectId, planetName);
  // Security follow-up: own keys only; 'constructor'/'__proto__' must not return a non-cloneable prototype value.
  const bucket = bucketFor(project, planetName);
  /** @param {string} name */
  const base = (name) => ({ name, key: planetKey(project, name), project: liveProject(project), builds: bucket.builds });
  // A stand-in has no folder and no builds. Its numbers are invented; the same project and name
  // always get the same ones. With no folder to name it, it answers to its bucket's key.
  if (!folder.read || (folder.standIn && bucket.key === null)) {
    const rand = mulberry32(fnv1a(projectId + bucket.name));
    return { ...base(bucket.name), files: Math.floor(rand() * 200), sizeKb: Math.floor(rand() * 4000), subdirs: Math.floor(rand() * 9), resources: ['Unknown'], procedural: true };
  }
  return { ...base(folder.name ?? bucket.name), ...folder.read };
}

/**
 * What the disk has of a planet, which reads nothing of the model: the name its folder is
 * spelled by (null when the project folder lists none such), its counts, and whether a planet
 * with no builds and a stand-in's name would be one. Null when the name leads out of the project.
 * @param {string} projectPath
 * @param {string} planetName
 * @param {boolean} root
 * @returns {Promise<{ name: string | null, read: FolderRead, standIn: boolean } | null>}
 */
async function readPlanet(projectPath, planetName, root) {
  if (root) return { name: planetName, read: await readFolder(projectPath, true), standIn: false };
  const name = await diskName(projectPath, planetName);
  const dir = path.join(projectPath, name ?? planetName);
  if (relativeInside(projectPath, dir) === null) return null;
  // Security: a planet is a folder of the project. A link there (on Windows a junction too) leads
  // out of it, to any folder or a network share, so what is behind one is not listed.
  const linked = await fs.promises.lstat(dir).then((stat) => stat.isSymbolicLink(), () => false);
  const read = linked ? UNREAD : await readFolder(dir, false);
  // getSystem draws stand-ins (universe/planets.js) for a project folder that lists no planet, and
  // for one it cannot list at all, whatever the error: so a folder that is gone is a stand-in, and
  // one that could not be read is too when the project folder cannot be listed either.
  const standIn = isStandInName(planetName) && (read.folderRead === 'gone' ||
    (read.folderRead === 'none' && !(await fs.promises.readdir(projectPath).then(() => true, () => false))));
  return { name, read, standIn };
}

/**
 * Folder `name` as the disk spells it, which names the planet and seeds its globe; null when gone.
 * @param {string} root
 * @param {string} name
 */
async function diskName(root, name) {
  // Security: a case-sensitive root spells a folder one way, so nothing is listed to find it.
  if (!ignoresCase(root)) return name;
  /** @type {string[]} */
  let names = [];
  try { names = await fs.promises.readdir(root); } catch { /* gone, as far as a name goes */ }
  return matchingName(names, name, root);
}

/**
 * A planet's folder counts. '(root)' (`root`) stands for the top-level files alone, so it reads no
 * folder below them.
 * @param {string} dir
 * @param {boolean} root
 * @returns {Promise<FolderRead>}
 */
async function readFolder(dir, root) {
  let files = 0, bytes = 0, subdirs = 0, folders = 0, peeks = 0, partial = false;
  /** @type {'gone' | 'none' | null} */
  let failed = null;
  const exts = new Map();
  /** @type {Promise<number | null>[]} one per counted file, awaited together after the walk */
  const sizes = [];
  const list = (/** @type {string} */ d) => fs.promises.readdir(d, { withFileTypes: true });

  // Whether a folder the walk leaves unread holds a file at any depth, which the walk would count.
  /** @param {string} d @returns {Promise<boolean>} */
  const holdsFiles = async (d) => {
    if (peeks >= READ_PEEKS) return true;
    peeks++;
    let entries;
    try { entries = await list(d); } catch { return true; }
    if (entries.some((e) => !e.isDirectory())) return true;
    for (const e of entries) {
      if (!ignored(e.name) && await holdsFiles(path.join(d, e.name))) return true;
    }
    return false;
  };
  const leave = async (/** @type {string} */ d) => { if (!partial) partial = await holdsFiles(d); };

  // A failed read counts toward the folder limit too.
  /** @param {string} d @param {number} depth */
  const walk = async (d, depth) => {
    if (folders >= READ_FOLDERS) { await leave(d); return; }
    folders++;
    let entries;
    try {
      entries = await list(d);
    } catch (error) {
      if (depth > 0) partial = true;
      else failed = error && (error.code === 'ENOENT' || error.code === 'ENOTDIR') ? 'gone' : 'none';
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (ignored(e.name)) continue;
        if (depth === 0) subdirs++;
        if (root) continue;
        const sub = path.join(d, e.name);
        if (depth + 1 < READ_LEVELS && files < READ_FILES) await walk(sub, depth + 1);
        else await leave(sub);
      } else if (files >= READ_FILES) {
        partial = true;
      } else {
        files++;
        const ext = path.extname(e.name).slice(1).toUpperCase() || 'MISC';
        exts.set(ext, (exts.get(ext) || 0) + 1);
        // Security: lstat, which follows no link: a link in the folder counts as the file it is,
        // and its target (another folder, a network share) is never touched.
        sizes.push(fs.promises.lstat(path.join(d, e.name)).then((stat) => stat.size, () => null));
      }
    }
  };
  await walk(dir, 0);
  // Bytes, rounded once at the end: rounding each file made a folder of small files read 0 KB.
  // A file whose size cannot be read leaves the size a floor.
  for (const size of await Promise.all(sizes)) {
    if (size === null) partial = true;
    else bytes += size;
  }
  const resources = [...exts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k]) => k);
  // A planet whose own folder could not be read read nothing, which is no counts at all rather
  // than a floor of none. A floor is rounded down.
  const sizeKb = partial ? Math.floor(bytes / 1024) : Math.round(bytes / 1024);
  return { files, sizeKb, subdirs, resources, folderRead: failed ?? (partial ? 'partial' : 'full') };
}

function isPlanetSegment(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 255 &&
    value !== '.' && value !== '..' && !/[\\/\0]/.test(value);
}

function shallowCount(dir) {
  let count = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (count > 400) break;
      if (e.isFile()) count++;
      else if (e.isDirectory() && !ignored(e.name)) {
        try {
          count += fs.readdirSync(path.join(dir, e.name)).length;
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  return count;
}

module.exports = { IGNORE_DIRS, getSystem, getPlanet, isPlanetSegment };

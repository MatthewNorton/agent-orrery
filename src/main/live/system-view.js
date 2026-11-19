// @ts-check
'use strict';

// The system and planet views of a live project, read from the project folder on disk.

const fs = require('fs');
const path = require('path');
const { fnv1a, mulberry32 } = require('../shared/hash');
const { ignoresCase, relativeInside } = require('../path-safety');
const { bucketBuilds, bucketKey } = require('../build-buckets');
const { isStandInName, proceduralSystem, systemData } = require('../universe/planets');
const { liveProject } = require('../universe/public-shape');

/**
 * @import { PlanetData, SystemData } from '../../types/contract'
 * @import { LiveModel, LiveProject } from '../../types/live-model'
 */

const SYSTEM_CACHE_MS = 30000;
// A planet's folder read: at most 600 files and 300 folders, five levels deep. A folder left unread
// for those limits is looked into, and the folders below it, at most 100 in all: one that holds a
// file, or cannot be looked into, makes the counts floors and `folderRead` 'partial', as does a
// folder below the planet's that cannot be read and a file whose size cannot. When the planet's
// own folder is not there, 'gone'; when it is there and cannot be read (locked, or a passing error
// such as too many open files), 'none'.
const READ_FILES = 600, READ_FOLDERS = 300, READ_LEVELS = 5, READ_PEEKS = 100;
const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.next', '.venv', 'venv', 'dist', 'build', 'out',
  'release', 'coverage', 'target', '__pycache__', '.idea', '.vscode', 'bin', 'obj',
]);
const ignored = (/** @type {string} */ name) => IGNORE_DIRS.has(name) || name.startsWith('.');

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
  /** @param {string} name */
  const base = (name) => ({
    name,
    project: liveProject(project),
    // Security follow-up: own keys only; 'constructor'/'__proto__' must not return a non-cloneable prototype value.
    builds: bucketBuilds(project, name),
  });
  // A stand-in's numbers are invented; the same project and name always get the same ones. With no
  // folder to name it, it answers to its bucket's key.
  const standIn = () => {
    const named = bucketKey(project, planetName) ?? planetName;
    const rand = mulberry32(fnv1a(projectId + named));
    return { ...base(named), files: Math.floor(rand() * 200), sizeKb: Math.floor(rand() * 4000), subdirs: Math.floor(rand() * 9), resources: ['Unknown'], procedural: true };
  };
  if (!project.path || !project.exists) return standIn();
  // Security: planetName arrives over IPC. Only a single plain directory segment
  // is a planet; anything with separators or dot-segments could walk outside the project.
  const root = planetName === '(root)';
  if (!root && !isPlanetSegment(planetName)) return null;
  const name = root ? planetName : await diskName(project, planetName);
  const dir = root ? project.path : path.join(project.path, name);
  if (!root && relativeInside(project.path, dir) === null) return null;
  const read = await readFolder(dir, root);
  // A stand-in planet of a project without folders (universe/planets.js) has no folder and no builds.
  if (read.folderRead === 'gone' && isStandInName(planetName) && bucketKey(project, planetName) === null) return standIn();
  return { ...base(name), ...read };
}

/**
 * The folder's name as the disk spells it. Under a Windows path a planet can be asked for in
 * another casing (a build bucket keeps the first casing it saw, or an older lower-cased key), and
 * the renderer seeds the globe from the name, so every casing has to open the planet the system
 * view draws. A folder that is gone answers to its bucket's key.
 * @param {LiveProject} project
 * @param {string} name
 */
async function diskName(project, name) {
  if (!ignoresCase(project.path)) return name;
  const folded = name.toLowerCase();
  /** @type {string[]} */
  let names = [];
  try { names = await fs.promises.readdir(project.path); } catch { /* the bucket's key, below */ }
  return names.includes(name) ? name
    : names.find((entry) => entry.toLowerCase() === folded) ?? bucketKey(project, name) ?? name;
}

/**
 * A planet's folder counts. '(root)' (`root`) stands for the top-level files alone, so it reads no
 * folder below them.
 * @param {string} dir
 * @param {boolean} root
 * @returns {Promise<Pick<PlanetData, 'files' | 'sizeKb' | 'subdirs' | 'resources' | 'folderRead'>>}
 */
async function readFolder(dir, root) {
  let files = 0, bytes = 0, subdirs = 0, folders = 0, peeks = 0, partial = false;
  /** @type {'gone' | 'none' | null} */
  let failed = null;
  const exts = new Map();
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
    const counted = [];
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
        counted.push(e.name);
      }
    }
    // Bytes, rounded once at the end: rounding each file made a folder of small files read 0 KB.
    // A file whose size cannot be read leaves the size a floor.
    const sizes = await Promise.all(counted.map((file) => (
      fs.promises.stat(path.join(d, file)).then((stat) => stat.size, () => null))));
    for (const size of sizes) {
      if (size === null) partial = true;
      else bytes += size;
    }
  };
  await walk(dir, 0);
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

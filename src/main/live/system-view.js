// @ts-check
'use strict';

// The system and planet views of a live project, read from the project folder on disk.

const fs = require('fs');
const path = require('path');
const { fnv1a, mulberry32 } = require('../shared/hash');
const { wholeCount } = require('../shared/values');
const { bucketBuilds, bucketFor, isPlanetSegment, matchingEntry, planetKey } = require('../build-buckets');
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
const isGone = (/** @type {any} */ error) => Boolean(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
/**
 * A folder that was not read has no counts. A new one each time: the answer it goes into belongs to its caller.
 * @param {'gone' | 'none'} folderRead
 * @returns {FolderRead}
 */
const unread = (folderRead) => ({ files: 0, sizeKb: 0, subdirs: 0, resources: [], folderRead });

// A planet's file, one rule for the system view and the card: an entry not typed a folder, so a link or junction is one file.
const isPlanetFile = (/** @type {fs.Dirent} */ entry) => !entry.isDirectory();

/**
 * The one definition of a planet folder, over a project folder's listing (`entries`; null when the
 * folder could not be listed): an entry the listing types as a folder. Security: a listing types
 * every link and junction as a link (lstat calls some junctions folders), so none is a planet
 * folder and none is ever gone into. getSystem draws the planet folders that are not ignored;
 * getPlanet reads any of them, also one that is not drawn (`.github`).
 * @param {fs.Dirent[] | null} entries
 * @param {string} projectPath
 */
function planetFolders(entries, projectPath) {
  return {
    all: entries ? entries.filter((entry) => entry.isDirectory()) : [],
    /**
     * Planet `name` in the listing: the name it is listed by (by the path's rule for casing; null
     * when it is not), its planet folder, what a read says where it has none ('none' for a link,
     * which is there and not read; 'gone' for a file or nothing), and the stand-in rule: a planet
     * by a stand-in's name is one, while it has no builds, where no listing or nothing in it says
     * otherwise.
     * @param {string} name
     */
    named(name) {
      const entry = entries ? matchingEntry(entries, name, { path: projectPath }) : null;
      const folder = entry && entry.isDirectory() ? entry : null;
      /** @type {'gone' | 'none' | null} */
      const missing = folder ? null : entry && entry.isSymbolicLink() ? 'none' : 'gone';
      return { name: entry ? entry.name : null, folder, missing, standIn: isStandInName(name) && (!entries || missing === 'gone') };
    },
  };
}

// Planets = the planet folders of the real project on disk that are not ignored, sized by a
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
      beltDensity = entries.filter(isPlanetFile).length;
      const dirs = planetFolders(entries, project.path).all.filter((e) => !ignored(e.name));
      planets = dirs.map((d) => ({
        name: d.name,
        files: shallowCount(path.join(project.path, d.name)),
        builds: bucketBuilds(project, d.name),
      }));
      // The top-level files' own bucket, by that exact key: a folder whose name a path folds to
      // (root) is a planet folder of its own.
      const rootBuilds = Object.hasOwn(project.buckets, '(root)') ? wholeCount(project.buckets['(root)']) : 0;
      if (rootBuilds) {
        planets.push({ name: '(root)', files: beltDensity, builds: rootBuilds });
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
  const root = planetName === '(root)';
  // Security: planetName arrives over IPC. Only a single plain directory segment
  // is a planet; anything with separators or dot-segments could walk outside the project.
  // Checked before any read, whatever folder the project has now or gets during one.
  if (!isPlanetSegment(planetName)) return null;
  const folderOf = () => (project.path && project.exists ? project.path : null);
  // A project without a folder has stand-in planets only.
  const readNow = async () => {
    const projectPath = folderOf();
    return { projectPath, folder: projectPath ? await readPlanet(projectPath, planetName, root) : null };
  };
  const current = () => model.projects.get(projectId) === project;
  let { projectPath, folder } = await readNow();
  // A folder that changed meanwhile is read once more; one that changed again has no answer.
  if (current() && folderOf() !== projectPath) ({ projectPath, folder } = await readNow());
  // The project is read from here on, after the disk, so a build counted during the read is in the answer.
  if (!current() || folderOf() !== projectPath) return null;
  // Security follow-up: own keys only; 'constructor'/'__proto__' must not return a non-cloneable prototype value.
  const bucket = bucketFor(project, planetName);
  /** @param {string} name */
  const base = (name) => ({ name, key: planetKey(project, name), project: liveProject(project), builds: bucket.builds });
  // A stand-in has no folder and no builds: its numbers are invented, the same each time for a project and name.
  if (!folder || (folder.standIn && bucket.key === null)) {
    const rand = mulberry32(fnv1a(projectId + bucket.name));
    return { ...base(bucket.name), files: Math.floor(rand() * 200), sizeKb: Math.floor(rand() * 4000), subdirs: Math.floor(rand() * 9), resources: ['Unknown'], procedural: true };
  }
  return { ...base(folder.name ?? bucket.name), ...folder.read };
}

/**
 * What the disk has of a planet: the name its folder is listed by (null when none is), its
 * counts, and whether a planet of that name with no builds is a stand-in.
 * @param {string} projectPath
 * @param {string} planetName
 * @param {boolean} root
 * @returns {Promise<{ name: string | null, read: FolderRead, standIn: boolean }>}
 */
async function readPlanet(projectPath, planetName, root) {
  if (root) return { name: planetName, read: await readFolder(projectPath, true), standIn: false };
  /** @type {fs.Dirent[] | null} */
  let entries = null;
  /** @type {'gone' | 'none'} */
  let failure = 'none';
  try { entries = await fs.promises.readdir(projectPath, { withFileTypes: true }); } catch (error) { failure = isGone(error) ? 'gone' : 'none'; }
  // Security: only a planet folder is read (planetFolders), so no link is ever gone into.
  const { name, folder, missing, standIn } = planetFolders(entries, projectPath).named(planetName);
  let read;
  if (!entries) read = unread(failure);
  else read = folder ? await readFolder(path.join(projectPath, folder.name), false) : unread(missing);
  return { name, read, standIn };
}

/**
 * A planet's folder counts. '(root)' (`root`) stands for the top-level files alone, so it reads no
 * folder below them. Security: a folder is read only when its parent's listing calls it a folder,
 * so the walk never goes into a link; one swapped for a link after that listing can still be
 * followed, which takes a process already writing inside the project. getSystem and shallowCount
 * read by the listing's type too, and the same holds for them.
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

  // Whether a folder the walk leaves unread holds a file at any depth, which the walk would count.
  /** @param {string} d @returns {Promise<boolean>} */
  const holdsFiles = async (d) => {
    if (peeks >= READ_PEEKS) return true;
    peeks++;
    let entries;
    try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return true; }
    if (entries.some(isPlanetFile)) return true;
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
      entries = await fs.promises.readdir(d, { withFileTypes: true });
    } catch (error) {
      if (depth > 0) partial = true;
      else failed = isGone(error) ? 'gone' : 'none';
      return;
    }
    for (const e of entries) {
      if (isPlanetFile(e)) {
        if (files >= READ_FILES) { partial = true; continue; }
        files++;
        const ext = path.extname(e.name).slice(1).toUpperCase() || 'MISC';
        exts.set(ext, (exts.get(ext) || 0) + 1);
        // Security: lstat, which follows no link: a link in the folder counts as the file it is,
        // and its target (another folder, a network share) is not opened.
        sizes.push(fs.promises.lstat(path.join(d, e.name)).then((stat) => stat.size, () => null));
      } else if (!ignored(e.name)) {
        if (depth === 0) subdirs++;
        if (root) continue;
        const sub = path.join(d, e.name);
        if (depth + 1 < READ_LEVELS && files < READ_FILES) await walk(sub, depth + 1);
        else await leave(sub);
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

function shallowCount(dir) {
  let count = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (count > 400) break;
      if (isPlanetFile(e)) count++;
      else if (!ignored(e.name)) {
        try {
          count += fs.readdirSync(path.join(dir, e.name)).length;
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  return count;
}

module.exports = { IGNORE_DIRS, getSystem, getPlanet, planetFolders };

// @ts-check
'use strict';

// The system and planet views of a live project, read from the project folder on disk.

const fs = require('fs');
const path = require('path');
const { fnv1a, mulberry32 } = require('../shared/hash');
const { relativeInside } = require('../path-safety');
const { bucketBuilds } = require('../build-buckets');
const { proceduralSystem } = require('../universe/planets');
const { liveProject } = require('../universe/public-shape');

/**
 * @import { PlanetData, SystemData } from '../../types/contract'
 * @import { LiveModel } from '../../types/live-model'
 */

const SYSTEM_CACHE_MS = 30000;
// A planet's folder read: at most 600 files and 300 folders, five levels deep. Past any of those,
// or at a folder it cannot read, its counts are floors and `partial` says so.
const READ_FILES = 600, READ_FOLDERS = 300, READ_DEPTH = 4;
const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.next', '.venv', 'venv', 'dist', 'build', 'out',
  'release', 'coverage', 'target', '__pycache__', '.idea', '.vscode', 'bin', 'obj',
]);

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
      const dirs = entries.filter(
        (e) => e.isDirectory() && !IGNORE_DIRS.has(e.name) && !e.name.startsWith('.')
      );
      planets = dirs.map((d) => ({
        name: d.name,
        files: shallowCount(path.join(project.path, d.name)),
        builds: bucketBuilds(project, d.name),
      }));
      if (project.buckets['(root)']) {
        planets.push({ name: '(root)', files: beltDensity, builds: project.buckets['(root)'] });
      }
      planets.sort((a, b) => b.files + b.builds * 5 - (a.files + a.builds * 5));
      planets = planets.slice(0, 8);
    } catch { /* fall through to procedural */ }
  }
  if (planets.length === 0) ({ planets, beltDensity } = proceduralSystem(projectId));
  const data = { project: liveProject(project), planets, beltDensity };
  model.systemCache.set(projectId, { at: Date.now(), data });
  return data;
}

// Planet close-up stats: a folder's files, size and subfolders, read from disk.
/**
 * @param {LiveModel} model
 * @param {string} projectId
 * @param {string} planetName
 * @returns {PlanetData | null}
 */
function getPlanet(model, projectId, planetName) {
  const project = model.projects.get(projectId);
  if (!project) return null;
  const base = {
    name: planetName,
    project: liveProject(project),
    // Security follow-up: own keys only; 'constructor'/'__proto__' must not return a non-cloneable prototype value.
    builds: bucketBuilds(project, planetName),
  };
  if (!project.path || !project.exists || planetName.startsWith('Sector-')) {
    const rand = mulberry32(fnv1a(projectId + planetName));
    return { ...base, files: Math.floor(rand() * 200), sizeKb: Math.floor(rand() * 4000), subdirs: Math.floor(rand() * 9), resources: ['Unknown'], procedural: true };
  }
  // Security: planetName arrives over IPC. Only a single plain directory segment
  // is a planet; anything with separators or dot-segments could walk outside the project.
  if (planetName !== '(root)' && !isPlanetSegment(planetName)) return null;
  const dir = planetName === '(root)' ? project.path : path.join(project.path, planetName);
  if (planetName !== '(root)' && relativeInside(project.path, dir) === null) return null;
  const root = planetName === '(root)';
  let files = 0, bytes = 0, subdirs = 0, folders = 0, partial = false;
  const exts = new Map();
  const walk = (d, depth) => {
    if (folders >= READ_FOLDERS) { partial = true; return; }
    folders++;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { partial = true; return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        if (depth === 0) subdirs++;
        // '(root)' stands for the top-level files alone, so it reads no folder below them.
        if (root) continue;
        if (depth < READ_DEPTH && files < READ_FILES) walk(path.join(d, e.name), depth + 1);
        else partial = true;
      } else if (files >= READ_FILES) {
        partial = true;
      } else {
        files++;
        const ext = path.extname(e.name).slice(1).toUpperCase() || 'MISC';
        exts.set(ext, (exts.get(ext) || 0) + 1);
        // Bytes, rounded once at the end: rounding each file made a folder of small files read 0 KB.
        try { bytes += fs.statSync(path.join(d, e.name)).size; } catch { /* ignore */ }
      }
    }
  };
  walk(dir, 0);
  const resources = [...exts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k]) => k);
  return { ...base, files, sizeKb: Math.round(bytes / 1024), subdirs, resources, partial };
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
      else if (e.isDirectory() && !IGNORE_DIRS.has(e.name) && !e.name.startsWith('.')) {
        try {
          count += fs.readdirSync(path.join(dir, e.name)).length;
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  return count;
}

module.exports = { IGNORE_DIRS, getSystem, getPlanet, isPlanetSegment };

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_DIRECTORIES = 12_000;
const DEFAULT_MAX_CANDIDATES = 8;
const DEFAULT_MAX_DURATION_MS = 8_000;
const DEFAULT_MAX_TOTAL_CANDIDATES = 100;
const SKIP_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', '.idea', '.vscode',
  'node_modules', '.next', '.venv', 'venv', '__pycache__',
  'dist', 'build', 'out', 'release', 'coverage', 'target', 'bin', 'obj',
]);

function boundedInteger(value, fallback, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}

function normalizedName(value) {
  return typeof value === 'string' ? value.trim().toLocaleLowerCase() : '';
}

function projectMatchNames(project) {
  const names = new Set();
  const add = (value) => {
    const normalized = normalizedName(value);
    if (normalized && normalized !== '.' && normalized !== path.parse(normalized).root) {
      names.add(normalized);
    }
  };
  add(project && project.name);
  if (project && typeof project.path === 'string' && project.path.trim()) {
    add(path.basename(path.normalize(project.path.trim())));
  }
  return [...names];
}

function isPathInside(rootPath, candidatePath) {
  const relative = path.relative(path.normalize(rootPath), path.normalize(candidatePath));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' &&
    !path.isAbsolute(relative));
}

async function realDirectory(inputPath) {
  if (typeof inputPath !== 'string' || !path.isAbsolute(inputPath)) {
    throw new TypeError('scan root must be an absolute directory');
  }
  const real = await fs.promises.realpath(inputPath);
  const stat = await fs.promises.stat(real);
  if (!stat.isDirectory()) throw new TypeError('scan root must be a directory');
  return path.normalize(real);
}

/**
 * Search beneath a user-selected root for exact directory-name matches.
 * The walk is breadth-first, bounded, and never follows symlinks/junctions.
 */
async function scanProjectCandidates(rootPath, projects, options = {}) {
  const root = await realDirectory(rootPath);
  const maxDepth = boundedInteger(options.maxDepth, DEFAULT_MAX_DEPTH, 0, 12);
  const maxDirectories = boundedInteger(
    options.maxDirectories, DEFAULT_MAX_DIRECTORIES, 1, 100_000
  );
  const maxCandidates = boundedInteger(
    options.maxCandidates, DEFAULT_MAX_CANDIDATES, 1, 32
  );
  const maxDurationMs = boundedInteger(
    options.maxDurationMs, DEFAULT_MAX_DURATION_MS, 100, 60_000
  );
  const maxTotalCandidates = boundedInteger(
    options.maxTotalCandidates, DEFAULT_MAX_TOTAL_CANDIDATES, 1, 1_000
  );

  const namesToProjects = new Map();
  const matches = new Map();
  for (const project of Array.isArray(projects) ? projects : []) {
    if (!project || typeof project.id !== 'string' || !project.id) continue;
    const names = projectMatchNames(project);
    if (names.length === 0) continue;
    matches.set(project.id, []);
    for (const name of names) {
      if (!namesToProjects.has(name)) namesToProjects.set(name, new Set());
      namesToProjects.get(name).add(project.id);
    }
  }

  const queue = [{ directory: root, depth: 0 }];
  let cursor = 0;
  let directoriesVisited = 0;
  let totalCandidates = 0;
  let truncated = false;
  const deadline = Date.now() + maxDurationMs;

  while (cursor < queue.length) {
    if ((options.signal && options.signal.aborted) || Date.now() >= deadline ||
        directoriesVisited >= maxDirectories) {
      truncated = true;
      break;
    }
    const item = queue[cursor++];
    directoriesVisited++;

    const projectIds = namesToProjects.get(normalizedName(path.basename(item.directory)));
    if (projectIds) {
      for (const projectId of projectIds) {
        const candidates = matches.get(projectId);
        if (candidates && candidates.length < maxCandidates &&
            totalCandidates < maxTotalCandidates && !candidates.includes(item.directory)) {
          candidates.push(item.directory);
          totalCandidates++;
        }
      }
    }

    if (item.depth >= maxDepth) continue;
    const remainingCapacity = Math.max(0, maxDirectories - queue.length);
    if (remainingCapacity === 0) {
      truncated = true;
      continue;
    }
    const children = [];
    try {
      const directory = await fs.promises.opendir(item.directory);
      for await (const entry of directory) {
        if (Date.now() >= deadline || (options.signal && options.signal.aborted)) {
          truncated = true;
          break;
        }
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        if (SKIP_DIRECTORIES.has(entry.name.toLocaleLowerCase()) || entry.name.startsWith('.')) continue;
        if (children.length >= remainingCapacity) {
          truncated = true;
          break;
        }
        children.push(entry.name);
      }
    } catch {
      continue;
    }
    children.sort((a, b) => a.localeCompare(b));
    for (const name of children) {
      queue.push({ directory: path.join(item.directory, name), depth: item.depth + 1 });
    }
  }

  return {
    root,
    directoriesVisited,
    truncated,
    matches: [...matches].map(([projectId, candidates]) => ({ projectId, candidates })),
  };
}

module.exports = {
  scanProjectCandidates,
  isPathInside,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_DIRECTORIES,
  DEFAULT_MAX_CANDIDATES,
  DEFAULT_MAX_DURATION_MS,
  DEFAULT_MAX_TOTAL_CANDIDATES,
};

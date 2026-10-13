// @ts-check
'use strict';

// Which galaxy a project belongs to on the universe map. Live groups by the project's path on
// disk; history groups every project under its parent folder's hash.

const path = require('path');
const { canonicalProjectPath } = require('../provider-adapters');
const { hex8 } = require('../shared/hash');

const GENERIC_WORKSPACE_DIRS = new Set([
  'code', 'src', 'source', 'repos', 'repositories', 'projects', 'dev',
  'development', 'git', 'github',
]);
const HOME_FOLDERS = new Map([
  ['documents', 'Documents'],
  ['desktop', 'Desktop'],
  ['downloads', 'Downloads'],
]);

// Pure, host-independent project grouping. Both path implementations are
// selected from the input syntax, never from process.platform or ambient
// filesystem state, so Windows and POSIX fixtures behave identically on any
// machine.
function deriveGalaxy(projectPath, projectId, exists) {
  const hasPath = typeof projectPath === 'string' && projectPath.trim() !== '';
  if (hasPath && exists === false) {
    return { key: 'graveyard', label: 'Graveyard' };
  }

  if (!hasPath) return deriveGalaxyFromSlug(projectId);

  const input = projectPath.trim();
  const windows = /^[a-z]:[\\/]/i.test(input) || /^\\\\/.test(input) || input.includes('\\');
  const flavor = windows ? path.win32 : path.posix;
  const normalized = flavor.normalize(input);
  const root = flavor.parse(normalized).root;
  const relative = normalized.slice(root.length);
  const segments = relative.split(flavor.sep).filter(Boolean);
  const structural = deriveStructuralGalaxy(segments);
  if (structural) return structural;

  const parent = flavor.dirname(normalized);
  if (windows) {
    const canonical = path.win32.normalize(parent).replace(/\\/g, '/').toLowerCase();
    const parsed = path.win32.parse(parent);
    if (parent === parsed.root) {
      const drive = parsed.root.match(/^([a-z]):/i);
      return {
        key: `path:win:${canonical}`,
        label: drive ? `${drive[1].toUpperCase()}: Drive` : humanizeSegment(path.win32.basename(parsed.root)),
      };
    }
    return {
      key: `path:win:${canonical}`,
      label: humanizeSegment(path.win32.basename(parent)),
    };
  }

  const canonical = path.posix.normalize(parent);
  if (canonical === '/') return { key: 'path:posix:/', label: 'Root' };
  return {
    key: `path:posix:${canonical}`,
    label: humanizeSegment(path.posix.basename(parent)),
  };
}

function deriveStructuralGalaxy(segments) {
  const lower = segments.map((segment) => segment.toLowerCase());

  for (let i = lower.length - 1; i >= 0; i--) {
    if (lower[i] !== 'workspace' && lower[i] !== 'workspaces') continue;
    let selected = i + 1;
    while (selected < lower.length && GENERIC_WORKSPACE_DIRS.has(lower[selected])) selected++;
    if (selected < segments.length) return namedGalaxy('workspace', segments[selected]);
  }

  // Prefer the most specific recognizable home occurrence. This also keeps
  // isolated test profiles (whose synthetic /home/user lives below a temp
  // root) portable without consulting os.homedir().
  for (let i = lower.length - 1; i >= 0; i--) {
    const marker = lower[i];
    const isHome = marker === 'home' || marker === 'users';
    if (!isHome || i + 1 >= segments.length) continue;
    const childIndex = i + 2;
    if (childIndex >= segments.length) return { key: 'home', label: 'Home' };
    const child = lower[childIndex];
    if (HOME_FOLDERS.has(child)) {
      return { key: `home:${child}`, label: HOME_FOLDERS.get(child) };
    }
    if (segments[childIndex].startsWith('.')) return { key: 'home', label: 'Home' };
  }

  // Outside an explicit workspace, a conventional repository container is
  // itself generic; its first non-generic child is the meaningful bucket.
  for (let i = 0; i < lower.length - 1; i++) {
    if (!GENERIC_WORKSPACE_DIRS.has(lower[i])) continue;
    let selected = i + 1;
    while (selected < lower.length && GENERIC_WORKSPACE_DIRS.has(lower[selected])) selected++;
    if (selected < segments.length) return namedGalaxy('container', segments[selected]);
  }
  return null;
}

function deriveGalaxyFromSlug(projectId) {
  const id = typeof projectId === 'string' ? projectId : String(projectId || 'unknown');
  const segments = id.split('-').filter(Boolean);
  const structural = deriveStructuralGalaxy(segments);
  if (structural) return structural;
  return {
    key: `slug:${hex8(id)}`,
    label: humanizeSegment(id).slice(0, 32) || 'Unknown',
  };
}

function namedGalaxy(namespace, segment) {
  const normalized = normalizeSegment(segment);
  if (!normalized) return null;
  return { key: `${namespace}:${normalized}`, label: humanizeSegment(segment) };
}

function normalizeSegment(segment) {
  return String(segment || '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function humanizeSegment(segment) {
  const words = String(segment || '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return words.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function historyGalaxy(projectPath, exists) {
  if (exists === false) return { key: 'graveyard', label: 'Graveyard' };
  const canonical = canonicalProjectPath(projectPath) || 'history';
  const windows = canonical.startsWith('win:');
  const flavor = windows ? path.win32 : path.posix;
  const raw = canonical.slice(canonical.indexOf(':') + 1).replace(/\//g, flavor.sep);
  const parent = flavor.dirname(raw);
  const label = humanize(flavor.basename(parent)) || 'History';
  return { key: `history:${hex8(parent)}`, label };
}

function humanize(value) {
  return String(value || '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

module.exports = { deriveGalaxy, historyGalaxy };

// @ts-check
'use strict';

// The files a providers.json watch entry covers. Only directory listings and file stats
// are taken; a watched file's contents are never read.

const fs = require('fs');
const path = require('path');
const { canonicalProjectPath } = require('./provider-adapters');
const { hex8 } = require('./shared/hash');

const MAX_WATCHED_FILES = 256;

/**
 * @typedef {object} SignalSource
 * @property {string} id
 * @property {string} directory
 * @property {string} projectPath
 * @property {string | null} label
 * @property {string[]} extensions Lower-case, with the leading dot.
 */

/**
 * The parsed watch entries as Signal sources, without any whose paths are not absolute.
 * @param {{ directory: string, projectPath: string, label: string | null, extensions: string[] }[]} watch
 * @returns {SignalSource[]}
 */
function signalSources(watch) {
  return watch
    .map((item) => ({
      id: `watch-${hex8(canonicalProjectPath(item.directory))}`,
      directory: item.directory,
      projectPath: item.projectPath,
      label: item.label,
      extensions: item.extensions,
    }))
    .filter((source) => /^[a-z0-9][a-z0-9-]{0,47}$/i.test(source.id) &&
      isAbsoluteAnywhere(source.directory) && isAbsoluteAnywhere(source.projectPath));
}

/**
 * The source's newest files with a watched extension, at most 256.
 * @param {SignalSource} source
 * @returns {{ fp: string, st: fs.Stats }[]}
 */
function watchedFiles(source) {
  const extensions = new Set(source.extensions);
  return listRegularFilesRecursive(source.directory)
    .filter(({ fp }) => extensions.has(path.extname(fp).toLowerCase()))
    .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs || a.fp.localeCompare(b.fp))
    .slice(0, MAX_WATCHED_FILES);
}

function isAbsoluteAnywhere(value) {
  return path.win32.isAbsolute(value || '') || path.posix.isAbsolute(value || '');
}

function listRegularFilesRecursive(root) {
  const out = [];
  const queue = [root];
  while (queue.length) {
    const dir = queue.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const fp = path.join(dir, entry.name);
      if (entry.isDirectory()) queue.push(fp);
      else if (entry.isFile()) {
        try { out.push({ fp, st: fs.statSync(fp) }); } catch { /* raced with deletion */ }
      }
    }
  }
  return out;
}

module.exports = { signalSources, watchedFiles };

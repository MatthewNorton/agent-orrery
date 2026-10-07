'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Writes UTF-8 text to a fresh sibling temp file ('wx' never reuses an existing one), then
 * renames it over targetPath. beforeRename may throw to abandon the write; the temp file is
 * removed either way.
 */
function writeFileAtomic(targetPath, text, { fsImpl = fs, beforeRename = null } = {}) {
  const tempPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  try {
    fsImpl.writeFileSync(tempPath, text, { encoding: 'utf8', flag: 'wx' });
    if (beforeRename) beforeRename();
    fsImpl.renameSync(tempPath, targetPath);
  } finally {
    try { fsImpl.unlinkSync(tempPath); } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }
}

module.exports = { writeFileAtomic };

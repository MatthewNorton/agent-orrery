'use strict';

// Renderer source for the source-text tests, listed by folder under src/renderer.

const fs = require('node:fs');
const path = require('node:path');

const RENDERER = path.join(__dirname, '..', '..', 'src', 'renderer');

const readRenderer = (file) => fs.readFileSync(path.join(RENDERER, file), 'utf8');

/** Sorted `<dir>/...` paths of every file under src/renderer/<dir> that passes `keep`. */
function rendererFiles(dir, keep = (file) => file.endsWith('.js')) {
  return fs.readdirSync(path.join(RENDERER, dir), { recursive: true })
    .map((file) => `${dir}/${file.split(path.sep).join('/')}`).filter(keep).sort();
}

const rendererSource = (dir, keep) => rendererFiles(dir, keep).map(readRenderer).join('\n');

module.exports = { readRenderer, rendererFiles, rendererSource };

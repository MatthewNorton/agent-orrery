'use strict';

// Renderer source for the source-text tests, listed by folder under src/renderer, and
// runRenderer() for the tests that run a renderer script.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const RENDERER = path.join(__dirname, '..', '..', 'src', 'renderer');

const readRenderer = (file) => fs.readFileSync(path.join(RENDERER, file), 'utf8');

/**
 * Runs src/renderer/<file>, after `edit`, with each key of `globals` bound to its value. It runs
 * in this realm, so the typed arrays it makes compare with assert.
 */
function runRenderer(file, globals, edit = (code) => code) {
  const source = `(function (${Object.keys(globals).join(', ')}) {\n${edit(readRenderer(file))}\n})`;
  vm.runInThisContext(source, { filename: `src/renderer/${file}` })(...Object.values(globals));
}

/** Sorted `<dir>/...` paths of every file under src/renderer/<dir> that passes `keep`. */
function rendererFiles(dir, keep = (file) => file.endsWith('.js')) {
  return fs.readdirSync(path.join(RENDERER, dir), { recursive: true })
    .map((file) => `${dir}/${file.split(path.sep).join('/')}`).filter(keep).sort();
}

const rendererSource = (dir, keep) => rendererFiles(dir, keep).map(readRenderer).join('\n');

module.exports = { readRenderer, rendererFiles, rendererSource, runRenderer };

'use strict';

// Renderer source for the source-text tests, listed by folder under src/renderer, and
// runRenderer() for the tests that run a renderer script; settled() for what its events start.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { scriptTags: tagsOf } = require('../../scripts/lib/script-tags.js');

const RENDERER = path.join(__dirname, '..', '..', 'src', 'renderer');

const readRenderer = (file) => fs.readFileSync(path.join(RENDERER, file), 'utf8');

/** The `src` of every script tag in index.html, in load order. Throws on a tag that is not a plain one. */
const scriptTags = () => tagsOf(readRenderer('index.html'));

/**
 * Runs src/renderer/<file>, after `edit`, with each key of `globals` bound to its value. It runs
 * in this realm, so the typed arrays it makes compare with assert.
 */
function runRenderer(file, globals, edit = (code) => code) {
  const source = `(function (${Object.keys(globals).join(', ')}) {\n${edit(readRenderer(file))}\n})`;
  vm.runInThisContext(source, { filename: `src/renderer/${file}` })(...Object.values(globals));
}

/**
 * Runs util.js and then `files` in a page whose AUR.app is `app`, and returns the page's AUR. `aur`
 * is what else AUR holds before the files run; `window` and `document` are the page's own, and
 * `globals` the other names the files see (requestAnimationFrame, say).
 */
function runApp(files, app, { document = {}, window = {}, aur = {}, globals = {} } = {}) {
  runRenderer('util.js', { window, document });
  Object.assign(window.AUR, aur, { app });
  for (const file of files) runRenderer(file, { window, document, ...globals });
  return window.AUR;
}

/** Sorted `<dir>/...` paths of every file under src/renderer/<dir> that passes `keep`. */
function rendererFiles(dir, keep = (file) => file.endsWith('.js')) {
  return fs.readdirSync(path.join(RENDERER, dir), { recursive: true })
    .map((file) => `${dir}/${file.split(path.sep).join('/')}`).filter(keep).sort();
}

const rendererSource = (dir, keep) => rendererFiles(dir, keep).map(readRenderer).join('\n');

/** Runs `act` (a click, say), lets what it started settle, and returns what rejected unhandled. */
async function settled(act) {
  const unhandled = [];
  const record = (reason) => unhandled.push(reason && reason.message);
  process.on('unhandledRejection', record);
  try {
    act();
    for (let turn = 0; turn < 3; turn++) await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', record);
  }
  return unhandled;
}

module.exports = { readRenderer, rendererFiles, rendererSource, runApp, runRenderer, scriptTags, settled };

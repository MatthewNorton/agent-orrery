'use strict';

// A view's split-off parts (scene/<view>/<part>.js) register a builder on AUR.sceneParts,
// which scene/common.js creates, and the view (scene/<view>/view.js) calls them when it is
// built. A part that is not loaded, or loads after its view, only fails once that view opens.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
const scripts = [...fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8')
  .matchAll(/<script src="([^"]+)"><\/script>/g)].map((match) => match[1]);
const sceneFiles = fs.readdirSync(path.join(RENDERER, 'scene'), { recursive: true })
  .filter((file) => file.endsWith('.js')).map((file) => `scene/${file.split(path.sep).join('/')}`).sort();
const PART = /^scene\/(universe|system|planet)\/(?!view\.js$)([a-z-]+)\.js$/;

test('index.html loads scene/common.js first and every view part before its view', () => {
  const at = (file) => scripts.indexOf(file);
  for (const file of sceneFiles) {
    assert.ok(at(file) >= 0, `${file} has no script tag`);
    if (file !== 'scene/common.js') assert.ok(at('scene/common.js') < at(file), `${file} loads before scene/common.js`);
    const part = file.match(PART);
    if (part) assert.ok(at(file) < at(`scene/${part[1]}/view.js`), `${file} loads after scene/${part[1]}/view.js`);
  }
});

test('each view part registers the builder its file name promises', () => {
  const AUR = { views: {}, ProjectVcsStatus: {} };
  const context = vm.createContext({ window: { AUR, AU: {}, AUR_POLISH: {}, AUR_GALAXY: {} } });
  for (const file of scripts.filter((name) => sceneFiles.includes(name))) {
    vm.runInContext(fs.readFileSync(path.join(RENDERER, file), 'utf8'), context, { filename: file });
  }
  for (const file of sceneFiles) {
    const part = file.match(PART);
    if (!part) continue;
    const key = part[2].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    assert.equal(typeof AUR.sceneParts[part[1]][key], 'function', `${file} registers sceneParts.${part[1]}.${key}`);
  }
  for (const view of ['universe', 'system', 'planet']) assert.equal(typeof AUR.views[view], 'function', view);
});

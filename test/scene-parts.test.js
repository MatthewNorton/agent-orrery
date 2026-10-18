'use strict';

// A view's split-off parts (scene/<view>/<part>.js) register a builder on AUR.sceneParts,
// which scene/common.js creates, and the view (scene/<view>/view.js) calls them when it is
// built. A part that is not loaded, or loads after its view, only fails once that view opens.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readRenderer, rendererFiles } = require('./support/renderer-source');

const scripts = [...readRenderer('index.html')
  .matchAll(/<script src="([^"]+)"><\/script>/g)].map((match) => match[1]);
const sceneFiles = rendererFiles('scene');
const PART = /^scene\/([a-z]+)\/(?!view\.js$)([a-z-]+)\.js$/;
const VIEWS = sceneFiles.map((file) => file.match(/^scene\/([a-z]+)\/view\.js$/)?.[1]).filter(Boolean);

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
    vm.runInContext(readRenderer(file), context, { filename: file });
  }
  for (const file of sceneFiles) {
    const part = file.match(PART);
    if (!part) continue;
    const key = part[2].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    assert.equal(typeof AUR.sceneParts[part[1]][key], 'function', `${file} registers sceneParts.${part[1]}.${key}`);
  }
  assert.deepEqual(VIEWS, ['planet', 'system', 'universe']);
  for (const view of VIEWS) assert.equal(typeof AUR.views[view], 'function', view);
});

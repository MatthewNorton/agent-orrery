'use strict';

// src/renderer/app/panels/resize.js: the room the right rail and the timeline take at their default
// sizes, which the universe map frames to clear.

const assert = require('node:assert/strict');
const test = require('node:test');
const L = require('../src/renderer/panel-layout.js');
const { fakeDocument, fakeElement } = require('./support/fake-dom');
const { runApp } = require('./support/renderer-source');

// A page with the tokens' defaults on the root, and a separate style on the body.
function page() {
  const document = Object.assign(fakeDocument([]), { documentElement: fakeElement('html'), body: fakeElement('body') });
  const vars = new Map([
    [document.documentElement, { '--rail-l': '296px', '--rail-r': '312px', '--dock-h': '52px', '--space-3': '12px', '--sidebar-compact-w': '56px' }],
    [document.body, {}],
  ]);
  const getComputedStyle = (el) => ({ display: 'block', getPropertyValue: (name) => (vars.get(el) || {})[name] || '' });
  const app = { state: { panels: {} }, const: {}, uiZoom: () => 1.25 };
  runApp(['app/panels/resize.js'], app, { document, window: { AUR_PANEL_LAYOUT: L }, globals: { getComputedStyle } });
  return { app, vars, document };
}

test('defaultPanelRoom: the default right rail and timeline with their margins, at the text size', () => {
  const { app, vars, document } = page();
  assert.deepEqual(app.defaultPanelRoom(), { right: 405, bottom: 80 }, '(12 + 312) and (12 + 52) at 125%');
  // A rail sized by its grip and a hidden timeline change the live tokens, not the defaults.
  vars.get(document.documentElement)['--rail-r'] = '819px';
  vars.get(document.body)['--dock-h'] = '0px';
  assert.deepEqual(app.defaultPanelRoom(), { right: 405, bottom: 80 });
});

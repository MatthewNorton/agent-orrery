'use strict';

// src/renderer/app/panels/resize.js: the room the side rails and the timeline take at their default
// sizes, which the universe map frames to clear.

const assert = require('node:assert/strict');
const test = require('node:test');
const L = require('../src/renderer/panel-layout.js');
const { fakeDocument, fakeElement } = require('./support/fake-dom');
const { runApp } = require('./support/renderer-source');

// A page with the tokens' defaults on the root and the timeline hidden from the start, which sets
// --dock-h to 0 on the body (hud.css), as the page's own styles do.
function page() {
  const document = Object.assign(fakeDocument([]), { documentElement: fakeElement('html'), body: fakeElement('body') });
  const vars = new Map([
    [document.documentElement, { '--rail-l': '296px', '--rail-r': '312px', '--dock-h': '52px', '--space-3': '12px', '--sidebar-compact-w': '56px' }],
    [document.body, { '--dock-h': '0px' }],
  ]);
  const getComputedStyle = (el) => ({ display: 'block', getPropertyValue: (name) => (vars.get(el) || {})[name] || '' });
  const app = { state: { panels: {} }, const: {}, uiZoom: () => 1.25 };
  runApp(['app/panels/resize.js'], app, { document, window: { AUR_PANEL_LAYOUT: L }, globals: { getComputedStyle } });
  return { app, vars, document };
}

test('defaultPanelRoom: both default rails and the timeline with their margins, at the text size', () => {
  const { app, vars, document } = page();
  const room = { left: 385, right: 405, bottom: 80 };
  // The timeline's room is its default height even while it is hidden.
  assert.deepEqual(app.defaultPanelRoom(), room, '(12 + 296), (12 + 312) and (12 + 52) at 125%');
  // Rails sized by their grips set --rail-l and --rail-r on the root (fitRails); the room keeps
  // the widths the tokens had before.
  Object.assign(vars.get(document.documentElement), { '--rail-l': '560px', '--rail-r': '819px' });
  assert.deepEqual(app.defaultPanelRoom(), room, 'after both rails were sized');
});

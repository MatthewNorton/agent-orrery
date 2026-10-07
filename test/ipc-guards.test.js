'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const guards = require('../src/main/ipc/guards');
const ids = require('../src/main/shared/ids');
const { rendererUrl } = require('../src/main/window-security');
const { RENDERER_ENTRY_URL, fakeWindow, trustedEvent, untrustedEvent } = require('./support/main-wiring');

test('guards re-export the shared project id check', () => {
  assert.equal(guards.validProjectId, ids.validProjectId);
});

test('the renderer entry URL is the file URL of src/renderer/index.html', () => {
  assert.equal(RENDERER_ENTRY_URL, rendererUrl(path.resolve(__dirname, '..', 'src', 'renderer', 'index.html')));
});

test('trusts only the main frame of ctx.win showing the renderer entry page', () => {
  const win = fakeWindow();
  const ctx = { win };
  assert.equal(guards.trustedMainFrame(ctx, trustedEvent(win)), true);

  assert.equal(guards.trustedMainFrame(ctx, untrustedEvent(win)), false, 'embedded frame');
  assert.equal(guards.trustedMainFrame(ctx, trustedEvent(fakeWindow())), false, 'another window');
  assert.equal(guards.trustedMainFrame(ctx, null), false, 'no event');
  assert.equal(guards.trustedMainFrame({ win: null }, trustedEvent(win)), false, 'no window yet');

  win.webContents.mainFrame.url = 'https://example.com/';
  assert.equal(guards.trustedMainFrame(ctx, trustedEvent(win)), false, 'navigated away');
  win.webContents.mainFrame.url = RENDERER_ENTRY_URL;
  win.destroyed = true;
  assert.equal(guards.trustedMainFrame(ctx, trustedEvent(win)), false, 'destroyed window');
});

test('reads ctx.win at call time, so a window created after the guard still counts', () => {
  const ctx = { win: null };
  const win = fakeWindow();
  const event = trustedEvent(win);
  assert.equal(guards.trustedMainFrame(ctx, event), false);
  ctx.win = win;
  assert.equal(guards.trustedMainFrame(ctx, event), true);
});
